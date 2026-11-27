import { NextRequest, NextResponse } from "next/server";
import { buildPrompt, GENERAL_SYSTEM_PROMPT, CODING_SYSTEM_PROMPT, FILE_OUTPUT_SYSTEM_PROMPT, DESIGN_SYSTEM_PROMPT, RESULT_OUTPUT_SYSTEM_PROMPT } from "@/lib/prompt-builder";
import { isDesignOutput, isFileBasedOutput, isResultOutput, normalizeOutputType } from "@/lib/output-type";
import { prisma } from "@/lib/db";

/**
 * POST /api/tasks/preview-prompt
 *
 * Returns the exact system + user prompt that would be sent to the AI for a given task.
 * Accepts the same fields as POST /api/tasks, but does not create anything.
 *
 * Because repos are not cloned at preview time, CLAUDE.md content is omitted.
 * The response includes a note indicating this.
 */
export async function POST(req: NextRequest) {
  const body = await req.json() as {
    title?: string;
    description?: string;
    context?: string;
    labels?: string[];
    systemPrompt?: string;
    repos?: Array<{ alias: string; url: string }>;
    contextFiles?: Array<{ repoAlias: string; path: string }>;
    retryCount?: number;
    outputType?: string;
  };

  const { title, description, context, labels, systemPrompt, repos = [], contextFiles, retryCount = 0 } = body;
  const outputType = normalizeOutputType(body.outputType);

  if (!title?.trim() || !description?.trim()) {
    return NextResponse.json({ error: "title and description are required" }, { status: 400 });
  }

  // Build a minimal task object matching what buildPrompt() expects.
  // No file-system access needed since repos aren't cloned yet — CLAUDE.md sections
  // will simply be empty (the buildPrompt function handles missing files gracefully).
  // Context files can't be inlined at preview time (repos not cloned yet), so we
  // pass them through as-is; buildPrompt() will emit a "file not found or
  // unreadable" placeholder for each entry which serves as a preview marker.
  const fakeTask = {
    id: "preview",
    title,
    description,
    context: context ?? null,
    labels: labels && labels.length > 0 ? JSON.stringify(labels) : null,
    systemPrompt: systemPrompt?.trim() || null,
    attachments: null,
    outputType,
    contextFiles: Array.isArray(contextFiles) && contextFiles.length > 0
      ? JSON.stringify(contextFiles)
      : null,
    retryCount,
    repos: repos.map((r) => ({ alias: r.alias, url: r.url })),
  };

  const globalInstructionsSetting = await prisma.setting.findUnique({ where: { key: "global_agent_instructions" } });
  const globalInstructions = globalInstructionsSetting?.value?.trim() || undefined;

  // Best-effort approximation of what the worker will do: agent delegation guidance
  // only makes sense for the Claude CLI's native subagent tool, so mirror the worker's
  // gate here using the default provider's type (the actual provider is only resolved
  // at run time, so this can't be exact for tasks that override the provider).
  const agentDelegationSetting = await prisma.setting.findUnique({ where: { key: "agent_delegation_enabled" } });
  const agentDelegationEnabled = agentDelegationSetting?.value !== "false"; // default: on
  const defaultProvider = await prisma.aIProvider.findFirst({ where: { isDefault: true } });
  const enableAgentDelegation = agentDelegationEnabled && defaultProvider?.type === "cli";

  const { system, user } = await buildPrompt(fakeTask, retryCount > 0, undefined, globalInstructions, enableAgentDelegation);

  const hasRepos = repos.length > 0;
  const defaultSystem = isResultOutput(outputType)
    ? RESULT_OUTPUT_SYSTEM_PROMPT
    : isDesignOutput(outputType)
    ? DESIGN_SYSTEM_PROMPT
    : isFileBasedOutput(outputType)
      ? FILE_OUTPUT_SYSTEM_PROMPT
      : hasRepos ? CODING_SYSTEM_PROMPT : GENERAL_SYSTEM_PROMPT;
  const usingCustomPrompt = Boolean(systemPrompt?.trim());

  return NextResponse.json({
    system,
    user,
    meta: {
      hasRepos,
      usingCustomPrompt,
      defaultSystem,
      claudeMdNote: hasRepos
        ? "CLAUDE.md files from each repository will be loaded and injected at runtime, when the repos are cloned."
        : null,
    },
  });
}
