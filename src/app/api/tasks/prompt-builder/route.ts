import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { assistantRequestOptions, ModelRefusalError } from "@/lib/anthropic-reply";
import OpenAI from "openai";
import { spawn } from "child_process";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { getProvider, providerUnavailableMessage } from "@/lib/smart-provider";
import { DEFAULT_ASSISTANT_MODEL } from "@/lib/models";
import { runCodexText } from "@/lib/providers/codex-exec";
import { traceLlmCall } from "@/lib/gen-ai-otel";

const BASE_SYSTEM_PROMPT = `You are a Prompt Builder assistant. Your job is to help users write clear, detailed, actionable task descriptions for an AI coding agent.

IMPORTANT: The task description you help write is NOT specific to this AI task manager app. It will be run against whatever git repository or application the user specifies — that repository context is provided separately when the task actually runs. Do not assume you know what codebase or application the agent will be working in. Write the description so it stands on its own and makes sense in context of any target repo.

A great task description for a coding agent should include:
- A clear goal and expected outcome
- The specific changes or work to be done
- Any constraints, coding style, or approach requirements
- Edge cases or error handling to consider
- What "done" looks like (acceptance criteria)

Your approach:
1. Read the user's initial description (it may be rough or incomplete)
2. Ask focused clarifying questions — one or two at a time — to flesh out missing details
3. After 1-3 exchanges, propose an improved version of the description
4. Allow the user to refine further or approve it
5. When the user is happy with a version (or asks to finalize), output the final refined prompt

When you have a polished description ready to suggest, output it in this format:
<refined_prompt>
[the refined task description here]
</refined_prompt>

You can include a refined_prompt block in any message — the user can keep chatting to refine further, or click "Use Prompt" to accept it.

Keep your messages concise and focused. Don't pad with generic advice — ask specific questions or make specific suggestions about the user's actual task.`;

const CLI_TOOL_INSTRUCTIONS = `
When you have a polished task description to suggest, include it like this:
<refined_prompt>
[the refined task description]
</refined_prompt>

You can include this in any response. Keep chatting to refine further based on feedback.`;

function buildSystemPrompt(gitContext?: string): string {
  if (!gitContext) return BASE_SYSTEM_PROMPT;
  return `${BASE_SYSTEM_PROMPT}\n\n---\n\n## Repository Context\n\nThe user has attached a git repository for context. Use it to understand the codebase, ask more targeted questions, and produce a more accurate, codebase-specific task description. Reference patterns, conventions, or constraints you discover when drafting the prompt.\n\n${gitContext}`;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function writeCliCredentials(configDir: string, credentialsJson: string) {
  try {
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
    writeFileSync(`${configDir}/.credentials.json`, credentialsJson, { encoding: "utf8", mode: 0o600 });
  } catch { /* non-fatal */ }
}

/** Pull the <refined_prompt> tag (if any) out of a raw text reply, same shape for every CLI-style provider. */
function extractRefinedPrompt(output: string): { reply: string; refinedPrompt?: string } {
  const tagMatch = output.match(/<refined_prompt>([\s\S]*?)<\/refined_prompt>/);
  const refinedPrompt = tagMatch ? tagMatch[1].trim() : undefined;
  const reply = output.replace(/<refined_prompt>[\s\S]*?<\/refined_prompt>/g, "").trim();
  return {
    reply: reply || (refinedPrompt ? "Here's a refined version of your description. You can keep chatting to adjust it, or click \"Use Prompt\" to use it." : ""),
    refinedPrompt,
  };
}

async function runWithCli(messages: ChatMessage[], configDir?: string, model?: string, credentialsJson?: string, gitContext?: string, providerType?: string): Promise<{ reply: string; refinedPrompt?: string }> {
  const conversation = messages
    .map((m) => `${m.role === "user" ? "Human" : "Assistant"}: ${m.content}`)
    .join("\n\n");

  const systemPrompt = buildSystemPrompt(gitContext);
  const prompt = `${systemPrompt}\n${CLI_TOOL_INSTRUCTIONS}\n\nConversation so far:\n${conversation}\n\nAssistant:`;

  // Codex writes its own auth.json inside runCodexText; writeCliCredentials targets the Claude CLI's format.
  if (providerType === "codex-cli") {
    const output = await runCodexText(prompt, { configDir, model, credentialsJson });
    return extractRefinedPrompt(output);
  }
  if (configDir && credentialsJson) writeCliCredentials(configDir, credentialsJson);

  return new Promise((resolve, reject) => {
    // --tools "" disables all built-in tools so the CLI just answers as a text
    // assistant, same as every other single-turn helper endpoint (src/lib/chat.ts,
    // src/lib/repo-chat.ts, etc). Without it the CLI runs in full agentic mode with
    // no --max-turns cap, so it can wander off trying to use tools instead of just
    // replying — which is what made this endpoint appear to hang on "Thinking…".
    const args = ["-p", prompt, "--output-format", "text", "--tools", ""];
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
      if (code !== 0) {
        const detail = stderr.trim() || output.trim();
        const base = `Claude CLI exited with code ${code}`;
        reject(new Error(detail ? `${base}: ${detail}` : `${base}. Make sure the CLI is installed and you are logged in ("claude login").`));
        return;
      }

      resolve(extractRefinedPrompt(output));
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      const msg = err.code === "ENOENT"
        ? "Claude CLI not found. Install it from https://claude.ai/download and make sure it is on your PATH."
        : `Failed to start Claude CLI: ${err.message}`;
      reject(new Error(msg));
    });
  });
}

