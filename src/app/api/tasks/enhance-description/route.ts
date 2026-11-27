import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { assistantRequestOptions, replyText } from "@/lib/anthropic-reply";
import OpenAI from "openai";
import { spawn } from "child_process";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { getProvider, providerUnavailableMessage } from "@/lib/smart-provider";
import { DEFAULT_ASSISTANT_MODEL } from "@/lib/models";
import { runCodexText } from "@/lib/providers/codex-exec";
import { claudeCliText, reportAnthropicUsage, reportOpenAIUsage } from "@/lib/llm-usage-context";
import { traceLlmCall } from "@/lib/gen-ai-otel";

const SYSTEM_PROMPT = `You are a task-definition assistant for an AI coding and automation agent. Your job is to rewrite vague or incomplete task descriptions into clear, detailed, actionable instructions that an autonomous agent can follow without ambiguity.

A great agent description should include:
- The exact goal and deliverable (what "done" looks like)
- Step-by-step approach or key steps the agent should take
- Specific files, directories, or components to touch (if code-related)
- Constraints: things the agent must NOT do, limits on scope, style guidelines
- How to verify success (tests to run, output to check, etc.)

Rules:
- Preserve the intent of the original description — do not change what the task is about
- Be specific and concrete — avoid vague language like "handle errors" or "improve code"
- Write in imperative mood ("Add…", "Refactor…", "Ensure…")
- Keep the rewritten description under 300 words
- Output only the improved description — no commentary, no headers, no "Here is the improved version:"`;

function writeCliCredentials(configDir: string, credentialsJson: string): void {
  try {
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
    writeFileSync(`${configDir}/.credentials.json`, credentialsJson, { encoding: "utf8", mode: 0o600 });
  } catch { /* non-fatal */ }
}

function buildUserMessage(title: string, description: string): string {
  return `Task Title: ${title}\n\nCurrent Description:\n${description}\n\nRewrite the description to be more detailed and actionable:`;
}

async function runWithCli(
  title: string, description: string,
  configDir?: string, model?: string, credentialsJson?: string, providerType?: string,
): Promise<string> {
  const prompt = `${SYSTEM_PROMPT}\n\n${buildUserMessage(title, description)}`;
  // Codex writes its own auth.json inside runCodexText; writeCliCredentials targets the Claude CLI's format.
  if (providerType === "codex-cli") {
    return runCodexText(prompt, { configDir, model, credentialsJson });
  }
  if (configDir && credentialsJson) writeCliCredentials(configDir, credentialsJson);

  return new Promise((resolve, reject) => {
    const args = ["-p", prompt, "--output-format", "json", "--tools", ""];
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
        const detail = (stderr || output).trim();
        reject(new Error(detail || `Claude CLI exited with code ${code}`));
      } else {
        resolve(output.trim());
      }
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      const msg = err.code === "ENOENT"
        ? "Claude CLI not found. Make sure it is installed and on your PATH."
        : `Failed to start Claude CLI: ${err.message}`;
      reject(new Error(msg));
    });
  });
}

async function runWithApi(
  title: string, description: string,
  apiKey: string, baseURL?: string, model?: string,
): Promise<string> {
  const client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
  const response = await client.messages.create({
    model: model ?? DEFAULT_ASSISTANT_MODEL,
    ...assistantRequestOptions(model ?? DEFAULT_ASSISTANT_MODEL, 600),
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: buildUserMessage(title, description) }],
  });
  reportAnthropicUsage(response);
  return replyText(response);
}

async function runWithOpenAI(
  title: string, description: string,
  apiKey: string, baseURL?: string, model?: string,
): Promise<string> {
  const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  const response = await client.chat.completions.create({
    model: model ?? "gpt-4o",
    max_tokens: 600,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserMessage(title, description) },
    ],
  });
  reportOpenAIUsage(response);
  return response.choices[0].message.content?.trim() ?? "";
}

export async function POST(req: NextRequest) {
  const body = await req.json() as { title?: string; description?: string; providerId?: string };
  const { title, description, providerId } = body;

  if (!title?.trim() || !description?.trim()) {
    return NextResponse.json({ error: "title and description are required" }, { status: 400 });
  }

  const { provider, throttledFallback } = await getProvider({ explicitProviderId: providerId });

  if (!provider) {
    return NextResponse.json({ error: providerUnavailableMessage(throttledFallback) }, { status: 400 });
  }

  try {
    let enhanced: string;
    const model = provider.model ?? undefined;

    if (provider.type === "api") {
      const apiKey = provider.apiKey || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return NextResponse.json({ error: "No API key configured for this provider." }, { status: 400 });
      enhanced = await traceLlmCall({ feature: "enhance-description", provider }, () => runWithApi(title, description, apiKey, provider.baseUrl ?? undefined, model));
    } else if (provider.type === "openai") {
      const apiKey = provider.apiKey || process.env.OPENAI_API_KEY;
      if (!apiKey) return NextResponse.json({ error: "No API key configured for this provider." }, { status: 400 });
      enhanced = await traceLlmCall({ feature: "enhance-description", provider }, () => runWithOpenAI(title, description, apiKey, provider.baseUrl ?? undefined, model));
    } else {
      enhanced = await traceLlmCall({ feature: "enhance-description", provider }, () => runWithCli(title, description, provider.configDir ?? undefined, model, provider.credentialsJson ?? undefined, provider.type));
    }

    return NextResponse.json({ description: enhanced });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Description enhancement failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
