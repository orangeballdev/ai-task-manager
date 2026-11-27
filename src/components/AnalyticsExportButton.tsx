"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface ExportTask {
  id: string;
  title: string;
  status: string;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCost: number | null;
  createdAt: string;
  updatedAt: string;
  aiProvider?: { name: string; type: string; model: string | null } | null;
  model?: string | null;
  repos?: { alias: string; url: string }[];
}

function escapeCsv(value: string | number | null | undefined): string {
  if (value == null) return "";
  const str = String(value);
  // Wrap in quotes if the value contains a comma, quote, or newline
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * A button that downloads all finished tasks (completed/failed/killed/timedout) as a CSV file.
 * Fetches from /api/tasks and filters to terminal-status tasks before generating the file.
 */
export function AnalyticsExportButton({ range }: { range?: string }) {
  const [exporting, setExporting] = useState(false);

  async function handleExport() {
    setExporting(true);
    try {
      const res = await fetch("/api/tasks");
      if (!res.ok) throw new Error("Failed to fetch tasks");
      const allTasks = (await res.json()) as ExportTask[];

      const terminalStatuses = new Set(["completed", "no_changes", "failed", "killed", "timedout"]);
      let tasks = allTasks.filter((t) => terminalStatuses.has(t.status));

      // Apply time range filter matching what the analytics page shows
      if (range && range !== "all") {
        const days = range === "7d" ? 7 : range === "30d" ? 30 : range === "90d" ? 90 : null;
        if (days !== null) {
          const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
          tasks = tasks.filter((t) => new Date(t.createdAt) >= cutoff);
        }
      }

      const headers = ["ID", "Title", "Status", "Provider", "Model", "Input Tokens", "Output Tokens", "Est. Cost (USD)", "Created At", "Updated At", "Repos"];
      const rows = tasks.map((t) => [
        t.id,
        t.title,
        t.status,
        t.aiProvider?.name ?? "",
        t.model ?? t.aiProvider?.model ?? "",
        t.inputTokens ?? "",
        t.outputTokens ?? "",
        t.estimatedCost != null ? t.estimatedCost.toFixed(6) : "",
        new Date(t.createdAt).toISOString(),
        new Date(t.updatedAt).toISOString(),
        (t.repos ?? []).map((r) => r.alias).join("; "),
      ]);

      const csvLines = [
        headers.map(escapeCsv).join(","),
        ...rows.map((r) => r.map(escapeCsv).join(",")),
      ];
      const csvContent = csvLines.join("\n");

      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const dateStr = new Date().toISOString().slice(0, 10);
      link.href = url;
      link.download = `ai-task-manager-${range ?? "all"}-${dateStr}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      toast.success(`Exported ${tasks.length} task${tasks.length !== 1 ? "s" : ""} to CSV`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => void handleExport()}
      disabled={exporting}
      className="gap-1.5 shrink-0"
      title="Download filtered task data as CSV"
    >
      <Download size={14} />
      {exporting ? "Exporting…" : "Export CSV"}
    </Button>
  );
}
