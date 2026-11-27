import Anthropic from "@anthropic-ai/sdk";
import { assistantRequestOptions, ModelRefusalError } from "@/lib/anthropic-reply";
import OpenAI from "openai";
import { spawn } from "child_process";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { DEFAULT_ASSISTANT_MODEL } from "@/lib/models";
import { runCodexText } from "@/lib/providers/codex-exec";
import { normalizeMaxRuns } from "@/lib/max-runs";
import { claudeCliText, reportAnthropicUsage, reportOpenAIUsage } from "./llm-usage-context";

export type ChatbotLevel = "low" | "medium" | "high";

export const LOW_SYSTEM_PROMPT = `You are a concise assistant that creates tasks for an AI agent. Your goal is to propose a task as QUICKLY as possible — ideally after the user's very first message.

Rules:
- After the user's FIRST message, immediately call propose_task with your best interpretation
- Write a thorough, actionable description even if you're inferring some details — don't wait for more info
- Do NOT ask clarifying questions unless critical information is genuinely missing (i.e. you cannot form any description at all)
- If a repository is selected or mentioned, include it — do not ask "which repo?" if one is already known
- Skip scheduling unless the user explicitly mentions a schedule
- Infer the title from the description
- For repos: git clone URLs must end in .git; append .git if the user provides a URL without it

Repo selection rules:
- If the user mentions a repo name matching one from their history, use that exact URL — never ask them to confirm it
- If the selected repo was already specified via context, include it automatically`;

export const MEDIUM_SYSTEM_PROMPT = `You are a helpful assistant that creates tasks for an AI agent. Keep the conversation short — aim to propose a task within 1–2 exchanges.

Task fields to collect:
- **title** (required): A short, descriptive title (infer from description if possible)
- **description** (required): Detailed, actionable instructions for the AI agent
- **repos** (optional): Only if the task clearly involves modifying code
- **scheduling** (optional): Only if the user brings it up

Your approach:
1. If the user's first message is clear enough, immediately call propose_task
2. If something critical is missing, ask ONE focused follow-up question, then propose
3. Do not ask about repos or scheduling unless clearly relevant

Guidelines:
- Many tasks don't involve code — don't ask about repos unless it's obvious
- For repos: append .git to URLs if missing
- If the user says "just create it" or "that's enough", call propose_task immediately`;

export const BASE_SYSTEM_PROMPT = `You are a helpful assistant that guides users through creating tasks for an AI agent. Through friendly conversation, gather the information needed to create a well-defined task.

The task fields you need to collect are:
- **title** (required): A short, descriptive title
- **description** (required): Detailed instructions for what the AI agent should do
- **context** (optional): Additional context, constraints, or background info
- **repos** (optional): Git repositories the agent will work on. Only relevant if the task involves making changes to code. Each has a url and an optional branch to check out (defaults to the repo's default branch if omitted)
- **branch settings** (optional, only relevant when repos are provided):
  - **targetBranch**: push changes to this specific existing branch
  - **pushToMain**: push directly to main/master (use with caution)
  - **createPR**: open a pull request after the agent finishes
  - If none are specified the agent commits to a new branch and does not push
- **scheduling** (optional): Either a one-time datetime or a recurring cron expression

Your approach:
1. Start by asking the user to describe what they want to accomplish in natural language
2. Ask clarifying questions to flesh out the description — be specific about what the agent should do and what the expected output is
3. Only if the task involves making changes to a codebase: ask which repo and branch to use
4. Only if a repo was provided: ask how changes should be handled (new branch, push to a target branch, push to main, or open a PR)
5. Ask about scheduling only if relevant or the user brings it up
6. Once you have title, description, and enough detail, call the propose_task tool with your best understanding

Guidelines:
- Many tasks have nothing to do with code — research, analysis, writing, data processing, etc. Do not ask about repos or branch settings unless the task clearly involves modifying a codebase.
- Keep questions focused — ask one or two things at a time
- Don't ask about things already clearly stated
- Infer the title from the description if possible
- For repos: git clone URLs must end in .git. If the user provides an HTTP/HTTPS or SSH URL without .git (e.g. https://github.com/user/repo), append .git and let the user know. Always store the corrected URL in propose_task.
- For scheduling: one-time format is an ISO datetime string, recurring is a standard 5-field cron expression
- If the user says "just create it" or "that's enough", call propose_task with what you have`;

