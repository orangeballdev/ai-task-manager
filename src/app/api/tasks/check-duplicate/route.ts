import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { assistantRequestOptions, replyText } from "@/lib/anthropic-reply";
import OpenAI from "openai";
import { spawn } from "child_process";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { prisma } from "@/lib/db";
import { getProvider, providerUnavailableMessage } from "@/lib/smart-provider";
import { DEFAULT_ASSISTANT_MODEL } from "@/lib/models";
import { runCodexText } from "@/lib/providers/codex-exec";
import { claudeCliText, reportAnthropicUsage, reportOpenAIUsage } from "@/lib/llm-usage-context";
import { traceLlmCall } from "@/lib/gen-ai-otel";

const SYSTEM_PROMPT = `You are a duplicate-detection assistant for a task management system. Given a new task and a list of existing tasks, identify any that are semantically similar or likely to produce duplicate or conflicting work.

For each potential duplicate found, respond with a JSON array of objects with these keys:
- "id": the exact task id from the list
- "title": the task title
- "reason": a single sentence explaining why it might be a duplicate

Return ONLY a valid JSON array. If no duplicates are found, return an empty array [].
Keep your analysis brief — do not explain your reasoning outside of the "reason" field.`;

function writeCliCredentials(configDir: string, credentialsJson: string): void {
  try {
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
    writeFileSync(`${configDir}/.credentials.json`, credentialsJson, { encoding: "utf8", mode: 0o600 });
  } catch { /* non-fatal */ }
}

interface ExistingTask { id: string; title: string; description: string; status: string }

function buildUserMessage(title: string, description: string, existingTasks: ExistingTask[]): string {
  const taskList = existingTasks
    .map((t) => `ID: ${t.id}\nTitle: ${t.title}\nDescription: ${t.description}\nStatus: ${t.status}`)
    .join("\n---\n");
  return `New task to check:
Title: ${title}
Description: ${description}

Existing tasks:
${taskList}

Return a JSON array of any duplicates found (empty array if none).`;
}

async function runWithCli(
  title: string, description: string, existingTasks: ExistingTask[],
  configDir?: string, model?: string, credentialsJson?: string, providerType?: string,
): Promise<string> {
  const prompt = `${SYSTEM_PROMPT}\n\n${buildUserMessage(title, description, existingTasks)}`;
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
  title: string, description: string, existingTasks: ExistingTask[],
  apiKey: string, baseURL?: string, model?: string,
): Promise<string> {
  const client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
  const response = await client.messages.create({
    model: model ?? DEFAULT_ASSISTANT_MODEL,
    ...assistantRequestOptions(model ?? DEFAULT_ASSISTANT_MODEL, 600),
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: buildUserMessage(title, description, existingTasks) }],
  });
  reportAnthropicUsage(response);
  return replyText(response);
}

async function runWithOpenAI(
  title: string, description: string, existingTasks: ExistingTask[],
  apiKey: string, baseURL?: string, model?: string,
): Promise<string> {
  const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  const response = await client.chat.completions.create({
    model: model ?? "gpt-4o",
    max_tokens: 600,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserMessage(title, description, existingTasks) },
    ],
  });
  reportOpenAIUsage(response);
  return response.choices[0].message.content?.trim() ?? "";
}

function parseResult(raw: string): { id: string; title: string; reason: string }[] {
  try {
    // Extract JSON array from the response (model might add prose around it)
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];
    return JSON.parse(match[0]) as { id: string; title: string; reason: string }[];
  } catch {
    return [];
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json() as { title?: string; description?: string; providerId?: string; excludeId?: string };
  const { title, description, providerId, excludeId } = body;

  if (!title?.trim() || !description?.trim()) {
    return NextResponse.json({ error: "title and description are required" }, { status: 400 });
  }

  // Fetch active + recent tasks to compare against
  const existingTasks = await prisma.task.findMany({
    where: {
      isRecurringTemplate: false,
      status: { in: ["pending", "running", "paused", "throttled", "completed", "no_changes"] },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true, title: true, description: true, status: true },
    orderBy: { createdAt: "desc" },
    take: 30,
  });

  if (existingTasks.length === 0) {
    return NextResponse.json({ duplicates: [] });
  }

  const { provider, throttledFallback } = await getProvider({ explicitProviderId: providerId });

  if (!provider) {
    return NextResponse.json({ error: providerUnavailableMessage(throttledFallback) }, { status: 400 });
  }

  try {
    let rawResult: string;
    const model = provider.model ?? undefined;

    if (provider.type === "api") {
      const apiKey = provider.apiKey || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return NextResponse.json({ error: "No API key configured for this provider." }, { status: 400 });
      rawResult = await traceLlmCall({ feature: "check-duplicate", provider }, () => runWithApi(title, description, existingTasks, apiKey, provider.baseUrl ?? undefined, model));
    } else if (provider.type === "openai") {
      const apiKey = provider.apiKey || process.env.OPENAI_API_KEY;
      if (!apiKey) return NextResponse.json({ error: "No API key configured for this provider." }, { status: 400 });
      rawResult = await traceLlmCall({ feature: "check-duplicate", provider }, () => runWithOpenAI(title, description, existingTasks, apiKey, provider.baseUrl ?? undefined, model));
    } else {
      rawResult = await traceLlmCall({ feature: "check-duplicate", provider }, () => runWithCli(title, description, existingTasks, provider.configDir ?? undefined, model, provider.credentialsJson ?? undefined, provider.type));
    }

    const duplicates = parseResult(rawResult);
    return NextResponse.json({ duplicates });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Duplicate check failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
