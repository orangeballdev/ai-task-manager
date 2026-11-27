import Anthropic from "@anthropic-ai/sdk";
import { assistantRequestOptions, ModelRefusalError } from "../lib/anthropic-reply";
import OpenAI from "openai";
import { spawn } from "child_process";
import type { App, SlackEventMiddlewareArgs } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { prisma } from "./db";
import { getProvider, providerUnavailableMessage } from "../lib/smart-provider";
import {
  modelFitsProvider,
  pickProposalModel,
  pickProposalProvider,
  providerOptionLabel,
  resolveConfiguredModel,
} from "../lib/slack-provider";
import { type ChatMessage, type ProposedTask, normalizeGitUrl, normalizeProposedTask, writeCliCredentials } from "../lib/chat";
import {
  type GitMode,
  type ScheduleMode,
  type SlackFieldValue,
  type SlackProposedTask,
  GIT_MODE_LABELS,
  SCHEDULE_MODE_LABELS,
  addRepo,
  applyFieldValue,
  applyFormState,
  applyGitMode,
  applyScheduleMode,
  blockId,
  decodeBlockId,
  gitModeOf,
  option,
  removeRepo,
  sanitizeProposal,
  scheduleModeOf,
  scheduledForParts,
  summariseProposal,
  textInputBlock,
  threadTsFromBlockId,
  validateProposal,
} from "../lib/slack-proposal";
import { ANTHROPIC_MODELS, OPENAI_MODELS, DEFAULT_ASSISTANT_MODEL, latestVersionsOnly } from "../lib/models";
import { runCodexText } from "../lib/providers/codex-exec";
import { normalizeMaxRuns } from "../lib/max-runs";
import { resolveDefaultPriorityForRepos } from "../lib/repos";
import { normalizePriority } from "../lib/priority";
import { claudeCliText, reportAnthropicUsage, reportOpenAIUsage } from "../lib/llm-usage-context";
import { traceLlmCall } from "../lib/gen-ai-otel";
import { DEFAULT_APP_HOST } from "../lib/app-host";

async function getAppUrl(): Promise<string> {
  const settings = await prisma.setting.findMany();
  const map: Record<string, string> = {};
  for (const s of settings) map[s.key] = s.value;
  const appHost = map.app_host || DEFAULT_APP_HOST;
  return `http://${appHost}`.replace(/\/$/, "");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SayFn = (...args: any[]) => Promise<unknown>;

// Cache of dynamically fetched models — refreshed every 5 minutes.
const _modelCache: Map<string, { models: { id: string; label: string }[]; expiresAt: number }> = new Map();
const MODEL_CACHE_TTL = 5 * 60 * 1000;

async function fetchModelsForProvider(providerId: string, type: string): Promise<{ id: string; label: string }[]> {
  const cacheKey = `${providerId}:${type}`;
  const cached = _modelCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.models;

  try {
    const provider = await prisma.aIProvider.findUnique({ where: { id: providerId } });
    if (provider?.apiKey && type === "api") {
      const client = new Anthropic({ apiKey: provider.apiKey, ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}) });
      // models.list() is a free metadata call — does NOT consume tokens
      const response = await client.models.list({ limit: 100 });
      // Only the newest release of each model family — see src/lib/models.ts.
      const models = latestVersionsOnly(
        response.data
          .filter((m) => m.id.startsWith("claude-"))
          .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
          .map((m) => ({ id: m.id, label: m.display_name || m.id })),
      );
      _modelCache.set(cacheKey, { models, expiresAt: Date.now() + MODEL_CACHE_TTL });
      return models;
    }
    if (provider?.apiKey && type === "openai") {
      const client = new OpenAI({ apiKey: provider.apiKey, ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}) });
      const response = await client.models.list();
      const models = response.data
        .filter((m) => m.id.match(/^(gpt-|o\d)/))
        .sort((a, b) => b.created - a.created)
        .map((m) => {
          const known = OPENAI_MODELS.find((f) => f.id === m.id);
          return known ?? { id: m.id, label: m.id };
        });
      _modelCache.set(cacheKey, { models, expiresAt: Date.now() + MODEL_CACHE_TTL });
      return models;
    }
  } catch {
    // Fall through to static fallback
  }
  return type === "openai" ? OPENAI_MODELS : ANTHROPIC_MODELS;
}

function modelsForType(type: string) {
  return type === "openai" ? OPENAI_MODELS : ANTHROPIC_MODELS;
}

async function getRepoHistory(): Promise<{ url: string; alias: string }[]> {
  return prisma.taskRepo.findMany({
    select: { url: true, alias: true },
    distinct: ["url"],
    orderBy: { id: "desc" },
    take: 20,
  });
}

