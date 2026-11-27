/**
 * "Ask this repo" chat.
 *
 * A read-only Q&A conversation scoped to a single repository. Unlike the
 * new-task chat (src/lib/chat.ts) this never proposes or creates anything — it
 * just answers questions about a codebase, grounded in a snapshot of the repo
 * produced by `POST /api/tasks/git-context` (directory tree + README + config
 * manifests + the highest-scoring source files).
 *
 * The snapshot is a *partial* view of the repo, so the system prompt leans hard
 * on "say when you're inferring": an answer that confidently invents a file that
 * isn't in the snapshot is worse than one that admits the snapshot is truncated.
 */

import Anthropic from "@anthropic-ai/sdk";
import { assistantRequestOptions, replyText } from "@/lib/anthropic-reply";
import OpenAI from "openai";
import { spawn } from "child_process";
import { runCodexText } from "@/lib/providers/codex-exec";
import { DEFAULT_ASSISTANT_MODEL } from "@/lib/models";
import { writeCliCredentials, type ChatMessage } from "@/lib/chat";
import { claudeCliText, reportAnthropicUsage, reportOpenAIUsage } from "./llm-usage-context";

export type { ChatMessage };

/** Assistant replies are rendered as markdown, so keep them formatted for it. */
export const REPO_CHAT_SYSTEM_PROMPT = `You are a senior engineer answering questions about ONE specific Git repository. The user is exploring or onboarding onto this codebase and wants fast, accurate, concrete answers.

How to answer:
- Answer the question directly first, then add detail. Lead with the conclusion, not a preamble.
- Be concrete: name actual files, directories, functions, routes, env vars and commands from the repository — never generic advice that would apply to any project.
- Reference file paths in backticks (e.g. \`src/lib/db.ts\`) so the user can jump straight to them.
- Use short paragraphs, bullet lists and fenced code blocks. Markdown is rendered.
- Keep it tight. A few sentences is usually the right length; go long only when the user asks for a walkthrough.

Grounding rules — these matter most:
- You have been given a SNAPSHOT of the repository, not the whole thing. It contains the directory tree, README, config/manifest files, and a handful of the most relevant source files (each possibly truncated).
- Base your answer on that snapshot. When something is visible in it, say so plainly.
- When the snapshot does not cover what was asked, say what you can see, then say explicitly that the relevant file isn't included in the snapshot — and name the file or directory the user should look at. Never invent file paths, APIs, dependencies or behaviour that aren't in the snapshot.
- Clearly separate "this is what the code does" from "this is what I'd guess/recommend".

You cannot run commands, browse the web, edit files or create tasks. If the user asks for a change to be made, explain what the change would involve and suggest they create a task for it from the New Task page.`;

export interface RepoChatTarget {
  /** Clone URL of the repository being discussed. */
  url: string;
  /** Display name (the repo's alias in this app). */
  alias?: string;
  /** The repo's saved "default context" from the Repositories page, if any. */
  defaultContext?: string;
  /** Snapshot from /api/tasks/git-context. */
  gitContext?: string;
}

export function buildRepoChatSystemPrompt(repo: RepoChatTarget): string {
  let prompt = REPO_CHAT_SYSTEM_PROMPT;

  prompt += `\n\n---\n\n## Repository\n\n${repo.alias ? `Name: ${repo.alias}\n` : ""}Clone URL: ${repo.url}`;

  if (repo.defaultContext?.trim()) {
    prompt += `\n\n---\n\n## Notes the user keeps about this repository\n\nThese are the user's own standing notes for this repo (its "default context" in this app). Treat them as authoritative — they may state conventions or constraints that aren't visible in the code snapshot.\n\n${repo.defaultContext.trim()}`;
  }

  if (repo.gitContext?.trim()) {
    prompt += `\n\n---\n\n## Repository snapshot\n\n${repo.gitContext.trim()}`;
  } else {
    prompt += `\n\n---\n\n## Repository snapshot\n\nNo snapshot could be loaded for this repository (the clone may have failed, or it is still loading). Tell the user you don't have the code in front of you and answer only what can be answered from the repository name/URL and their notes above — do not guess at its contents.`;
  }

  return prompt;
}

const MAX_REPLY_TOKENS = 2048;

export async function runRepoChatWithCli(
  messages: ChatMessage[],
  repo: RepoChatTarget,
  configDir?: string,
  model?: string,
  credentialsJson?: string,
  providerType?: string,
): Promise<{ reply: string }> {
  const conversation = messages
    .map((m) => `${m.role === "user" ? "Human" : "Assistant"}: ${m.content}`)
    .join("\n\n");
  // The repo snapshot dominates the prompt (often 10KB+) and is byte-for-byte
  // identical across every turn of the conversation, so it's passed via
  // --system-prompt rather than folded into the growing `-p` text. That lets
  // the Anthropic API serve it from cache on turn 2+ instead of re-billing the
  // whole snapshot as fresh input tokens on every question the user asks.
  const systemPrompt = buildRepoChatSystemPrompt(repo);
  const prompt = `Conversation so far:\n${conversation}\n\nAssistant:`;

  // Codex is a different binary with a different flag set and its own auth file, and it
  // runs sandboxed read-only here — same guarantee `--tools ""` gives the Claude CLI.
  if (providerType === "codex-cli") {
    const reply = await runCodexText(`${systemPrompt}\n\n${prompt}`, { configDir, model, credentialsJson });
    return { reply: reply.trim() };
  }
  if (configDir && credentialsJson) writeCliCredentials(configDir, credentialsJson);

  return new Promise((resolve, reject) => {
    // --tools "" keeps this strictly a text Q&A: the repo isn't checked out
    // anywhere the CLI could read, and this endpoint must never be able to
    // mutate anything (create tasks, hit the local API, touch the filesystem).
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
      resolve({ reply: output.trim() });
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      const msg = err.code === "ENOENT"
        ? "Claude CLI not found. Install it from https://claude.ai/download and make sure it is on your PATH."
        : `Failed to start Claude CLI: ${err.message}`;
      reject(new Error(msg));
    });
  });
}

export async function runRepoChatWithApi(
  messages: ChatMessage[],
  repo: RepoChatTarget,
  apiKey: string,
  baseURL?: string,
  model?: string,
): Promise<{ reply: string }> {
  const client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });

  const response = await client.messages.create({
    model: model ?? DEFAULT_ASSISTANT_MODEL,
    ...assistantRequestOptions(model ?? DEFAULT_ASSISTANT_MODEL, MAX_REPLY_TOKENS, "medium"),
    // The snapshot dominates the prompt and is identical for every turn of the
    // conversation, so cache it rather than re-billing it on each question.
    system: [{ type: "text", text: buildRepoChatSystemPrompt(repo), cache_control: { type: "ephemeral" } }],
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  });
  reportAnthropicUsage(response);

  const reply = replyText(response);

  return { reply };
}

export async function runRepoChatWithOpenAI(
  messages: ChatMessage[],
  repo: RepoChatTarget,
  apiKey: string,
  baseURL?: string,
  model?: string,
): Promise<{ reply: string }> {
  const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });

  const response = await client.chat.completions.create({
    model: model ?? "gpt-4o",
    max_tokens: MAX_REPLY_TOKENS,
    messages: [
      { role: "system", content: buildRepoChatSystemPrompt(repo) },
      ...messages.map((m) => ({ role: m.role, content: m.content })),
    ],
  });
  reportOpenAIUsage(response);

  return { reply: response.choices[0]?.message.content?.trim() ?? "" };
}
