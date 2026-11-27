"use client";

import { FileDown } from "lucide-react";

interface ExportTaskButtonProps {
  taskId: string;
  title: string;
  status: string;
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

export function ExportTaskButton({
  taskId,
  title,
  status,
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
}: ExportTaskButtonProps) {
  function exportMarkdown() {
    const lines: string[] = [];

    lines.push(`# ${title}`);
    lines.push("");
    lines.push(`**Status:** ${status}`);
    if (providerName) lines.push(`**Provider:** ${providerName}`);
    if (model) lines.push(`**Model:** ${model}`);
    lines.push(`**Created:** ${new Date(createdAt).toLocaleString()}`);
    lines.push("");

    // Labels
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
    <button
      onClick={exportMarkdown}
      title="Export task as file"
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded-md hover:bg-muted"
    >
      <FileDown className="size-3.5" />
      Export
    </button>
  );
}