function getBasePrompt(level?: ChatbotLevel): string {
  if (level === "low") return LOW_SYSTEM_PROMPT;
  if (level === "medium") return MEDIUM_SYSTEM_PROMPT;
  return BASE_SYSTEM_PROMPT;
}

export const OUTPUT_TYPE_GUIDANCE = `

---

## Output type

Every task has an \`outputType\` that controls how its result is delivered. Infer it from the request and include it in propose_task:
- **"repository"** (default) — the agent writes code and pushes commits or a PR. Use this whenever the task is about modifying a codebase.
- **"file"** — the agent produces documents/files (reports, markdown, CSV, JSON, etc.) shown in the Files section. Use for research, writing, analysis, or data-processing tasks with no code to commit.
- **"design"** — the agent produces interactive HTML app/UI **design mockups** viewable in the Files section. Use this whenever the user asks you to **design** something visual: "design me an app", "mock up a landing page", "create a UI/screen/dashboard design", "wireframe", etc. Do NOT attach a repo for design tasks unless the user explicitly wants to match an existing codebase's style.
- **"result"** — no files and no commits: the agent's answer is shown inline on the task details page. Use for quick questions, lookups, summaries or analyses where the user just wants to read the answer.

When outputType is "file", "design" or "result", omit repos/branch settings unless the user explicitly wants a repo as read-only reference.`;

export function buildSystemPrompt(gitContext?: string, repoHistory?: { url: string; alias: string }[], level?: ChatbotLevel, selectedRepoUrl?: string): string {
  let prompt = getBasePrompt(level) + OUTPUT_TYPE_GUIDANCE;

  if (repoHistory && repoHistory.length > 0) {
    const list = repoHistory.map((r) => `- ${r.alias}: ${r.url}`).join("\n");
    prompt += `\n\n---\n\n## Previously used repositories\n\nThe user has worked with these repositories before. If the task involves one of them, suggest it by name and use the exact URL shown — do not ask the user to provide it again.\n\n${list}`;
  }

  if (selectedRepoUrl) {
    prompt += `\n\n---\n\n## Selected repository\n\nThe user has already selected this repository for the task: ${selectedRepoUrl}\nInclude it in propose_task — do not ask which repo to use.`;
  }

  if (gitContext) {
    prompt += `\n\n---\n\n## Repository Context\n\nThe user has attached a git repository for context. Use it to understand the codebase, ask more targeted questions, and produce a more accurate, codebase-specific task. Reference patterns, conventions, or constraints you discover when drafting the description.\n\n${gitContext}`;
  }

  return prompt;
}

export const CLI_TOOL_INSTRUCTIONS = `
When you have gathered enough information to propose a task, output a JSON block inside <propose_task>...</propose_task> tags with this shape:
<propose_task>
{"title": "...", "description": "...", "context": "...", "outputType": "repository", "repos": [{"url": "...", "branch": "..."}], "targetBranch": "...", "pushToMain": false, "createPR": false, "isRecurring": false, "cronExpression": "...", "maxRuns": null, "scheduledFor": "..."}
</propose_task>
Only include fields that apply. "title" and "description" are required. Omit optional fields if not provided. "branch" inside a repo object is the branch to check out — omit it to use the repo's default branch. "maxRuns" caps how many times a recurring task runs — omit it (or use null) for unlimited, which is the default. "outputType" is one of "repository" (code, default), "file" (documents), "result" (an answer shown inline on the task page), or "design" (interactive HTML mockups — apps, UIs, diagrams, etc.) — set it to "design" when the user asks you to design something visual.`;

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ProposedRepo {
  url: string;
  branch?: string;
}

