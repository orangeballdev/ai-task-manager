"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, ChevronDown, Copy, FileDown, FolderOpen, GitPullRequest, Loader2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { buttonVariants } from "@/components/ui/button";
import { getAnalytics } from "@/components/WebAnalytics";

interface TaskActionsDropdownProps {
  taskId: string;
  taskStatus: string;
  isTerminalTask: boolean;
  // Secondary navigation actions — kept in the dropdown rather than the
  // primary button row to reduce visual clutter on the task detail page.
  isRecurringTemplate?: boolean;
  outputType?: string | null;
  // Export data
  title: string;
  description: string;
  context?: string | null;
  notes?: string | null;
  labels?: string | null;
  prSummary?: string | null;
  prUrl?: string | null;
  branchName?: string | null;
  createdAt: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  estimatedCost?: number | null;
  providerName?: string | null;
  model?: string | null;
  repos?: Array<{ alias: string; url: string }>;
  lastAiMessage?: { content: string; createdAt: string } | null;
}

export function TaskActionsDropdown({
  taskId,
  taskStatus,
  isTerminalTask,
  isRecurringTemplate,
  outputType,
  title,
  description,
  context,
  notes,
  labels,
  prSummary,
  prUrl,
  branchName,
  createdAt,
  inputTokens,
  outputTokens,
  estimatedCost,
  providerName,
  model,
  repos,
  lastAiMessage,
}: TaskActionsDropdownProps) {
  const router = useRouter();
  const [reviewingPr, setReviewingPr] = useState(false);
  const isCompleted = taskStatus === "completed";
  const showBrowseWorkspace = !isRecurringTemplate && outputType !== "file";
  // Only offer "Review PR" for completed tasks that actually have a pull request open —
  // it re-runs the agent on the existing branch to review its own PR, make any necessary
  // changes, and post a review comment, so there has to be a PR for it to comment on.
  const canReviewPr = isCompleted && Boolean(prUrl);

  // Don't render the dropdown if there are no relevant actions
  if (!isTerminalTask) return null;

  async function reviewPr() {
    setReviewingPr(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}/review-pr`, { method: "POST" });
      if (res.ok) {
        getAnalytics()?.capture("task_action", { action: "review_pr" });
        toast.success("Review scheduled, agent will review the PR, make changes, and comment shortly");
        router.refresh();
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(data.error ?? "Failed to schedule PR review");
      }
    } catch {
      toast.error("Failed to schedule PR review");
    } finally {
      setReviewingPr(false);
    }
  }

  function triggerVerification() {
    // Dispatch a custom event that CompletionVerifier listens for
    window.dispatchEvent(new CustomEvent(`verify-completion-${taskId}`));
    // Scroll to the verification result area after a short delay
    setTimeout(() => {
      document.getElementById(`cv-anchor-${taskId}`)?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }, 100);
  }

  function exportMarkdown() {
    const lines: string[] = [];

    lines.push(`# ${title}`);
    lines.push("");
    lines.push(`**Status:** ${taskStatus}`);
    if (providerName) lines.push(`**Provider:** ${providerName}`);
    if (model) lines.push(`**Model:** ${model}`);
    lines.push(`**Created:** ${new Date(createdAt).toLocaleString()}`);
    lines.push("");

    if (labels) {
      try {
        const labelList = JSON.parse(labels) as string[];
        if (labelList.length > 0) {
          lines.push(`**Labels:** ${labelList.join(", ")}`);
          lines.push("");
        }
      } catch { /* ignore */ }
    }

    lines.push("## Description");
    lines.push("");
    lines.push(description);
    lines.push("");

    if (context) {
      lines.push("## Context");
      lines.push("");
      lines.push(context);
      lines.push("");
    }

    if (repos && repos.length > 0) {
      lines.push("## Repositories");
      lines.push("");
      for (const repo of repos) {
        lines.push(`- **${repo.alias}:** ${repo.url}`);
      }
      if (branchName) lines.push(`- **Branch:** ${branchName}`);
      if (prUrl) lines.push(`- **Pull Request:** ${prUrl}`);
      lines.push("");
    }

    if (lastAiMessage) {
      lines.push("## Result");
      lines.push("");
      lines.push(lastAiMessage.content);
      lines.push("");
      lines.push(`*Last AI response: ${new Date(lastAiMessage.createdAt).toLocaleString()}*`);
      lines.push("");
    }

    if (prSummary) {
      lines.push("## Changes Summary");
      lines.push("");
      lines.push(prSummary);
      lines.push("");
    }

    if (notes) {
      lines.push("## Notes");
      lines.push("");
      lines.push(notes);
      lines.push("");
    }

    if (inputTokens != null || outputTokens != null || estimatedCost != null) {
      lines.push("## Usage");
      lines.push("");
      if (inputTokens != null) lines.push(`- Input tokens: ${inputTokens.toLocaleString()}`);
      if (outputTokens != null) lines.push(`- Output tokens: ${outputTokens.toLocaleString()}`);
      if (estimatedCost != null) lines.push(`- Estimated cost: $${estimatedCost.toFixed(6)}`);
      lines.push("");
    }

    lines.push("---");
    lines.push(`*Exported from AI Task Manager on ${new Date().toLocaleString()}*`);

    const content = lines.join("\n");
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const safeTitle = title.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 50);
    a.download = `task-${taskId}-${safeTitle}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={buttonVariants({ variant: "secondary", size: "sm" }) + " gap-1.5"}>
        Actions
        <ChevronDown className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-48">
        {isCompleted && (
          <>
            <DropdownMenuItem onClick={triggerVerification}>
              <CheckCircle2 className="size-4 text-green-400" />
              Verify Completion
            </DropdownMenuItem>
            {canReviewPr && (
              <DropdownMenuItem onClick={reviewPr} disabled={reviewingPr}>
                {reviewingPr ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <GitPullRequest className="size-4 text-sky-400" />
                )}
                Review PR
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
          </>
        )}
        {isTerminalTask && (
          <>
            <DropdownMenuItem onClick={exportMarkdown}>
              <FileDown className="size-4" />
              Export task
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem render={<Link href={`/tasks/new?from=${taskId}`} />}>
          <Copy className="size-4" />
          Duplicate
        </DropdownMenuItem>
        {showBrowseWorkspace && (
          <DropdownMenuItem render={<Link href={`/tasks/${taskId}/files`} />}>
            <FolderOpen className="size-4" />
            Browse workspace
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