async function runWithApi(
  messages: ChatMessage[],
  apiKey: string,
  baseURL?: string,
  model?: string,
  gitContext?: string,
): Promise<{ reply: string; refinedPrompt?: string }> {
  const client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
  const systemPrompt = buildSystemPrompt(gitContext);

  const refinePromptTool: Anthropic.Tool = {
    name: "suggest_refined_prompt",
    description: "Suggest a refined, improved version of the task description. Call this whenever you have a polished version to offer the user.",
    input_schema: {
      type: "object" as const,
      properties: {
        refined_prompt: { type: "string", description: "The refined task description" },
      },
      required: ["refined_prompt"],
    },
  };

  const response = await client.messages.create({
    model: model ?? DEFAULT_ASSISTANT_MODEL,
    ...assistantRequestOptions(model ?? DEFAULT_ASSISTANT_MODEL, 1024, "medium"),
    system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
    tools: [refinePromptTool],
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  });
  if (response.stop_reason === "refusal") throw new ModelRefusalError();

  let reply = "";
  let refinedPrompt: string | undefined;

  for (const block of response.content) {
    if (block.type === "text") {
      reply = block.text;
    } else if (block.type === "tool_use" && block.name === "suggest_refined_prompt") {
      const input = block.input as { refined_prompt: string };
      refinedPrompt = input.refined_prompt;
      if (!reply) reply = "Here's a refined version of your description. You can keep chatting to adjust it, or click \"Use Prompt\" to use it.";
    }
  }

  return { reply, refinedPrompt };
}

async function runWithOpenAI(
  messages: ChatMessage[],
  apiKey: string,
  baseURL?: string,
  model?: string,
  gitContext?: string,
): Promise<{ reply: string; refinedPrompt?: string }> {
  const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  const systemPrompt = buildSystemPrompt(gitContext);

  const refinePromptTool: OpenAI.ChatCompletionTool = {
    type: "function",
    function: {
      name: "suggest_refined_prompt",
      description: "Suggest a refined, improved version of the task description.",
      parameters: {
        type: "object",
        properties: {
          refined_prompt: { type: "string", description: "The refined task description" },
        },
        required: ["refined_prompt"],
      },
    },
  };

  const response = await client.chat.completions.create({
    model: model ?? "gpt-4o",
    max_tokens: 1024,
    tools: [refinePromptTool],
    messages: [
      { role: "system", content: systemPrompt },
      ...messages.map((m) => ({ role: m.role, content: m.content })),
    ],
  });

  const choice = response.choices[0];
  let reply = choice.message.content ?? "";
  let refinedPrompt: string | undefined;

  for (const call of choice.message.tool_calls ?? []) {
    if (call.type === "function" && call.function.name === "suggest_refined_prompt") {
      try {
        const parsed = JSON.parse(call.function.arguments) as { refined_prompt: string };
        refinedPrompt = parsed.refined_prompt;
        if (!reply) reply = "Here's a refined version of your description. You can keep chatting to adjust it, or click \"Use Prompt\" to use it.";
      } catch {
        // ignore parse error
      }
    }
  }

  return { reply, refinedPrompt };
}

export async function POST(req: NextRequest) {
  const body = await req.json() as { messages: ChatMessage[]; providerId?: string; model?: string; gitContext?: string };
  const { messages, providerId, model: modelOverride, gitContext } = body;

  if (!messages?.length) {
    return NextResponse.json({ error: "messages are required" }, { status: 400 });
  }

  const { provider, throttledFallback } = await getProvider({ explicitProviderId: providerId });
  if (!provider) {
    return NextResponse.json({ error: providerUnavailableMessage(throttledFallback) }, { status: 400 });
  }

  try {
    let result: { reply: string; refinedPrompt?: string };

    const effectiveModel = modelOverride || provider.model || undefined;

    if (provider.type === "api") {
      const apiKey = provider.apiKey || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        return NextResponse.json({ error: "No API key configured for this provider." }, { status: 400 });
      }
      result = await traceLlmCall({ feature: "prompt-builder", provider: provider, model: effectiveModel }, () => runWithApi(messages, apiKey, provider.baseUrl || undefined, effectiveModel, gitContext || undefined));
    } else if (provider.type === "openai") {
      const apiKey = provider.apiKey || process.env.OPENAI_API_KEY;
      if (!apiKey) {
        return NextResponse.json({ error: "No API key configured for this provider." }, { status: 400 });
      }
      result = await traceLlmCall({ feature: "prompt-builder", provider: provider, model: effectiveModel }, () => runWithOpenAI(messages, apiKey, provider.baseUrl || undefined, effectiveModel, gitContext || undefined));
    } else {
      result = await traceLlmCall({ feature: "prompt-builder", provider: provider, model: effectiveModel }, () => runWithCli(messages, provider.configDir || undefined, effectiveModel, provider.credentialsJson || undefined, gitContext || undefined, provider.type));
    }

    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Chat failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