export interface ProposedTask {
  title: string;
  description: string;
  context?: string;
  repos?: ProposedRepo[];
  targetBranch?: string;
  pushToMain?: boolean;
  createPR?: boolean;
  scheduledFor?: string;
  isRecurring?: boolean;
  cronExpression?: string;
  /** Max number of scheduled runs for a recurring task. Omitted/null means unlimited. */
  maxRuns?: number | null;
  /**
   * How the task's result is delivered:
   * - "repository" (default): the agent writes code and pushes commits/PRs
   * - "file": the agent writes documents/files into the Files section
   * - "design": the agent produces interactive HTML app/UI design mockups
   */
  outputType?: "repository" | "file" | "design" | "result";
}

export function normalizeGitUrl(url: string): string {
  const trimmed = url.trim();
  return trimmed.endsWith(".git") ? trimmed : `${trimmed}.git`;
}

export function normalizeProposedTask(input: Record<string, unknown>): ProposedTask {
  if (Array.isArray(input.repos)) {
    input.repos = (input.repos as (string | ProposedRepo)[]).map((r) => {
      if (typeof r === "string") return { url: normalizeGitUrl(r) };
      return { ...r, url: normalizeGitUrl(r.url) };
    });
  }
  // Only accept the known output types; anything else falls back to the default.
  if (input.outputType !== "file" && input.outputType !== "design" && input.outputType !== "result") {
    delete input.outputType;
  }
  // The model can emit maxRuns as a string ("5") or a nonsense value — normalize it down
  // to a positive integer, or null for the unlimited default.
  if ("maxRuns" in input) {
    input.maxRuns = normalizeMaxRuns(input.maxRuns);
  }
  return input as unknown as ProposedTask;
}

export function writeCliCredentials(configDir: string, credentialsJson: string) {
  try {
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
    writeFileSync(`${configDir}/.credentials.json`, credentialsJson, { encoding: "utf8", mode: 0o600 });
  } catch { /* non-fatal */ }
}

/**
 * Pull the `<propose_task>` tag (if any) out of a raw text reply.
 *
 * Shared by every CLI-style provider: the tag protocol is in the prompt, not in the
 * transport, so Claude and Codex produce identically-shaped output.
 */
function extractProposedTask(output: string): { reply: string; proposedTask?: ProposedTask } {
  const tagMatch = output.match(/<propose_task>([\s\S]*?)<\/propose_task>/);
  let proposedTask: ProposedTask | undefined;
  let reply = output.replace(/<propose_task>[\s\S]*?<\/propose_task>/g, "").trim();

  if (tagMatch) {
    try {
      proposedTask = normalizeProposedTask(JSON.parse(tagMatch[1].trim()) as Record<string, unknown>);
      if (!reply) reply = "I've put together a task based on our conversation. Take a look and create it when you're ready!";
    } catch {
      // leave proposedTask undefined if JSON is malformed
    }
  }

  return { reply, proposedTask };
}

