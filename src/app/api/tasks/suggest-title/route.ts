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

const SYSTEM_PROMPT = `You are a task-naming assistant. Given a task description (and optionally existing context), write a concise, descriptive title for an AI coding or automation task.

Rules:
- 4–10 words maximum
- Use imperative mood ("Add…", "Fix…", "Refactor…", "Implement…", "Create…")
- Be specific — name the actual feature, bug, or component
- No punctuation at the end
- No generic titles like "Complete task" or "Fix bug"
- Output only the title text — no commentary, quotes, or explanation`;

function writeCliCredentials(configDir: string, credentialsJson: string): void {
  try {
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
    writeFileSync(`${configDir}/.credentials.json`, credentialsJson, { encoding: "utf8", mode: 0o600 });
  } catch { /* non-fatal */ }
}

function buildUserMessage(description: string, context?: string): string {
  let msg = `Task Description:\n${description}`;
  if (context?.trim()) msg += `\n\nAdditional Context:\n${context.trim()}`;
  msg += "\n\nWrite a concise title:";
  return msg;
}

async function runWithCli(
  description: string, context: string | undefined,
  configDir?: string, model?: string, credentialsJson?: string, providerType?: string,
): Promise<string> {
  const prompt = `${SYSTEM_PROMPT}\n\n${buildUserMessage(description, context)}`;
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
  description: string, context: string | undefined,
  apiKey: string, baseURL?: string, model?: string,
): Promise<string> {
  const client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
  const response = await client.messages.create({
    model: model ?? DEFAULT_ASSISTANT_MODEL,
    ...assistantRequestOptions(model ?? DEFAULT_ASSISTANT_MODEL, 60),
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: buildUserMessage(description, context) }],
  });
  reportAnthropicUsage(response);
  return replyText(response);
}

async function runWithOpenAI(
  description: string, context: string | undefined,
  apiKey: string, baseURL?: string, model?: string,
): Promise<string> {
  const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  const response = await client.chat.completions.create({
    model: model ?? "gpt-4o",
    max_tokens: 60,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserMessage(description, context) },
    ],
  });
  reportOpenAIUsage(response);
  return response.choices[0].message.content?.trim() ?? "";
}

export async function POST(req: NextRequest) {
  const body = await req.json() as { description?: string; context?: string; providerId?: string };
  const { description, context, providerId } = body;

  if (!description?.trim()) {
    return NextResponse.json({ error: "description is required" }, { status: 400 });
  }

  const { provider, throttledFallback } = await getProvider({ explicitProviderId: providerId });

  if (!provider) {
    return NextResponse.json({ error: providerUnavailableMessage(throttledFallback) }, { status: 400 });
  }

  try {
    let title: string;
    const model = provider.model ?? undefined;

    if (provider.type === "api") {
      const apiKey = provider.apiKey || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return NextResponse.json({ error: "No API key configured for this provider." }, { status: 400 });
      title = await traceLlmCall({ feature: "suggest-title", provider }, () => runWithApi(description, context, apiKey, provider.baseUrl ?? undefined, model));
    } else if (provider.type === "openai") {
      const apiKey = provider.apiKey || process.env.OPENAI_API_KEY;
      if (!apiKey) return NextResponse.json({ error: "No API key configured for this provider." }, { status: 400 });
      title = await traceLlmCall({ feature: "suggest-title", provider }, () => runWithOpenAI(description, context, apiKey, provider.baseUrl ?? undefined, model));
    } else {
      title = await traceLlmCall({ feature: "suggest-title", provider }, () => runWithCli(description, context, provider.configDir ?? undefined, model, provider.credentialsJson ?? undefined, provider.type));
    }

    return NextResponse.json({ title });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Title suggestion failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