interface SlackProviderResolution {
  /** The provider to run this Slack turn with — usable right now, or null if nothing is. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  provider: any | null;
  /** Set when `provider` is null but an enabled provider is merely rate-limited. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  throttledFallback: any | null;
}

/**
 * Resolve the provider for a Slack chat turn.
 *
 * The integration config may pin a provider id and a model, but that id can name a provider
 * that has since been disabled, deleted or rate-limited. Rather than failing the whole
 * conversation, resolution goes through `getProvider()` — the same chain the worker uses —
 * so any other enabled provider takes over. The pinned model only survives the substitution
 * when it fits the provider we actually landed on: sending `gpt-*` to an Anthropic
 * connection (or the reverse) would just trade one failure for another.
 */
async function getSlackProvider(): Promise<SlackProviderResolution> {
  let configuredProviderId: string | undefined;
  let configuredModel: string | undefined;

  try {
    const integration = await prisma.integration.findUnique({ where: { id: "slack" } });
    if (integration?.config) {
      const config = JSON.parse(integration.config as string) as { aiProviderId?: string; model?: string };
      configuredProviderId = config.aiProviderId || undefined;
      configuredModel = config.model || undefined;
    }
  } catch (err) {
    console.error("[slack] Failed to read integration config:", err);
  }

  // A configured-but-unusable provider falls through the rest of the chain (smart pick →
  // default → any enabled provider) instead of being used regardless or failing outright.
  const { provider, source, throttledFallback } = await getProvider({ explicitProviderId: configuredProviderId });

  if (!provider) return { provider: null, throttledFallback: throttledFallback ?? null };

  if (configuredProviderId && provider.id !== configuredProviderId) {
    console.warn(
      `[slack] configured provider ${configuredProviderId} is unavailable — falling back to "${provider.name}" (${source}).`,
    );
  }

  return { provider: { ...provider, model: resolveConfiguredModel(configuredModel, provider) }, throttledFallback: null };
}

// --- Slack-specific system prompt ---

const APP_API_REFERENCE = `
## App REST API

Use **call_api** for anything not covered by the specialised tools above.

### Tasks
| Method | Path | Purpose |
|--------|------|---------|
| GET | /api/tasks | List tasks. Returns array with id, title, status, repos, updatedAt. |
| POST | /api/tasks | Create task. Body: {title, description, context?, repos:[{url,alias,branch?}], pushToMain?, targetBranch?, createPR?, scheduledFor?, cronExpression?, maxRuns?, isRecurringTemplate?, aiProviderId?, model?} |
| GET | /api/tasks/:id | Get one task (includes full logs array and repos). |
| PATCH | /api/tasks/:id | Update task fields: status, title, description, context, pushToMain, targetBranch, createPR, aiProviderId, model, isEnabled, retryCount. |
| DELETE | /api/tasks/:id | Delete a task permanently. |
| POST | /api/tasks/:id/kill | Kill a running task immediately. |
| POST | /api/tasks/:id/message | Send a message to the running agent. Body: {content: string} |
| POST | /api/tasks/:id/run-now | Trigger a recurring template to run once right now. |

### Task status values
pending, running, paused, completed, failed, killed

### Providers
| Method | Path | Purpose |
|--------|------|---------|
| GET | /api/providers | List AI providers (id, name, type, isDefault, isEnabled, model). |
`;

function buildSlackSystemPrompt(repoHistory?: { url: string; alias: string }[]): string {
  const repoSection = repoHistory && repoHistory.length > 0
    ? `\n\n## Previously used repositories\n\nIf the task involves one of these, suggest it and use the exact URL — do not ask the user to repeat it.\n\n${repoHistory.map((r) => `- ${r.alias}: ${r.url}`).join("\n")}`
    : "";

  return `You are an assistant for an AI task manager. You help users create tasks and manage existing ones.

## IMPORTANT: Always use tools — never guess

You have NO knowledge of what tasks exist in the system. You MUST call a tool to answer any question about tasks. Never say "there are no tasks" or give a status without calling a tool first.

## What you can do

### Querying tasks
- **list_tasks** — list tasks by status. ALWAYS pass the statuses the user asks about (e.g. \`["completed"]\`, \`["running","pending"]\`, \`["failed"]\`). Never omit statuses — always be explicit.
- **get_task_status** — get status + recent output for a task by name or ID
- **get_task_output** — get full logs for a task by name or ID
- **get_thread_task_status** — get the status of the task created in this thread

### Managing tasks
- **start_task** — re-queue a failed, paused, or completed task
- **call_api** — make any REST call to the app for operations not listed above (kill, delete, send message to agent, etc.)

### Creating tasks
**IMPORTANT:** Always use **propose_task** to create tasks — NEVER use call_api to POST /api/tasks directly. The proposal message is a full configuration form: the user can change the AI provider and model, the schedule (run now / at a specific time / recurring cron), the repos and their branches, what happens to the changes (new branch, existing branch, push to main, open a PR) and the context — all before clicking "Create Task".
- **propose_task** — propose a new task. Gather title and description. Only ask about repos and branch settings if the task involves making changes to a codebase — many tasks don't need a repo at all. Ask one or two focused questions at a time. Once you have enough detail, call propose_task.

Don't interrogate the user about every setting: fill in what they've told you and let them adjust the rest in the proposal form. Anything you pass to propose_task simply pre-fills that form.

Many tasks have nothing to do with code (research, analysis, writing, data processing, etc.) — do not ask about repos or git output unless the task clearly involves modifying a codebase.
For repos: clone URLs must end in .git. Append .git if missing.
For scheduling: ISO datetime for one-time, 5-field cron for recurring.${repoSection}

${APP_API_REFERENCE}

Keep responses concise. Use Slack formatting: *bold*, \`code\`, newlines.`;
}

// --- Tool definitions ---

const PROPOSE_TASK_SCHEMA = {
  name: "propose_task",
  description: "Propose a new task for the AI agent to execute. Call this once you have gathered enough details. IMPORTANT: This shows an approval message with 'Create Task' and 'Cancel' buttons. The task is NOT created until the user clicks 'Create Task'. Use this for ALL task creation — never use call_api to POST /api/tasks directly.",
  input_schema: {
    type: "object" as const,
    properties: {
      title: { type: "string", description: "Short descriptive title" },
      description: { type: "string", description: "Detailed instructions for the AI agent" },
      context: { type: "string", description: "Additional context or constraints (optional)" },
      repos: {
        type: "array",
        description: "Repositories the agent needs (optional)",
        items: {
          type: "object",
          properties: {
            url: { type: "string", description: "Git clone URL ending in .git" },
            branch: { type: "string", description: "Branch to check out (omit for default)" },
          },
          required: ["url"],
        },
      },
      targetBranch: { type: "string", description: "Push changes to this existing branch (optional)" },
      pushToMain: { type: "boolean", description: "Push directly to main/master (optional)" },
      createPR: { type: "boolean", description: "Open a pull request after the agent finishes (optional)" },
      scheduledFor: { type: "string", description: "ISO datetime for one-time scheduling (optional)" },
      isRecurring: { type: "boolean", description: "Whether this is a recurring task" },
      cronExpression: { type: "string", description: "Cron expression for recurring tasks (optional)" },
      maxRuns: { type: "integer", description: "Maximum number of times a recurring task runs before stopping. Omit for unlimited (the default)." },
    },
    required: ["title", "description"],
  },
};

const LIST_TASKS_SCHEMA = {
  name: "list_tasks",
  description: "List tasks filtered by status. Always pass the statuses you want — e.g. ['completed'] for completed tasks, ['pending','running','paused'] for active tasks, or combine multiple.",
  input_schema: {
    type: "object" as const,
    properties: {
      statuses: {
        type: "array",
        items: { type: "string", enum: ["pending", "running", "paused", "completed", "failed", "killed"] },
        description: "Required. The statuses to filter by. Use ['completed'] for completed tasks, ['pending','running','paused'] for active tasks.",
      },
    },
    required: ["statuses"],
  },
};

const GET_TASK_STATUS_SCHEMA = {
  name: "get_task_status",
  description: "Get the status and recent output of a task by name (partial match) or ID.",
  input_schema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "Task name (partial match) or task ID" },
    },
    required: ["query"],
  },
};

const GET_TASK_OUTPUT_SCHEMA = {
  name: "get_task_output",
  description: "Get the full output logs of a task by name (partial match) or ID.",
  input_schema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "Task name (partial match) or task ID" },
    },
    required: ["query"],
  },
};

const GET_THREAD_TASK_STATUS_SCHEMA = {
  name: "get_thread_task_status",
  description: "Get the status and output of the task created in this conversation thread.",
  input_schema: { type: "object" as const, properties: {} },
};

const START_TASK_SCHEMA = {
  name: "start_task",
  description: "Queue a task to run by setting it back to pending. Works on failed, paused, or completed tasks.",
  input_schema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "Task name (partial match) or task ID" },
    },
    required: ["query"],
  },
};

const CALL_API_SCHEMA = {
  name: "call_api",
  description: "Make an HTTP request to the app's REST API. Use this for operations not covered by other tools (e.g. kill a task, send a message to a running task, create a task directly, delete a task, etc). See the API reference in the system prompt for available endpoints.",
  input_schema: {
    type: "object" as const,
    properties: {
      method: { type: "string", enum: ["GET", "POST", "PATCH", "DELETE"], description: "HTTP method" },
      path: { type: "string", description: "API path, e.g. /api/tasks or /api/tasks/abc123/kill" },
      body: { type: "object", description: "Request body for POST/PATCH requests (optional)" },
    },
    required: ["method", "path"],
  },
};

// cache_control on the last tool caches all tools + the system prompt together,
// giving ~90% discount on those tokens for repeated requests in the same conversation.
const SLACK_TOOLS_ANTHROPIC: Anthropic.Tool[] = [
  PROPOSE_TASK_SCHEMA,
  LIST_TASKS_SCHEMA,
  GET_TASK_STATUS_SCHEMA,
  GET_TASK_OUTPUT_SCHEMA,
  GET_THREAD_TASK_STATUS_SCHEMA,
  START_TASK_SCHEMA,
  { ...CALL_API_SCHEMA, cache_control: { type: "ephemeral" } },
];

const SLACK_TOOLS_OPENAI: OpenAI.ChatCompletionTool[] = [
  { type: "function", function: { name: PROPOSE_TASK_SCHEMA.name, description: PROPOSE_TASK_SCHEMA.description, parameters: PROPOSE_TASK_SCHEMA.input_schema } },
  { type: "function", function: { name: LIST_TASKS_SCHEMA.name, description: LIST_TASKS_SCHEMA.description, parameters: LIST_TASKS_SCHEMA.input_schema } },
  { type: "function", function: { name: GET_TASK_STATUS_SCHEMA.name, description: GET_TASK_STATUS_SCHEMA.description, parameters: GET_TASK_STATUS_SCHEMA.input_schema } },
  { type: "function", function: { name: GET_TASK_OUTPUT_SCHEMA.name, description: GET_TASK_OUTPUT_SCHEMA.description, parameters: GET_TASK_OUTPUT_SCHEMA.input_schema } },
  { type: "function", function: { name: GET_THREAD_TASK_STATUS_SCHEMA.name, description: GET_THREAD_TASK_STATUS_SCHEMA.description, parameters: GET_THREAD_TASK_STATUS_SCHEMA.input_schema } },
  { type: "function", function: { name: START_TASK_SCHEMA.name, description: START_TASK_SCHEMA.description, parameters: START_TASK_SCHEMA.input_schema } },
  { type: "function", function: { name: CALL_API_SCHEMA.name, description: CALL_API_SCHEMA.description, parameters: CALL_API_SCHEMA.input_schema } },
];