export async function runWithCli(
  messages: ChatMessage[],
  configDir?: string,
  model?: string,
  credentialsJson?: string,
  gitContext?: string,
  repoHistory?: { url: string; alias: string }[],
  level?: ChatbotLevel,
  selectedRepoUrl?: string,
  providerType?: string,
): Promise<{ reply: string; proposedTask?: ProposedTask }> {
  const conversation = messages
    .map((m) => `${m.role === "user" ? "Human" : "Assistant"}: ${m.content}`)
    .join("\n\n");

  // Keep the static system prompt (+ any git context, which can be several KB)
  // out of the `-p` text and pass it via --system-prompt instead. It's
  // byte-for-byte identical across every turn of this conversation, so the
  // Anthropic API can serve it from cache instead of re-billing it as fresh
  // input tokens on every single message — only the (much smaller) growing
  // conversation gets sent as new text each turn.
  const systemPrompt = `${buildSystemPrompt(gitContext, repoHistory, level, selectedRepoUrl)}\n${CLI_TOOL_INSTRUCTIONS}`;
  const prompt = `Conversation so far:\n${conversation}\n\nAssistant:`;

  // Codex is a different binary with a different flag set and its own auth file. It runs
  // sandboxed read-only, which gives the same guarantee `--tools ""` gives the Claude CLI:
  // the assistant can only emit text, never create a task behind the approval button.
  if (providerType === "codex-cli") {
    const output = await runCodexText(`${systemPrompt}\n\n${prompt}`, { configDir, model, credentialsJson });
    return extractProposedTask(output);
  }
  if (configDir && credentialsJson) writeCliCredentials(configDir, credentialsJson);

  return new Promise((resolve, reject) => {
    // --tools "" disables all built-in tools; the chat assistant must only emit text +
    // a <propose_task> tag. With tools available the AI could create tasks itself
    // (e.g. via Bash/WebFetch hitting /api/tasks) and bypass the Slack approval button.
    const args = ["--system-prompt", systemPrompt, "-p", prompt, "--output-format", "json", "--tools", ""];
    if (model) args.push("--model", model);

    const child = spawn("claude", args, {
      cwd: "/tmp",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: undefined,
        PATH: [process.env.PATH ?? "", process.env.CLAUDE_PATH].filter(Boolean).join(":"),
        ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}),
      },
    });

    let output = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { output += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("close", (code) => {
      // --output-format json: back to the reply text, recording the run's token usage.
      output = claudeCliText(output);
      if (code !== 0) {
        const detail = stderr.trim() || output.trim();
        const base = `Claude CLI exited with code ${code}`;
        reject(new Error(detail ? `${base}: ${detail}` : `${base}. Make sure the CLI is installed and you are logged in ("claude login").`));
        return;
      }

      resolve(extractProposedTask(output));
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      const msg = err.code === "ENOENT"
        ? "Claude CLI not found. Install it from https://claude.ai/download and make sure it is on your PATH."
        : `Failed to start Claude CLI: ${err.message}`;
      reject(new Error(msg));
    });
  });
}

export async function runWithApi(
  messages: ChatMessage[],
  apiKey: string,
  baseURL?: string,
  model?: string,
  gitContext?: string,
  repoHistory?: { url: string; alias: string }[],
  level?: ChatbotLevel,
  selectedRepoUrl?: string,
): Promise<{ reply: string; proposedTask?: ProposedTask }> {
  const client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
  const systemPrompt = buildSystemPrompt(gitContext, repoHistory, level, selectedRepoUrl);

  const proposeTaskTool: Anthropic.Tool = {
    name: "propose_task",
    description: "Propose a task with the gathered information. Call this once you have enough detail to create a well-defined task.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Short descriptive title for the task" },
        description: { type: "string", description: "Detailed instructions for the AI agent" },
        context: { type: "string", description: "Additional context or constraints (optional)" },
        outputType: {
          type: "string",
          enum: ["repository", "file", "design", "result"],
          description: "How the result is delivered: 'repository' (code + commits/PR, default), 'file' (documents shown in Files), 'design' (interactive HTML mockups — apps, UIs, diagrams, etc.), or 'result' (just an answer shown inline on the task page — no files, no commits). Use 'design' when the user asks you to design something visual.",
        },
        repos: {
          type: "array",
          description: "Repositories the agent needs access to (optional)",
          items: {
            type: "object",
            properties: {
              url: { type: "string", description: "Git clone URL ending in .git" },
              branch: { type: "string", description: "Branch to check out (omit for default branch)" },
            },
            required: ["url"],
          },
        },
        targetBranch: { type: "string", description: "Push changes to this existing branch (optional)" },
        pushToMain: { type: "boolean", description: "Push directly to main/master (optional)" },
        createPR: { type: "boolean", description: "Open a pull request after the agent finishes (optional)" },
        scheduledFor: { type: "string", description: "ISO datetime string for one-time scheduling (optional)" },
        isRecurring: { type: "boolean", description: "Whether this is a recurring task" },
        cronExpression: { type: "string", description: "Cron expression for recurring tasks, e.g. '0 9 * * 1-5' (optional)" },
        maxRuns: { type: "integer", description: "Maximum number of times a recurring task should run before stopping. Omit for unlimited (the default)." },
      },
      required: ["title", "description"],
    },
  };

  const response = await client.messages.create({
    model: model ?? DEFAULT_ASSISTANT_MODEL,
    ...assistantRequestOptions(model ?? DEFAULT_ASSISTANT_MODEL, 1024, "medium"),
    system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
    tools: [proposeTaskTool],
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  });
  reportAnthropicUsage(response);
  if (response.stop_reason === "refusal") throw new ModelRefusalError();

  let reply = "";
  let proposedTask: ProposedTask | undefined;

  for (const block of response.content) {
    if (block.type === "text") {
      reply = block.text;
    } else if (block.type === "tool_use" && block.name === "propose_task") {
      proposedTask = normalizeProposedTask(block.input as Record<string, unknown>);
      if (!reply) reply = "I've put together a task based on our conversation. Take a look and create it when you're ready!";
    }
  }

  return { reply, proposedTask };
}

