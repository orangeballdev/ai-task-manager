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

const SYSTEM_PROMPT = `You are a task-cost estimator for an AI coding/automation agent. Given a task title and description, estimate an appropriate USD cost budget.

Rules:
- A typical simple fix (one-liner, config change) costs ~$0.05–$0.20
- A medium feature (add a component, refactor a function) costs ~$0.20–$1.00
- A complex feature (multi-file refactor, new subsystem, research + implementation) costs ~$1.00–$5.00
- Very large tasks (full feature set, architectural changes) may cost $5.00–$15.00

Consider:
- Number of files likely touched
- Whether the task requires reading and understanding a large codebase
- Whether multiple iterations/tool calls are expected
- The inherent complexity of the described work

Respond ONLY with a JSON object — no prose, no markdown, no code fences:
{"costBudget": <number with 2 decimal places>, "reasoning": "<one sentence explaining the estimate>"}`;

function writeCliCredentials(configDir: string, credentialsJson: string): void {
  try {
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
    writeFileSync(`${configDir}/.credentials.json`, credentialsJson, { encoding: "utf8", mode: 0o600 });
  } catch { /* non-fatal */ }
}

function buildUserMessage(title: string, description: string): string {
  return `Task Title: ${title}\n\nTask Description:\n${description}\n\nEstimate cost budget:`;
}

function parseBudgetResponse(raw: string): { costBudget: number; reasoning: string } | null {
  try {
    // Strip markdown code fences if present
    const cleaned = raw.trim().replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    const parsed = JSON.parse(cleaned) as { costBudget: number; reasoning: string };
    if (typeof parsed.costBudget !== "number" || parsed.costBudget <= 0) return null;
    return { costBudget: Math.round(parsed.costBudget * 100) / 100, reasoning: parsed.reasoning ?? "" };
  } catch {
    return null;
  }
}

async function runWithCli(
  title: string, description: string,
  configDir?: string, model?: string, credentialsJson?: string, providerType?: string,
): Promise<{ costBudget: number; reasoning: string }> {
  const prompt = `${SYSTEM_PROMPT}\n\n${buildUserMessage(title, description)}`;
  // Codex writes its own auth.json inside runCodexText; writeCliCredentials targets the Claude CLI's format.
  if (providerType === "codex-cli") {
    const raw = await runCodexText(prompt, { configDir, model, credentialsJson });
    const result = parseBudgetResponse(raw);
    if (!result) throw new Error("Could not parse budget from AI response");
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
        const result = parseBudgetResponse(output.trim());
        if (!result) reject(new Error("Could not parse budget from AI response"));
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
): Promise<{ costBudget: number; reasoning: string }> {
  const client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
  const response = await client.messages.create({
    model: model ?? DEFAULT_ASSISTANT_MODEL,
    ...assistantRequestOptions(model ?? DEFAULT_ASSISTANT_MODEL, 200),
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: buildUserMessage(title, description) }],
  });
  reportAnthropicUsage(response);
  const raw = replyText(response);
  const result = parseBudgetResponse(raw);
  if (!result) throw new Error("Could not parse budget from AI response");
  return result;
}

async function runWithOpenAI(
  title: string, description: string,
  apiKey: string, baseURL?: string, model?: string,
): Promise<{ costBudget: number; reasoning: string }> {
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
  const result = parseBudgetResponse(raw);
  if (!result) throw new Error("Could not parse budget from AI response");
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
    let result: { costBudget: number; reasoning: string };
    const model = provider.model ?? undefined;

    if (provider.type === "api") {
      const apiKey = provider.apiKey || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return NextResponse.json({ error: "No API key configured for this provider." }, { status: 400 });
      result = await traceLlmCall({ feature: "suggest-budget", provider }, () => runWithApi(title, description, apiKey, provider.baseUrl ?? undefined, model));
    } else if (provider.type === "openai") {
      const apiKey = provider.apiKey || process.env.OPENAI_API_KEY;
      if (!apiKey) return NextResponse.json({ error: "No API key configured for this provider." }, { status: 400 });
      result = await traceLlmCall({ feature: "suggest-budget", provider }, () => runWithOpenAI(title, description, apiKey, provider.baseUrl ?? undefined, model));
    } else {
      result = await traceLlmCall({ feature: "suggest-budget", provider }, () => runWithCli(title, description, provider.configDir ?? undefined, model, provider.credentialsJson ?? undefined, provider.type));
    }

    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Budget suggestion failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