// --- Tool execution (direct DB access) ---

async function executeTool(name: string, input: Record<string, unknown>, threadTs: string): Promise<string> {
  const appUrl = await getAppUrl();
  if (name === "propose_task") {
    // Captured by caller; just confirm so the model can write a reply
    return "Task proposal captured. Presenting to user for approval.";
  }

  if (name === "list_tasks") {
    const statuses = (input.statuses as string[] | undefined) ?? ["pending", "running", "paused", "completed", "failed", "killed"];
    const tasks = await prisma.task.findMany({
      where: { status: { in: statuses }, isRecurringTemplate: false },
      orderBy: { updatedAt: "desc" },
      take: 20,
      select: { id: true, title: true, status: true, updatedAt: true },
    });
    if (!tasks.length) return `No ${statuses.join("/")} tasks found.`;
    return tasks
      .map((t: { id: string; title: string; status: string }) => `- *${t.title}* [${t.status}] (id: \`${t.id}\`): ${appUrl}/tasks/${t.id}`)
      .join("\n");
  }

  if (name === "get_task_status" || name === "get_task_output") {
    const query = input.query as string;
    const logLimit = name === "get_task_output" ? 100 : 5;
    const tasks = await prisma.task.findMany({
      where: {
        OR: [{ id: query }, { title: { contains: query } }],
        isRecurringTemplate: false,
      },
      include: {
        logs: { where: { level: "info" }, orderBy: { createdAt: "asc" }, take: logLimit },
      },
      orderBy: { updatedAt: "desc" },
      take: 3,
    });
    if (!tasks.length) return `No task found matching "${query}".`;
    return tasks
      .map((task: { id: string; title: string; status: string; logs: { content: string }[] }) => {
        const output = task.logs.map((l: { content: string }) => l.content.trim()).filter(Boolean).join("\n\n");
        return [
          `*${task.title}*: \`${task.status}\``,
          `ID: \`${task.id}\``,
          `URL: ${appUrl}/tasks/${task.id}`,
          output ? `\nOutput:\n${truncateForSlack(output, 1500)}` : "\nNo output yet.",
        ].join("\n");
      })
      .join("\n\n---\n\n");
  }

  if (name === "get_thread_task_status") {
    const conv = await prisma.slackConversation.findUnique({ where: { threadTs } });
    if (!conv?.taskId) {
      if (conv?.proposed) {
        const pending = JSON.parse(conv.proposed as string) as Record<string, unknown>;
        return `No task has been created yet: there is a task proposal PENDING USER APPROVAL (the user has not clicked "Create Task" yet):\n- Title: ${pending.title}\n- Description: ${pending.description}\nThe task does not exist in the system until the user approves it.`;
      }
      return "No task has been created in this conversation yet.";
    }
    const task = await prisma.task.findUnique({
      where: { id: conv.taskId },
      include: { logs: { where: { level: "info" }, orderBy: { createdAt: "asc" }, take: 50 } },
    });
    if (!task) return "Task not found.";
    const output = (task.logs as { content: string }[]).map((l) => l.content.trim()).filter(Boolean).join("\n\n");
    return [
      `*${task.title}*: \`${task.status}\``,
      `URL: ${appUrl}/tasks/${task.id}`,
      output ? `\nOutput:\n${truncateForSlack(output, 2000)}` : "\nNo output yet.",
    ].join("\n");
  }

  if (name === "call_api") {
    const method = (input.method as string) ?? "GET";
    const path = input.path as string;
    const body = input.body as Record<string, unknown> | undefined;
    const url = `${appUrl}${path}`;
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { parsed = text; }
      // Truncate large responses so they fit in the tool result
      const json = JSON.stringify(parsed, null, 2);
      return `HTTP ${res.status}\n${json.length > 3000 ? json.slice(0, 3000) + "\n…(truncated)" : json}`;
    } catch (err) {
      return `Request failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (name === "start_task") {
    const query = input.query as string;
    const task = await prisma.task.findFirst({
      where: {
        OR: [{ id: query }, { title: { contains: query } }],
        isRecurringTemplate: false,
      },
      orderBy: { updatedAt: "desc" },
    });
    if (!task) return `No task found matching "${query}".`;
    if ((task as { reviewOnly?: boolean }).reviewOnly) return `Task *${(task as { title: string }).title}* is a review-only ticket — it never runs an agent.`;
    if ((task as { status: string }).status === "running") return `Task *${(task as { title: string }).title}* is already running.`;
    if ((task as { status: string }).status === "pending") return `Task *${(task as { title: string }).title}* is already queued.`;

    await prisma.task.update({
      where: { id: (task as { id: string }).id },
      data: { status: "pending", retryCount: 0, nextRetryAt: null },
    });
    return `Task *${(task as { title: string }).title}* has been queued. The worker will pick it up shortly.\nURL: ${appUrl}/tasks/${(task as { id: string }).id}`;
  }

  return `Unknown tool: ${name}`;
}

// --- AI runners with tool-use loops ---

// How many messages (user+assistant pairs) to send to the API. Older history is
// preserved in the DB but trimmed here to limit input token cost.
const MAX_HISTORY_MESSAGES = 10;

function trimHistory(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= MAX_HISTORY_MESSAGES) return messages;
  return messages.slice(messages.length - MAX_HISTORY_MESSAGES);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runSlackWithApi(messages: ChatMessage[], provider: any, threadTs: string, repoHistory?: { url: string; alias: string }[]): Promise<{ reply: string; proposedTask?: ProposedTask }> {
  const apiKey = provider.apiKey;
  if (!apiKey) throw new Error(`No API key configured for provider "${provider.name}". Add one in Settings → AI.`);
  const client = new Anthropic({ apiKey, ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}) });
  const systemPrompt = buildSlackSystemPrompt(repoHistory);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apiMessages: any[] = trimHistory(messages).map((m) => ({ role: m.role, content: m.content }));
  let proposedTask: ProposedTask | undefined;
  let finalReply = "";

  for (let i = 0; i < 10; i++) {
    const response = await client.messages.create({
      model: provider.model ?? DEFAULT_ASSISTANT_MODEL,
      ...assistantRequestOptions(provider.model ?? DEFAULT_ASSISTANT_MODEL, 1024, "medium"),
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      tools: SLACK_TOOLS_ANTHROPIC,
      messages: apiMessages,
    });
    reportAnthropicUsage(response);

    if (response.stop_reason === "refusal") throw new ModelRefusalError();

    // Collect text and tool uses
    const toolUses: Anthropic.ToolUseBlock[] = [];
    for (const block of response.content) {
      if (block.type === "text") finalReply = block.text;
      if (block.type === "tool_use") {
        console.log(`[slack] tool_use: ${block.name}`, JSON.stringify(block.input));
        if (block.name === "propose_task") {
          proposedTask = normalizeProposedTask(block.input as Record<string, unknown>);
        }
        toolUses.push(block);
      }
    }

    console.log(`[slack] stop_reason=${response.stop_reason} toolUses=${toolUses.length} text=${finalReply.slice(0, 80)}`);

    if (toolUses.length === 0) break;

    // Add assistant turn and execute tools
    apiMessages.push({ role: "assistant", content: response.content });
    const results = await Promise.all(
      toolUses.map(async (tu) => {
        const content = await executeTool(tu.name, tu.input as Record<string, unknown>, threadTs);
        console.log(`[slack] tool_result for ${tu.name}:`, content.slice(0, 200));
        return { type: "tool_result" as const, tool_use_id: tu.id, content };
      })
    );
    apiMessages.push({ role: "user", content: results });

    // If the model signalled done alongside tool calls, exit after processing them
    if (response.stop_reason === "end_turn") break;
  }

  if (!finalReply && proposedTask) finalReply = "I've put together a task based on our conversation. Take a look and create it when you're ready!";
  return { reply: finalReply, proposedTask };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runSlackWithOpenAI(messages: ChatMessage[], provider: any, threadTs: string, repoHistory?: { url: string; alias: string }[]): Promise<{ reply: string; proposedTask?: ProposedTask }> {
  const apiKey = provider.apiKey;
  if (!apiKey) throw new Error(`No API key configured for provider "${provider.name}". Add one in Settings → AI.`);
  const client = new OpenAI({ apiKey, ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}) });
  const systemPrompt = buildSlackSystemPrompt(repoHistory);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apiMessages: any[] = [
    { role: "system", content: systemPrompt },
    ...trimHistory(messages).map((m) => ({ role: m.role, content: m.content })),
  ];
  let proposedTask: ProposedTask | undefined;
  let finalReply = "";

  for (let i = 0; i < 10; i++) {
    const response = await client.chat.completions.create({
      model: provider.model ?? "gpt-4o",
      max_tokens: 1024,
      tools: SLACK_TOOLS_OPENAI,
      messages: apiMessages,
    });
    reportOpenAIUsage(response);

    const choice = response.choices[0];
    if (choice.message.content) finalReply = choice.message.content;

    const toolCalls = choice.message.tool_calls ?? [];
    if (!toolCalls.length) break;

    // Parse proposed tasks
    for (const call of toolCalls) {
      if (call.type === "function" && call.function.name === "propose_task") {
        try {
          proposedTask = normalizeProposedTask(JSON.parse(call.function.arguments) as Record<string, unknown>);
        } catch { /* ignore */ }
      }
    }

    // Add assistant turn
    apiMessages.push(choice.message);

    // Execute tools and add results
    for (const call of toolCalls) {
      if (call.type !== "function") continue;
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.function.arguments); } catch { /* empty */ }
      const result = await executeTool(call.function.name, args, threadTs);
      apiMessages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }

  if (!finalReply && proposedTask) finalReply = "I've put together a task based on our conversation. Take a look and create it when you're ready!";
  return { reply: finalReply, proposedTask };
}

const CLI_SLACK_TOOL_INSTRUCTIONS = `
## Tool calling

When you need to query or manage tasks, call a tool by outputting ONLY a <tool_call> block, and nothing else — no preamble, no other text before or after it:

<tool_call>{"name": "TOOL_NAME", "input": TOOL_INPUT_JSON}</tool_call>

STOP generating immediately after the closing </tool_call> tag. Tools are executed by the surrounding system, not by you — you have no way to know the result yet, so do NOT write a <tool_result> block yourself, and do NOT continue the conversation or guess what the result will be. The real <tool_result> will be given to you in the next turn; only then should you write your reply. Never answer questions about tasks without calling a tool first.

### Available tools

list_tasks       Input: {"statuses": ["completed"]} — always pass the statuses explicitly
get_task_status  Input: {"query": "name or ID"}
get_task_output  Input: {"query": "name or ID"}
get_thread_task_status  Input: {}
start_task       Input: {"query": "name or ID"}
call_api         Input: {"method": "GET|POST|PATCH|DELETE", "path": "/api/...", "body": {...}}
propose_task     Input: {"title": "...", "description": "...", "repos": [...], ...}
`;

// Hard cap on how long the Claude CLI may run for a single Slack turn. Without
// this a hung CLI process leaves the Slack placeholder stuck on "Thinking…"
// forever, since the spawn promise never settles.
const CLI_TIMEOUT_MS = 120_000;

function spawnCli(prompt: string, provider: { type?: string; configDir?: string; credentialsJson?: string; model?: string }): Promise<string> {
  // Codex is a CLI too, but a different binary with a different flag set and its own auth
  // file — route it to the shared Codex helper instead of spawning `claude` against a
  // config dir that has no Claude credentials in it.
  if (provider.type === "codex-cli") {
    return runCodexText(prompt, {
      configDir: provider.configDir,
      credentialsJson: provider.credentialsJson,
      model: provider.model,
      timeoutMs: CLI_TIMEOUT_MS,
    });
  }
  if (provider.configDir && provider.credentialsJson) {
    writeCliCredentials(provider.configDir, provider.credentialsJson);
  }
  return new Promise((resolve, reject) => {
    // Disable built-in tools to prevent bypassing the propose_task approval flow
    const args = ["-p", prompt, "--output-format", "json", "--tools", "", "--dangerously-skip-permissions"];
    if (provider.model) args.push("--model", provider.model);
    const child = spawn("claude", args, {
      cwd: "/tmp",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: undefined,
        PATH: [process.env.PATH ?? "", process.env.CLAUDE_PATH].filter(Boolean).join(":"),
        ...(provider.configDir ? { CLAUDE_CONFIG_DIR: provider.configDir } : {}),
      },
    });
    let output = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`Claude CLI timed out after ${Math.round(CLI_TIMEOUT_MS / 1000)}s with no response.`));
    }, CLI_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => { output += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("close", (code) => {
      // --output-format json: back to the reply text, recording the run's token usage.
      output = claudeCliText(output);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const detail = stderr.trim() || output.trim();
        reject(new Error(detail ? `Claude CLI exited with code ${code}: ${detail}` : `Claude CLI exited with code ${code}. Make sure it is installed and you are logged in.`));
      } else {
        resolve(output);
      }
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(err.code === "ENOENT"
        ? "Claude CLI not found. Install it and make sure it is on your PATH."
        : `Failed to start Claude CLI: ${err.message}`));
    });
  });
}

// The CLI is invoked with `--tools ""` and no real mid-generation stop, so a single
// completion can run past the `<tool_call>` tag and hallucinate a fake `<tool_result>`
// plus a made-up final answer in the same response (the model has no way to know it's
// supposed to pause there). If that hallucinated tail were stored in the conversation
// history, the next turn would see both a fabricated and a real `<tool_result>` for the
// same call, which reliably produces garbled output — including stray, unrendered
// `<tool_call>`/`<tool_result>` tags leaking straight into the Slack message, and the
// model losing the thread on `propose_task` so no task ever gets proposed. Strip
// anything at/after the matched tag before persisting, and scrub any tags that still
// slip through a finalReply as a last-resort safety net.
function stripToolProtocolArtifacts(text: string): string {
  return text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .replace(/<tool_result>[\s\S]*?<\/tool_result>/g, "")
    // Unterminated tags (truncated output, or the model never closing one)
    .replace(/<\/?tool_(call|result)>[\s\S]*$/g, "")
    .trim();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runSlackWithCli(messages: ChatMessage[], provider: any, threadTs: string, repoHistory?: { url: string; alias: string }[]): Promise<{ reply: string; proposedTask?: ProposedTask }> {
  const systemPrompt = buildSlackSystemPrompt(repoHistory);
  const internalMessages = trimHistory(messages).map((m) => ({ role: m.role, content: m.content }));
  let proposedTask: ProposedTask | undefined;
  let finalReply = "";

  for (let i = 0; i < 10; i++) {
    const conversationText = internalMessages
      .map((m) => `${m.role === "user" ? "Human" : "Assistant"}: ${m.content}`)
      .join("\n\n");
    const fullPrompt = `${systemPrompt}\n${CLI_SLACK_TOOL_INSTRUCTIONS}\n\nConversation:\n${conversationText}\n\nAssistant:`;

    const response = await spawnCli(fullPrompt, provider);
    console.log(`[slack/cli] response (iter ${i}):`, response.slice(0, 120));

    const toolCallMatch = response.match(/<tool_call>([\s\S]*?)<\/tool_call>/);
    if (!toolCallMatch) {
      finalReply = stripToolProtocolArtifacts(response);
      break;
    }

    let toolCall: { name: string; input: Record<string, unknown> };
    try {
      toolCall = JSON.parse(toolCallMatch[1].trim());
    } catch {
      finalReply = stripToolProtocolArtifacts(response);
      break;
    }

    console.log(`[slack/cli] tool_call: ${toolCall.name}`, JSON.stringify(toolCall.input));
    if (toolCall.name === "propose_task") {
      proposedTask = normalizeProposedTask(toolCall.input);
    }

    const toolResult = await executeTool(toolCall.name, toolCall.input, threadTs);
    console.log(`[slack/cli] tool_result for ${toolCall.name}:`, toolResult.slice(0, 200));

    // Only persist the real tool call — everything the model generated after it
    // (a hallucinated <tool_result>, a guessed answer, etc.) is discarded so it
    // never contaminates history for the next iteration.
    const realTurn = response.slice(0, (toolCallMatch.index ?? 0) + toolCallMatch[0].length).trim();
    internalMessages.push({ role: "assistant", content: realTurn });
    internalMessages.push({ role: "user", content: `<tool_result>\n${toolResult}\n</tool_result>\n\nPlease reply to the user based on this result.` });
  }

  if (!finalReply && proposedTask) finalReply = "I've put together a task based on our conversation. Take a look and create it when you're ready!";
  finalReply = stripToolProtocolArtifacts(finalReply);
  // Stripping can leave nothing (e.g. the whole response was a malformed/unparseable
  // tool-call block) — never hand Slack an empty message.
  if (!finalReply) finalReply = "Sorry, I ran into trouble putting that response together. Could you try rephrasing?";
  return { reply: finalReply, proposedTask };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runSlackChat(messages: ChatMessage[], provider: any, threadTs: string, repoHistory?: { url: string; alias: string }[]): Promise<{ reply: string; proposedTask?: ProposedTask }> {
  if (provider.type === "api") return runSlackWithApi(messages, provider, threadTs, repoHistory);
  if (provider.type === "openai") return runSlackWithOpenAI(messages, provider, threadTs, repoHistory);
  return runSlackWithCli(messages, provider, threadTs, repoHistory);
}

// --- Conversation helpers ---

async function getOrCreateConversation(threadTs: string, channelId: string) {
  const existing = await prisma.slackConversation.findUnique({ where: { threadTs } });
  if (existing) return existing;
  return prisma.slackConversation.create({
    data: { threadTs, channelId, messages: "[]" },
  });
}

// --- Proposal form: rendering ---

/**
 * Write a corrected provider/model back onto the stored proposal.
 *
 * `SlackConversation.proposed` is the single source of truth the "Create Task" button reads,
 * so whenever rendering has to substitute a provider (the pinned one was disabled, deleted,
 * or the model belongs to another vendor) the stored copy has to learn about it too —
 * otherwise the form shows one provider and the created task gets another.
 */
async function syncProposalProvider(
  threadTs: string,
  proposed: SlackProposedTask,
  providerId: string | null,
  model: string,
): Promise<void> {
  const nextProviderId = providerId ?? undefined;
  const nextModel = model || undefined;
  if (proposed.providerId === nextProviderId && proposed.model === nextModel) return;

  proposed.providerId = nextProviderId;
  proposed.model = nextModel;

  try {
    // updateMany, not update: the conversation row may have been cleared (task created or
    // proposal cancelled) between rendering and this write, and that shouldn't throw.
    await prisma.slackConversation.updateMany({
      where: { threadTs, proposed: { not: null } },
      data: { proposed: JSON.stringify(proposed) },
    });
  } catch (err) {
    console.error("[slack] failed to persist provider selection on proposal:", err);
  }
}

/** Render the whole proposal form: summary, provider/model, schedule, repos, git, context. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildProposalBlocks(reply: string, proposed: SlackProposedTask, threadTs: string): Promise<any[]> {
  // Only enabled connections are offered — a disabled provider must never end up on a task.
  const providers: { id: string; name: string; type: string; isDefault: boolean; isEnabled: boolean; throttledUntil: Date | null }[] =
    await prisma.aIProvider.findMany({ where: { isEnabled: true }, orderBy: { createdAt: "asc" } });

  // The stored proposal can name a provider that's since been disabled or deleted (the model
  // may even have proposed one that never existed). Fall back to the best available provider
  // rather than rendering a menu whose initial_option Slack would reject.
  const { provider: selectedProvider, fellBack } = pickProposalProvider(providers, proposed.providerId);

  const models = selectedProvider
    ? await fetchModelsForProvider(selectedProvider.id, selectedProvider.type)
    : modelsForType("api");
  const selectedModelId = pickProposalModel(proposed.model, models, selectedProvider?.type);

  // The "Create Task" button reads the stored proposal, so write the substitution back:
  // what the form shows and what the task gets must never disagree.
  await syncProposalProvider(threadTs, proposed, selectedProvider?.id ?? null, selectedModelId);
  // Slack rejects an initial_option that isn't in the option list, so an unknown model
  // (e.g. one pinned in the integration config that the provider no longer lists) just
  // leaves the menu on its placeholder.
  const selectedModel = models.find((m) => m.id === selectedModelId);
  const selectedModelLabel = selectedModel?.label ?? selectedModelId;

  const scheduleMode = scheduleModeOf(proposed);
  const gitMode = gitModeOf(proposed);
  const repos = proposed.repos ?? [];

  const providerLabel = selectedProvider
    ? `${selectedProvider.name}${selectedModelLabel ? ` · ${selectedModelLabel}` : ""}`
    : undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks: any[] = [
    { type: "section", text: { type: "mrkdwn", text: reply || "Here's the task I'd create:" } },
    { type: "section", text: { type: "mrkdwn", text: summariseProposal(proposed, providerLabel) } },
  ];

  if (selectedProvider) {
    blocks.push({ type: "divider" });
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "*Run this task with:*" } });
    if (fellBack) {
      blocks.push({
        type: "context",
        elements: [{
          type: "mrkdwn",
          text: `:information_source: The provider originally picked isn't available, so *${selectedProvider.name}* is selected instead. Change it below if you'd rather use another one.`,
        }],
      });
    }
    blocks.push({
      type: "actions",
      block_id: blockId("cfg", threadTs),
      elements: [
        {
          type: "static_select",
          action_id: "select_task_provider",
          placeholder: { type: "plain_text", text: "Provider" },
          initial_option: option(providerOptionLabel(selectedProvider), selectedProvider.id),
          options: providers.map((p) => option(providerOptionLabel(p), p.id)),
        },
        ...(models.length
          ? [{
              type: "static_select",
              action_id: "select_task_model",
              placeholder: { type: "plain_text", text: "Model" },
              ...(selectedModel ? { initial_option: option(selectedModel.label, selectedModel.id) } : {}),
              options: models.map((m) => option(m.label, m.id)),
            }]
          : []),
      ],
    });
  } else {
    // Nothing enabled to choose from. The task can still be created — the worker resolves a
    // provider again when it picks the task up — so say that rather than hiding the section.
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: ":warning: *No AI provider is enabled.* You can still create this task — it will use whichever provider is enabled by the time it runs. Enable one in Settings → AI.",
      },
    });
  }

  // --- Scheduling ---
  blocks.push({ type: "divider" });
  blocks.push({ type: "section", text: { type: "mrkdwn", text: "*When should it run?*" } });
  blocks.push({
    type: "actions",
    block_id: blockId("sched", threadTs),
    elements: [
      {
        type: "static_select",
        action_id: "select_schedule_mode",
        placeholder: { type: "plain_text", text: "Schedule" },
        initial_option: option(SCHEDULE_MODE_LABELS[scheduleMode], scheduleMode),
        options: (Object.keys(SCHEDULE_MODE_LABELS) as ScheduleMode[]).map((m) => option(SCHEDULE_MODE_LABELS[m], m)),
      },
      ...(scheduleMode === "scheduled"
        ? (() => {
            const parts = scheduledForParts(proposed.scheduledFor);
            return [
              {
                type: "datepicker",
                action_id: "pick_schedule_date",
                initial_date: parts.date,
                placeholder: { type: "plain_text", text: "Date" },
              },
              {
                type: "timepicker",
                action_id: "pick_schedule_time",
                initial_time: parts.time,
                placeholder: { type: "plain_text", text: "Time" },
              },
            ];
          })()
        : []),
    ],
  });

  if (scheduleMode === "recurring") {
    blocks.push(textInputBlock({
      id: blockId("cron", threadTs),
      actionId: "input_cron",
      label: "Cron expression",
      placeholder: "0 9 * * 1-5",
      initial: proposed.cronExpression,
      hint: "5 fields: minute hour day month weekday. Press Enter to save.",
    }));
    blocks.push(textInputBlock({
      id: blockId("maxruns", threadTs),
      actionId: "input_max_runs",
      label: "Max runs",
      placeholder: "unlimited",
      initial: proposed.maxRuns ? String(proposed.maxRuns) : undefined,
      hint: "Leave blank to run forever.",
    }));
  }

  // --- Repos ---
  blocks.push({ type: "divider" });
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: repos.length ? "*Repositories*" : "*Repositories* — none (the agent won't clone anything)" },
  });

  repos.forEach((repo, i) => {
    blocks.push({
      type: "section",
      block_id: blockId("repo", threadTs, i),
      text: { type: "mrkdwn", text: `\`${repo.url}\`` },
      accessory: {
        type: "button",
        action_id: "remove_repo",
        text: { type: "plain_text", text: "Remove" },
        style: "danger",
        value: String(i),
      },
    });
    blocks.push(textInputBlock({
      id: blockId("repobranch", threadTs, i),
      actionId: "input_repo_branch",
      label: `Branch for ${repo.url.split("/").pop()?.replace(/\.git$/, "") || "repo"}`,
      placeholder: "default branch",
      initial: repo.branch,
    }));
  });

  blocks.push(textInputBlock({
    id: blockId("newrepo", threadTs),
    actionId: "input_new_repo",
    label: "Add a repository",
    placeholder: "git@github.com:org/repo.git",
    initial: proposed.newRepoUrl,
    hint: "Press Enter to add it.",
  }));

  const history = await getRepoHistory();
  const suggestions = history.filter((h) => !repos.some((r) => r.url === normalizeGitUrl(h.url))).slice(0, 20);
  if (suggestions.length) {
    blocks.push({
      type: "actions",
      block_id: blockId("repopick", threadTs),
      elements: [
        {
          type: "static_select",
          action_id: "select_known_repo",
          placeholder: { type: "plain_text", text: "Add a previously used repo" },
          options: suggestions.map((h) => option(h.alias || h.url, h.url)),
        },
      ],
    });
  }

  // --- Git output (only meaningful when the agent has a repo to push to) ---
  if (repos.length) {
    blocks.push({ type: "divider" });
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "*What to do with the changes*" } });
    blocks.push({
      type: "actions",
      block_id: blockId("git", threadTs),
      elements: [
        {
          type: "static_select",
          action_id: "select_git_mode",
          placeholder: { type: "plain_text", text: "Git output" },
          initial_option: option(GIT_MODE_LABELS[gitMode], gitMode),
          options: (Object.keys(GIT_MODE_LABELS) as GitMode[]).map((m) => option(GIT_MODE_LABELS[m], m)),
        },
      ],
    });
    if (gitMode === "target") {
      blocks.push(textInputBlock({
        id: blockId("targetbranch", threadTs),
        actionId: "input_target_branch",
        label: "Target branch",
        placeholder: "develop",
        initial: proposed.targetBranch,
        hint: "Press Enter to save.",
      }));
    }
  }

  // --- Context ---
  blocks.push({ type: "divider" });
  blocks.push(textInputBlock({
    id: blockId("context", threadTs),
    actionId: "input_context",
    label: "Context",
    placeholder: "Extra instructions, constraints, links…",
    initial: proposed.context,
    multiline: true,
    // Enter is a newline here — the text is read from the message state on Create Task.
    dispatch: false,
    hint: "Saved when you click Create Task.",
  }));

  blocks.push({
    type: "actions",
    block_id: blockId("approval", threadTs),
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Create Task" },
        action_id: "approve_task",
        style: "primary",
        value: threadTs,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Cancel" },
        action_id: "cancel_task",
        style: "danger",
        value: threadTs,
      },
    ],
  });

  return blocks;
}