export async function runWithOpenAI(
  messages: ChatMessage[],
  apiKey: string,
  baseURL?: string,
  model?: string,
  gitContext?: string,
  repoHistory?: { url: string; alias: string }[],
  level?: ChatbotLevel,
  selectedRepoUrl?: string,
): Promise<{ reply: string; proposedTask?: ProposedTask }> {
  const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  const systemPrompt = buildSystemPrompt(gitContext, repoHistory, level, selectedRepoUrl);

  const proposeTaskTool: OpenAI.ChatCompletionTool = {
    type: "function",
    function: {
      name: "propose_task",
      description: "Propose a task with the gathered information. Call this once you have enough detail to create a well-defined task.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short descriptive title for the task" },
          description: { type: "string", description: "Detailed instructions for the AI agent" },
          context: { type: "string", description: "Additional context or constraints (optional)" },
          outputType: {
            type: "string",
            enum: ["repository", "file", "design", "result"],
            description: "How the result is delivered: 'repository' (code + commits/PR, default), 'file' (documents shown in Files), 'design' (interactive HTML mockups — apps, UIs, diagrams, etc.), or 'result' (just an answer shown inline on the task page — no files, no commits). Use 'design' when the user asks you to design something visual.",
          },
          repos: {
            type: "array",
            description: "Repositories the agent needs access to (optional)",
            items: {
              type: "object",
              properties: {
                url: { type: "string", description: "Git clone URL ending in .git" },
                branch: { type: "string", description: "Branch to check out (omit for default branch)" },
              },
              required: ["url"],
            },
          },
          targetBranch: { type: "string", description: "Push changes to this existing branch (optional)" },
          pushToMain: { type: "boolean", description: "Push directly to main/master (optional)" },
          createPR: { type: "boolean", description: "Open a pull request after the agent finishes (optional)" },
          scheduledFor: { type: "string", description: "ISO datetime string for one-time scheduling (optional)" },
          isRecurring: { type: "boolean", description: "Whether this is a recurring task" },
          cronExpression: { type: "string", description: "Cron expression for recurring tasks, e.g. '0 9 * * 1-5' (optional)" },
        maxRuns: { type: "integer", description: "Maximum number of times a recurring task should run before stopping. Omit for unlimited (the default)." },
        },
        required: ["title", "description"],
      },
    },
  };

  const response = await client.chat.completions.create({
    model: model ?? "gpt-4o",
    max_tokens: 1024,
    tools: [proposeTaskTool],
    messages: [
      { role: "system", content: systemPrompt },
      ...messages.map((m) => ({ role: m.role, content: m.content })),
    ],
  });
  reportOpenAIUsage(response);

  const choice = response.choices[0];
  let reply = choice.message.content ?? "";
  let proposedTask: ProposedTask | undefined;

  for (const call of choice.message.tool_calls ?? []) {
    if (call.type === "function" && call.function.name === "propose_task") {
      try {
        proposedTask = normalizeProposedTask(JSON.parse(call.function.arguments) as Record<string, unknown>);
        if (!reply) reply = "I've put together a task based on our conversation. Take a look and create it when you're ready!";
      } catch {
        // ignore parse error
      }
    }
  }

  return { reply, proposedTask };
}
