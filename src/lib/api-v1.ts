// Shared response shaping for the public API (src/app/api/v1/*). Keeping this in one
// place means every v1 route returns the same task shape, and internal-only columns
// (workspacePath, systemPrompt, prompt-builder internals, etc.) never leak into the
// public contract just because a new field got added to the Task model.
import type { Task, TaskRepo } from "@/generated/prisma/client";
import { readReviewMetadata, type ReviewMetadata } from "@/lib/review-only";

export interface PublicTaskRepo {
  alias: string;
  url: string;
  branch: string | null;
}

export interface PublicTask {
  id: string;
  title: string;
  description: string;
  context: string | null;
  status: string;
  outputType: string;
  priority: string;
  effort: string | null;
  /** Explicit per-task tool grants/denials; tools absent follow the global default. */
  toolAccess: Record<string, boolean> | null;
  /** Whether the agent may queue subtasks of its own. */
  allowSubtasks: boolean;
  /** Set on tasks that were created as a subtask of another task. */
  parentTaskId: string | null;
  repos: PublicTaskRepo[];
  branchName: string | null;
  commitSha: string | null;
  prUrl: string | null;
  prNumber: number | null;
  prUrls: Record<string, { url: string; number?: number; merged?: boolean }> | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCost: number | null;
  retryCount: number;
  labels: string[] | null;
  notes: string | null;
  /** In Review / Done state the board shows ("in_review", "done" or null). */
  reviewStatus: string | null;
  /** A review-only ticket: created straight into In Review, never runs an agent. */
  reviewOnly: boolean;
  /** Repo, branch, commit SHAs and PR link attached for review (any field may be empty). */
  reviewMetadata: ReviewMetadata;
  createdAt: string;
  updatedAt: string;
}

function safeJsonParse<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function serializeTask(task: Task & { repos?: TaskRepo[] }): PublicTask {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    context: task.context,
    status: task.status,
    outputType: task.outputType,
    priority: task.priority,
    effort: task.effort,
    toolAccess: safeJsonParse<Record<string, boolean>>(task.toolAccess),
    allowSubtasks: task.allowSubtasks,
    parentTaskId: task.parentTaskId,
    repos: (task.repos ?? []).map((r) => ({ alias: r.alias, url: r.url, branch: r.branch ?? null })),
    branchName: task.branchName,
    commitSha: task.commitSha,
    prUrl: task.prUrl,
    prNumber: task.prNumber,
    prUrls: safeJsonParse(task.prUrls),
    inputTokens: task.inputTokens,
    outputTokens: task.outputTokens,
    estimatedCost: task.estimatedCost,
    retryCount: task.retryCount,
    labels: safeJsonParse(task.labels),
    notes: task.notes,
    reviewStatus: task.reviewStatus,
    reviewOnly: task.reviewOnly,
    reviewMetadata: readReviewMetadata(task),
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}