/**
 * Load the pending proposal for a thread, fold in the message's current input values and
 * hand it to `mutate`. Returns null when there is nothing pending (e.g. the task was
 * already created, or the proposal was cancelled) so callers can bail out quietly.
 */
async function updateProposal(
  threadTs: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: any,
  mutate?: (proposed: SlackProposedTask) => void | Promise<void>,
): Promise<SlackProposedTask | null> {
  const conv = await prisma.slackConversation.findUnique({ where: { threadTs } });
  if (!conv?.proposed) return null;

  const proposed: SlackProposedTask = JSON.parse(conv.proposed as string);
  applyFormState(proposed, state);
  if (mutate) await mutate(proposed);

  await prisma.slackConversation.update({ where: { threadTs }, data: { proposed: JSON.stringify(proposed) } });
  return proposed;
}

/** Re-render the proposal message in place, keeping the assistant's original reply text. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function rerenderProposal(body: any, client: any, threadTs: string, proposed: SlackProposedTask) {
  const channel: string = body.container?.channel_id ?? body.channel?.id;
  const messageTs: string = body.container?.message_ts;
  if (!channel || !messageTs) return;
  const reply: string = body.message?.blocks?.[0]?.text?.text ?? "";
  const blocks = await buildProposalBlocks(reply, proposed, threadTs);
  await client.chat.update({ channel, ts: messageTs, blocks, text: reply || "Task proposal" });
}

/** Swap the interactive proposal message for a plain, read-only summary. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function replaceProposalMessage(body: any, client: any, text: string) {
  const channel: string = body?.container?.channel_id ?? body?.channel?.id;
  const messageTs: string = body?.container?.message_ts;
  if (!channel || !messageTs) return;
  try {
    await client.chat.update({
      channel,
      ts: messageTs,
      text,
      blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
    });
  } catch (err) {
    console.error("[slack] failed to collapse proposal message:", err);
  }
}

const STATUS_TRIGGERS = /^\s*(status|update|progress|what's happening|how's it going|done yet|any updates?)\??\s*$/i;

async function handleStatusRequest(threadTs: string, conv: { taskId: string | null }, say: SayFn) {
  if (!conv.taskId) {
    await say({ text: "No task has been created in this conversation yet.", thread_ts: threadTs });
    return;
  }

  const task = await prisma.task.findUnique({
    where: { id: conv.taskId },
    include: { logs: { where: { level: "info" }, orderBy: { createdAt: "desc" }, take: 3 } },
  });

  if (!task) {
    await say({ text: "Couldn't find the task.", thread_ts: threadTs });
    return;
  }

  const statusEmoji: Record<string, string> = {
    pending: ":hourglass_flowing_sand:",
    running: ":gear:",
    completed: ":white_check_mark:",
    no_changes: ":information_source:",
    failed: ":x:",
    paused: ":pause_button:",
  };

  const emoji = statusEmoji[task.status] ?? ":question:";
  const recentLogs: { content: string }[] = task.logs ?? [];
  const lastOutput = recentLogs
    .map((l: { content: string }) => l.content.trim())
    .filter(Boolean)
    .reverse()
    .join("\n\n");

  const lines = [`${emoji} *${task.title}*: \`${task.status}\``];
  if (lastOutput) lines.push(`\n*Latest output:*\n${truncateForSlack(lastOutput, 800)}`);
  if (task.status === "completed" || task.status === "no_changes" || task.status === "failed") {
    const appUrl = await getAppUrl();
    lines.push(`\n<${appUrl}/tasks/${task.id}|View full task →>`);
  }

  await say({ text: lines.join("\n"), thread_ts: threadTs });
}

async function handleMessage(threadTs: string, channelId: string, text: string, say: SayFn, client: WebClient) {
  // In DMs, threadTs is the channel ID (not a real timestamp) — don't pass it as thread_ts
  const isDM = threadTs === channelId;
  const replyOpts = (extra?: Record<string, unknown>) =>
    isDM ? { ...extra } : { thread_ts: threadTs, ...extra };

  const conv = await getOrCreateConversation(threadTs, channelId);

  // Short-circuit: handle simple status queries without an AI call
  if (STATUS_TRIGGERS.test(text) && conv.taskId) {
    await handleStatusRequest(threadTs, conv, say);
    return;
  }

  const { provider, throttledFallback } = await getSlackProvider();

  if (!provider) {
    // "No provider configured" is wrong (and baffling) when one exists and is simply
    // rate-limited, so say which it is.
    await say(replyOpts({ text: `:warning: ${providerUnavailableMessage(throttledFallback)}` }));
    return;
  }

  // Post placeholder immediately
  const placeholder = await say(replyOpts({ text: ":hourglass: Thinking…" })) as { ts?: string };
  const placeholderTs = placeholder?.ts;

  const messages: ChatMessage[] = JSON.parse(conv.messages as string);

  // If there's a pending proposed task (not yet created), inject context so the
  // AI doesn't assume the task was already created and won't find it in the system.
  if (conv.proposed && !conv.taskId) {
    const pending = JSON.parse(conv.proposed as string) as Record<string, unknown>;
    messages.push({
      role: "user",
      content: `[System context: The task proposal titled "${pending.title}" is still awaiting user approval — it has NOT been created in the system yet. The user needs to click "Create Task" in Slack to create it.]`,
    });
    messages.push({
      role: "assistant",
      content: "Understood — the task proposal is pending approval and has not been created yet.",
    });
  }

  messages.push({ role: "user", content: text });

  const repoHistory = await getRepoHistory();

  let result: { reply: string; proposedTask?: ProposedTask };
  try {
    result = await traceLlmCall({ feature: "slack-chat", provider }, () => runSlackChat(messages, provider, threadTs, repoHistory));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Something went wrong";
    console.error(`[slack] runSlackChat failed (provider "${provider.name}", model ${provider.model ?? "default"}):`, msg);
    // Always surface the error to the user. Try to replace the "Thinking…"
    // placeholder; if that update fails (or there was no placeholder), fall
    // back to a fresh message so the user never stays stuck on "Thinking…".
    const errorText = `:warning: ${msg}`;
    try {
      if (placeholderTs) {
        await client.chat.update({ channel: channelId, ts: placeholderTs, text: errorText });
      } else {
        await say(replyOpts({ text: errorText }));
      }
    } catch (postErr) {
      console.error("[slack] failed to update placeholder with error, falling back to new message:", postErr);
      try {
        await say(replyOpts({ text: errorText }));
      } catch (sayErr) {
        console.error("[slack] failed to post error message to Slack:", sayErr);
      }
    }
    return;
  }

  messages.push({ role: "assistant", content: result.reply });

  // Whatever the model filled in just pre-fills the proposal form — the user can still
  // change every field before creating the task.
  const proposedTask = result.proposedTask ? sanitizeProposal(result.proposedTask) : undefined;

  await prisma.slackConversation.update({
    where: { threadTs },
    data: {
      messages: JSON.stringify(messages),
      ...(proposedTask ? { proposed: JSON.stringify(proposedTask) } : {}),
    },
  });

  if (proposedTask) {
    const blocks = await buildProposalBlocks(result.reply, proposedTask, threadTs);
    if (placeholderTs) {
      await client.chat.update({ channel: channelId, ts: placeholderTs, text: result.reply, blocks });
    } else {
      await say(replyOpts({ text: result.reply, blocks }));
    }
  } else {
    if (placeholderTs) {
      await client.chat.update({ channel: channelId, ts: placeholderTs, text: result.reply });
    } else {
      await say(replyOpts({ text: result.reply }));
    }
  }
}

// --- Bolt event/action handlers ---

export function registerSlackHandlers(app: App) {
  // Channel @mentions
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.event("app_mention", async ({ event, say, client }: SlackEventMiddlewareArgs<"app_mention"> & { say: SayFn; client: any }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = event as any;
    const threadTs: string = e.thread_ts ?? e.ts;
    const text: string = (e.text as string).replace(/<@[^>]+>/g, "").trim();
    await handleMessage(threadTs, e.channel as string, text, say, client);
  });

  // DMs and channel thread replies
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.message(async ({ message, say, client }: any) => {
    if (message.subtype) return;

    const isDM: boolean = (message.channel as string)?.startsWith("D");
    if (isDM) {
      const threadTs: string = message.channel as string;
      await handleMessage(threadTs, message.channel as string, message.text ?? "", say, client);
      return;
    }

    // Channel thread replies — only respond if we started this thread
    if (message.thread_ts) {
      const conv = await prisma.slackConversation.findUnique({ where: { threadTs: message.thread_ts } });
      if (!conv) return;
      await handleMessage(message.thread_ts, message.channel as string, message.text ?? "", say, client);
    }
  });

  // Provider dropdown — update proposed JSON and re-render with new model list
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.action("select_task_provider", async (args: any) => {
    const { action, ack, body, client } = args;
    await ack();

    const threadTs = threadTsFromBlockId(action.block_id as string);
    const providerId: string = action.selected_option.value;

    // The menu was rendered from a snapshot — the chosen provider may have been disabled or
    // deleted since. Resolve it the same way rendering does so a stale pick can't stick.
    const candidates = await prisma.aIProvider.findMany({ where: { isEnabled: true }, orderBy: { createdAt: "asc" } });
    const { provider } = pickProposalProvider(candidates, providerId);
    const models = provider
      ? await fetchModelsForProvider(provider.id, provider.type)
      : modelsForType("api");

    const proposed = await updateProposal(threadTs, body.state, (p) => {
      p.providerId = provider?.id;
      // Switching provider switches vendor too — keep the model only if the new provider
      // still offers it, otherwise fall to that provider's default.
      p.model = pickProposalModel(p.model, models, provider?.type) || undefined;
    });
    if (proposed) await rerenderProposal(body, client, threadTs, proposed);
  });

  // Model dropdown — persist selection
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.action("select_task_model", async (args: any) => {
    const { action, ack, body, client } = args;
    await ack();

    const threadTs = threadTsFromBlockId(action.block_id as string);
    const model: string = action.selected_option.value;

    const proposed = await updateProposal(threadTs, body.state, (p) => { p.model = model; });
    if (proposed) await rerenderProposal(body, client, threadTs, proposed);
  });

  // Schedule mode — run now / at a specific time / recurring
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.action("select_schedule_mode", async (args: any) => {
    const { action, ack, body, client } = args;
    await ack();

    const threadTs = threadTsFromBlockId(action.block_id as string);
    const mode = action.selected_option.value as ScheduleMode;

    const proposed = await updateProposal(threadTs, body.state, (p) => applyScheduleMode(p, mode));
    if (proposed) await rerenderProposal(body, client, threadTs, proposed);
  });

  // Every remaining widget (date/time pickers and the free-text fields) just stores its
  // own value and refreshes the summary at the top of the message.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleFieldChange = async (args: any) => {
    const { action, ack, body, client } = args;
    await ack();
    const { index, threadTs } = decodeBlockId(action.block_id as string);
    const proposed = await updateProposal(threadTs, body.state, (p) => {
      applyFieldValue(p, action.action_id as string, action as SlackFieldValue, index);
    });
    if (proposed) await rerenderProposal(body, client, threadTs, proposed);
  };
  app.action("pick_schedule_date", handleFieldChange);
  app.action("pick_schedule_time", handleFieldChange);

  // Git output mode — new branch / existing branch / main / PR
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.action("select_git_mode", async (args: any) => {
    const { action, ack, body, client } = args;
    await ack();

    const threadTs = threadTsFromBlockId(action.block_id as string);
    const mode = action.selected_option.value as GitMode;

    const proposed = await updateProposal(threadTs, body.state, (p) => applyGitMode(p, mode));
    if (proposed) await rerenderProposal(body, client, threadTs, proposed);
  });

  // Add a repo typed into the "Add a repository" field
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.action("input_new_repo", async (args: any) => {
    const { action, ack, body, client } = args;
    await ack();

    const threadTs = threadTsFromBlockId(action.block_id as string);
    const proposed = await updateProposal(threadTs, body.state, (p) => {
      const url = (action.value as string | undefined)?.trim() || p.newRepoUrl;
      if (url) addRepo(p, url);
      p.newRepoUrl = undefined;
    });
    if (proposed) await rerenderProposal(body, client, threadTs, proposed);
  });

  // Add a repo picked from the "previously used" menu
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.action("select_known_repo", async (args: any) => {
    const { action, ack, body, client } = args;
    await ack();

    const threadTs = threadTsFromBlockId(action.block_id as string);
    const proposed = await updateProposal(threadTs, body.state, (p) => {
      addRepo(p, action.selected_option.value as string);
    });
    if (proposed) await rerenderProposal(body, client, threadTs, proposed);
  });

  // Remove a repo
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.action("remove_repo", async (args: any) => {
    const { action, ack, body, client } = args;
    await ack();

    const threadTs = threadTsFromBlockId(action.block_id as string);
    const index = Number(action.value);
    const proposed = await updateProposal(threadTs, body.state, (p) => removeRepo(p, index));
    if (proposed) await rerenderProposal(body, client, threadTs, proposed);
  });

  // Single-line free-text fields, each dispatching when the user presses Enter. (The
  // multi-line context field can't dispatch on Enter, so it rides along in the message
  // state that `updateProposal` folds in on every other interaction.)
  app.action("input_cron", handleFieldChange);
  app.action("input_max_runs", handleFieldChange);
  app.action("input_target_branch", handleFieldChange);
  app.action("input_repo_branch", handleFieldChange);

  // Approve task button
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.action("approve_task", async (args: any) => {
    const { action, ack, say, body, client } = args;
    await ack();
    const threadTs: string = action.value;

    // Fold in anything still sitting unsubmitted in the form's inputs before creating.
    const proposed = await updateProposal(threadTs, body.state);
    if (!proposed) {
      await say({ text: "No pending task found.", thread_ts: threadTs });
      return;
    }

    const problem = validateProposal(proposed);
    if (problem) {
      await say({ text: `:warning: ${problem}`, thread_ts: threadTs });
      return;
    }

    const scheduleMode = scheduleModeOf(proposed);
    const gitMode = gitModeOf(proposed);

    // Last check before the task is written: a provider can be disabled or deleted between
    // the form being posted and this click. Pinning a dead id on the task would show a
    // bogus provider in the UI, so substitute the best available one — and when nothing is
    // enabled at all, pin nothing and let the worker resolve a provider at run time.
    const enabledProviders = await prisma.aIProvider.findMany({ where: { isEnabled: true }, orderBy: { createdAt: "asc" } });
    const { provider: runProvider, fellBack: providerFellBack } = pickProposalProvider(enabledProviders, proposed.providerId);
    const runModel = modelFitsProvider(proposed.model, runProvider?.type) ? proposed.model : null;
    if (providerFellBack && runProvider) {
      await say({
        text: `:information_source: The provider selected for this task wasn't available, so it will run with *${runProvider.name}*.`,
        thread_ts: threadTs,
      });
    }

    const maxPos = await prisma.task.aggregate({ _max: { position: true } });
    const position = (maxPos._max.position ?? -1) + 1;
    // Slack-approved tasks have no priority of their own, so fall back to the
    // target repo's default priority (set on the Repositories page) when one
    // of the chosen repos has one configured.
    const priority = normalizePriority(
      await resolveDefaultPriorityForRepos((proposed.repos ?? []).map((r) => r.url))
    );

    const task = await prisma.task.create({
      data: {
        title: `[slack] ${proposed.title}`,
        description: proposed.description,
        context: proposed.context ?? null,
        position,
        priority,
        scheduledFor: scheduleMode === "scheduled" ? new Date(proposed.scheduledFor as string) : null,
        cronExpression: scheduleMode === "recurring" ? (proposed.cronExpression?.trim() ?? null) : null,
        maxRuns: scheduleMode === "recurring" ? normalizeMaxRuns(proposed.maxRuns) : null,
        isRecurringTemplate: scheduleMode === "recurring",
        targetBranch: gitMode === "target" ? (proposed.targetBranch?.trim() ?? null) : null,
        pushToMain: gitMode === "main",
        createPR: gitMode === "pr",
        aiProviderId: runProvider?.id ?? null,
        model: runModel ?? null,
        repos: proposed.repos?.length
          ? {
              create: proposed.repos.map((r) => ({
                alias: r.url.split("/").pop()?.replace(/\.git$/, "") || "repo",
                url: r.url,
                branch: r.branch ?? null,
              })),
            }
          : undefined,
      },
    });

    await prisma.slackConversation.update({
      where: { threadTs },
      data: { proposed: null, taskId: task.id },
    });

    // The form is spent — collapse it to a read-only summary so the (now stale)
    // controls can't be edited or the task created twice.
    await replaceProposalMessage(body, client, `:white_check_mark: Task created.\n\n${summariseProposal(proposed)}`);

    const appUrl = await getAppUrl();
    await say({
      thread_ts: threadTs,
      text: `Task created: ${appUrl}/tasks/${task.id}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `:white_check_mark: Task created: *${proposed.title}*\n<${appUrl}/tasks/${task.id}|View task →>`,
          },
        },
      ],
    });
  });

  // Cancel button
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.action("cancel_task", async (args: any) => {
    const { action, ack, say, body, client } = args;
    await ack();
    const threadTs: string = action.value;
    await prisma.slackConversation.update({ where: { threadTs }, data: { proposed: null } });
    await replaceProposalMessage(body, client, ":x: Task proposal cancelled.");
    await say({ text: "Cancelled. Let me know if you'd like to try again.", thread_ts: threadTs });
  });
}

// --- Utility ---

function truncateForSlack(text: string, limit = 2900): string {
  if (text.length <= limit) return text;
  return `…(truncated)\n${text.slice(text.length - limit)}`;
}

// --- Notification poller ---

export function startNotificationPoller(client: WebClient): () => void {
  let cancelled = false;

  async function poll() {
    if (cancelled) return;
    try {
      const pending = await prisma.slackConversation.findMany({
        where: { taskId: { not: null }, notified: false },
      });

      for (const conv of pending) {
        const task = await prisma.task.findUnique({
          where: { id: conv.taskId },
          include: { logs: { where: { level: "info" }, orderBy: { createdAt: "asc" } } },
        });
        if (!task || (task.status !== "completed" && task.status !== "no_changes" && task.status !== "failed")) continue;

        const isDone = task.status === "completed" || task.status === "no_changes";
        const emoji = task.status === "no_changes" ? ":information_source:" : isDone ? ":white_check_mark:" : ":x:";
        const label = task.status === "no_changes" ? "finished with no code changes" : isDone ? "completed" : "failed";
        const infoLogs: { content: string }[] = task.logs ?? [];
        const outputText = infoLogs.map((l: { content: string }) => l.content.trim()).filter(Boolean).join("\n\n");

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const blocks: any[] = [
          { type: "section", text: { type: "mrkdwn", text: `${emoji} *${task.title}* ${label}.` } },
        ];
        if (outputText) {
          blocks.push({ type: "section", text: { type: "mrkdwn", text: truncateForSlack(outputText) } });
        }
        blocks.push({ type: "divider" });
        const appUrl = await getAppUrl();
        blocks.push({
          type: "context",
          elements: [{ type: "mrkdwn", text: `<${appUrl}/tasks/${task.id}|View full task →>` }],
        });

        await client.chat.postMessage({
          channel: conv.channelId,
          thread_ts: conv.threadTs,
          text: `${emoji} Task *${task.title}* ${label}.`,
          blocks,
        });

        await prisma.slackConversation.update({
          where: { threadTs: conv.threadTs },
          data: { notified: true },
        });
      }
    } catch (err) {
      console.error("[integrations] notification poll error:", err);
    }

    if (!cancelled) setTimeout(poll, 10_000);
  }

  setTimeout(poll, 10_000);
  return () => { cancelled = true; };
}
