import { NextRequest, NextResponse } from "next/server";
import { memberLogPrefix } from "@/lib/team-progress";
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

const VERIFY_SYSTEM = `You are a task-completion verifier for an AI agent execution system. A Claude AI agent ran a task and marked it as completed. Your job is to assess whether the task objectives were actually fulfilled based on the task description and execution logs.

Format your response with these exact headings (use **bold** markdown):

**Verdict**: "Complete" if all objectives appear met, "Partial" if only some were met, or "Unclear" if the logs do not provide enough evidence.
**Evidence**: 2-3 sentences citing specific log entries or actions that support the verdict.
**Gaps** (optional): If the verdict is not "Complete", list any objectives that appear unaddressed or incomplete.

Be objective and evidence-based. Do not assume work was done that isn't reflected in the logs.`;

function writeCliCredentials(configDir: string, credentialsJson: string): void {
  try {
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
    writeFileSync(`${configDir}/.credentials.json`, credentialsJson, { encoding: "utf8", mode: 0o600 });
  } catch { /* non-fatal */ }
}

function buildUserMessage(title: string, description: string, context: string | null, logText: string): string {
  return `Task Title: ${title}
Task Description: ${description}
${context ? `\nTask Context:\n${context}` : ""}

Execution Logs (recent entries):
${logText}

Please verify whether all task objectives were completed.`;
}

async function runWithCli(
  title: string, description: string, context: string | null, logText: string,
  configDir?: string, model?: string, credentialsJson?: string, providerType?: string,
): Promise<string> {
  const prompt = `${VERIFY_SYSTEM}\n\n${buildUserMessage(title, description, context, logText)}`;
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
  title: string, description: string, context: string | null, logText: string,
  apiKey: string, baseURL?: string, model?: string,
): Promise<string> {
  const client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
  const response = await client.messages.create({
    model: model ?? DEFAULT_ASSISTANT_MODEL,
    ...assistantRequestOptions(model ?? DEFAULT_ASSISTANT_MODEL, 700),
    system: [{ type: "text", text: VERIFY_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: buildUserMessage(title, description, context, logText) }],
  });
  reportAnthropicUsage(response);
  return replyText(response);
}

async function runWithOpenAI(
  title: string, description: string, context: string | null, logText: string,
  apiKey: string, baseURL?: string, model?: string,
): Promise<string> {
  const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  const response = await client.chat.completions.create({
    model: model ?? "gpt-4o",
    max_tokens: 700,
    messages: [
      { role: "system", content: VERIFY_SYSTEM },
      { role: "user", content: buildUserMessage(title, description, context, logText) },
    ],
  });
  reportOpenAIUsage(response);
  return response.choices[0].message.content?.trim() ?? "";
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const task = await prisma.task.findUnique({ where: { id } });
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
  if (task.status !== "completed") {
    return NextResponse.json({ error: "Only completed tasks can be verified" }, { status: 400 });
  }

  // Collect the most recent logs for the verification
  const logs = await prisma.taskLog.findMany({
    where: { taskId: id },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { content: true, level: true, member: true },
  });
  const logText = logs
    .reverse()
    .map((l: { level: string; content: string; member: string | null }) => {
      const label = l.level === "error" ? "[ERROR]" : l.level === "system" ? "[SYSTEM]" : l.level === "user" ? "[USER]" : "[AI]";
      return `${label} ${memberLogPrefix(l.member)}${l.content}`;
    })
    .join("\n");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { provider: aiProviderRecord, throttledFallback } = await getProvider({ explicitProviderId: (task as any).aiProviderId });

  if (!aiProviderRecord) {
    return NextResponse.json({ error: providerUnavailableMessage(throttledFallback) }, { status: 400 });
  }

  try {
    let assessment: string;
    const model = aiProviderRecord.model ?? undefined;
    const context = (task as unknown as { context?: string | null }).context ?? null;

    if (aiProviderRecord.type === "api") {
      const apiKey = aiProviderRecord.apiKey || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return NextResponse.json({ error: "No API key configured for this provider." }, { status: 400 });
      assessment = await traceLlmCall({ feature: "verify", provider: aiProviderRecord }, () => runWithApi(task.title, task.description, context, logText, apiKey, aiProviderRecord.baseUrl ?? undefined, model));
    } else if (aiProviderRecord.type === "openai") {
      const apiKey = aiProviderRecord.apiKey || process.env.OPENAI_API_KEY;
      if (!apiKey) return NextResponse.json({ error: "No API key configured for this provider." }, { status: 400 });
      assessment = await traceLlmCall({ feature: "verify", provider: aiProviderRecord }, () => runWithOpenAI(task.title, task.description, context, logText, apiKey, aiProviderRecord.baseUrl ?? undefined, model));
    } else {
      assessment = await traceLlmCall({ feature: "verify", provider: aiProviderRecord }, () => runWithCli(
        task.title, task.description, context, logText,
        aiProviderRecord.configDir ?? undefined, model, aiProviderRecord.credentialsJson ?? undefined, aiProviderRecord.type,
      ));
    }

    return NextResponse.json({ assessment });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Verification failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
