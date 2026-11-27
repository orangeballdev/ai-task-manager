import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { assistantRequestOptions, replyText } from "@/lib/anthropic-reply";
import OpenAI from "openai";
import { spawn } from "child_process";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { getProvider, providerUnavailableMessage } from "@/lib/smart-provider";
import { runCodexText } from "@/lib/providers/codex-exec";
import { claudeCliText, reportAnthropicUsage, reportOpenAIUsage } from "@/lib/llm-usage-context";
import { traceLlmCall } from "@/lib/gen-ai-otel";

const SYSTEM_PROMPT = `You are a cron expression generator. Convert natural language schedule descriptions into standard 5-field cron expressions (minute hour day-of-month month day-of-week).

Rules:
- Output ONLY the cron expression with no explanation, no backticks, no quotes — just the bare expression like: 0 9 * * 1-5
- Use 5 fields: minute hour day-of-month month day-of-week
- Days of week: 0=Sunday, 1=Monday, …, 6=Saturday (or use names like MON, FRI)
- If the description is ambiguous, pick the most sensible interpretation
- If you cannot produce a valid cron expression from the input, output only the word: INVALID`;

function writeCliCredentials(configDir: string, credentialsJson: string): void {
  try {
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
    writeFileSync(`${configDir}/.credentials.json`, credentialsJson, { encoding: "utf8", mode: 0o600 });
  } catch { /* non-fatal */ }
}

async function runWithCli(
  text: string, configDir?: string, model?: string, credentialsJson?: string, providerType?: string,
): Promise<string> {
  const prompt = `${SYSTEM_PROMPT}\n\nSchedule: ${text}\nCron expression:`;
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
  text: string, apiKey: string, baseURL?: string, model?: string,
): Promise<string> {
  const client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
  const response = await client.messages.create({
    model: model ?? "claude-haiku-4-5",
    ...assistantRequestOptions(model ?? "claude-haiku-4-5", 50),
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: `Schedule: ${text}\nCron expression:` }],
  });
  reportAnthropicUsage(response);
  return replyText(response);
}

async function runWithOpenAI(
  text: string, apiKey: string, baseURL?: string, model?: string,
): Promise<string> {
  const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  const response = await client.chat.completions.create({
    model: model ?? "gpt-4o-mini",
    max_tokens: 50,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Schedule: ${text}\nCron expression:` },
    ],
  });
  reportOpenAIUsage(response);
  return response.choices[0].message.content?.trim() ?? "";
}

function isValidCronExpression(expr: string): boolean {
  if (expr === "INVALID") return false;
  const parts = expr.trim().split(/\s+/);
  return parts.length === 5;
}

export async function POST(req: NextRequest) {
  const body = await req.json() as { text?: string; providerId?: string };
  const { text, providerId } = body;

  if (!text?.trim()) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }

  const { provider, throttledFallback } = await getProvider({ explicitProviderId: providerId });

  if (!provider) {
    return NextResponse.json({ error: providerUnavailableMessage(throttledFallback) }, { status: 400 });
  }

  try {
    let cronExpression: string;
    const model = provider.model ?? undefined;

    if (provider.type === "api") {
      const apiKey = provider.apiKey || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return NextResponse.json({ error: "No API key configured for this provider." }, { status: 400 });
      cronExpression = await traceLlmCall({ feature: "cron-from-text", provider }, () => runWithApi(text, apiKey, provider.baseUrl ?? undefined, model));
    } else if (provider.type === "openai") {
      const apiKey = provider.apiKey || process.env.OPENAI_API_KEY;
      if (!apiKey) return NextResponse.json({ error: "No API key configured for this provider." }, { status: 400 });
      cronExpression = await traceLlmCall({ feature: "cron-from-text", provider }, () => runWithOpenAI(text, apiKey, provider.baseUrl ?? undefined, model));
    } else {
      cronExpression = await traceLlmCall({ feature: "cron-from-text", provider }, () => runWithCli(text, provider.configDir ?? undefined, model, provider.credentialsJson ?? undefined, provider.type));
    }

    if (!isValidCronExpression(cronExpression)) {
      return NextResponse.json({ error: `Could not generate a valid cron expression from: "${text}"` }, { status: 422 });
    }

    return NextResponse.json({ cronExpression: cronExpression.trim() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Cron generation failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
