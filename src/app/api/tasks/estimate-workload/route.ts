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

const SYSTEM_PROMPT = `You are a workload estimator for an AI coding/automation agent. Given a task title and description, classify complexity and estimate how long it will take an AI agent to complete.

Complexity levels:
- "quick": Trivial change, one-liner fix, config tweak, simple lookup. Typically < 5 minutes, < 3 tool calls.
- "medium": Adding a component, refactoring a function, moderate research, multi-step but straightforward. Typically 5–20 minutes.
- "complex": Multi-file refactor, new subsystem, architectural decision, extensive research or testing required. Typically 20–60+ minutes.

Respond ONLY with a JSON object — no prose, no markdown, no code fences:
{"complexity": "quick"|"medium"|"complex", "minMinutes": <integer>, "maxMinutes": <integer>, "reasoning": "<one sentence>"}

The minMinutes/maxMinutes should reflect realistic AI-agent execution time (not human time).`;

function writeCliCredentials(configDir: string, credentialsJson: string): void {
  try {
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
    writeFileSync(`${configDir}/.credentials.json`, credentialsJson, { encoding: "utf8", mode: 0o600 });
  } catch { /* non-fatal */ }
}

function buildUserMessage(title: string, description: string): string {
  return `Task Title: ${title}\n\nTask Description:\n${description}\n\nEstimate workload:`;
}

interface WorkloadResult {
  complexity: "quick" | "medium" | "complex";
  minMinutes: number;
  maxMinutes: number;
  reasoning: string;
}

function parseWorkloadResponse(raw: string): WorkloadResult | null {
  try {
    const cleaned = raw.trim().replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    const parsed = JSON.parse(cleaned) as Partial<WorkloadResult>;
    if (!["quick", "medium", "complex"].includes(parsed.complexity ?? "")) return null;
    if (typeof parsed.minMinutes !== "number" || typeof parsed.maxMinutes !== "number") return null;
    return {
      complexity: parsed.complexity as WorkloadResult["complexity"],
      minMinutes: Math.max(1, Math.round(parsed.minMinutes)),
      maxMinutes: Math.max(1, Math.round(parsed.maxMinutes)),
      reasoning: parsed.reasoning ?? "",
    };
  } catch {
    return null;
  }
}

async function runWithCli(
  title: string, description: string,
  configDir?: string, model?: string, credentialsJson?: string, providerType?: string,
): Promise<WorkloadResult> {
  const prompt = `${SYSTEM_PROMPT}\n\n${buildUserMessage(title, description)}`;
  // Codex writes its own auth.json inside runCodexText; writeCliCredentials targets the Claude CLI's format.
  if (providerType === "codex-cli") {
    const raw = await runCodexText(prompt, { configDir, model, credentialsJson });
    const result = parseWorkloadResponse(raw);
    if (!result) throw new Error("Could not parse workload estimate from AI response");
    return result;
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
        const result = parseWorkloadResponse(output.trim());
        if (!result) reject(new Error("Could not parse workload estimate from AI response"));
        else resolve(result);
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
): Promise<WorkloadResult> {
  const client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
  const response = await client.messages.create({
    model: model ?? DEFAULT_ASSISTANT_MODEL,
    ...assistantRequestOptions(model ?? DEFAULT_ASSISTANT_MODEL, 200),
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: buildUserMessage(title, description) }],
  });
  reportAnthropicUsage(response);
  const raw = replyText(response);
  const result = parseWorkloadResponse(raw);
  if (!result) throw new Error("Could not parse workload estimate from AI response");
  return result;
}

async function runWithOpenAI(
  title: string, description: string,
  apiKey: string, baseURL?: string, model?: string,
): Promise<WorkloadResult> {
  const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  const response = await client.chat.completions.create({
    model: model ?? "gpt-4o",
    max_tokens: 200,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserMessage(title, description) },
    ],
  });
  reportOpenAIUsage(response);
  const raw = response.choices[0].message.content?.trim() ?? "";
  const result = parseWorkloadResponse(raw);
  if (!result) throw new Error("Could not parse workload estimate from AI response");
  return result;
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
    let result: WorkloadResult;
    const model = provider.model ?? undefined;

    if (provider.type === "api") {
      const apiKey = provider.apiKey || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return NextResponse.json({ error: "No API key configured for this provider." }, { status: 400 });
      result = await traceLlmCall({ feature: "estimate-workload", provider }, () => runWithApi(title, description, apiKey, provider.baseUrl ?? undefined, model));
    } else if (provider.type === "openai") {
      const apiKey = provider.apiKey || process.env.OPENAI_API_KEY;
      if (!apiKey) return NextResponse.json({ error: "No API key configured for this provider." }, { status: 400 });
      result = await traceLlmCall({ feature: "estimate-workload", provider }, () => runWithOpenAI(title, description, apiKey, provider.baseUrl ?? undefined, model));
    } else {
      result = await traceLlmCall({ feature: "estimate-workload", provider }, () => runWithCli(title, description, provider.configDir ?? undefined, model, provider.credentialsJson ?? undefined, provider.type));
    }

    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Workload estimation failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
