"use client";

import { useState } from "react";
import { Activity, ChevronDown, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ProgressSummaryProps {
  taskId: string;
}

/**
 * Shows a "Summarise Progress" button for running tasks.
 * On click, calls the AI with recent execution logs and renders
 * a structured summary: what's been done, current activity, and remaining work.
 */
export function ProgressSummary({ taskId }: ProgressSummaryProps) {
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);

  async function fetchSummary() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${taskId}/progress-summary`, { method: "POST" });
      const data = await res.json() as { summary?: string; error?: string };
      if (!res.ok || data.error) {
        throw new Error(data.error ?? "Progress summary failed");
      }
      setSummary(data.summary ?? "No summary returned.");
      setOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Progress summary failed");
    } finally {
      setLoading(false);
    }
  }

  /**
   * Renders AI summary text with **bold** markdown support.
   */
  function renderSummary(text: string) {
    return text.split("\n").map((line, i) => {
      const parts = line.split(/\*\*([^*]+)\*\*/g);
      const content = parts.map((part, j) =>
        j % 2 === 1 ? <strong key={j} className="text-foreground font-semibold">{part}</strong> : part
      );
      return (
        <p
          key={i}
          className={`${line.startsWith("- ") ? "pl-3" : ""} ${i > 0 ? "mt-1.5" : ""} text-sm text-card-foreground leading-relaxed`}
        >
          {content}
        </p>
      );
    });
  }

  if (!summary && !error) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => void fetchSummary()}
        disabled={loading}
        className="gap-1.5"
      >
        <Activity className="size-3.5" />
        {loading ? "Summarising…" : "Summarise Progress"}
      </Button>
    );
  }

  return (
    <details
      className="group rounded-lg border border-blue-500/30 bg-blue-500/5 text-card-foreground shadow-sm"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="flex cursor-pointer items-center justify-between px-6 py-4 text-base font-semibold select-none list-none">
        <span className="flex items-center gap-2">
          <Activity className="size-4 text-blue-400" />
          Progress Summary
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>

      <div className="px-6 pb-5">
        {error ? (
          <div className="rounded-md bg-destructive/10 border border-destructive/30 px-4 py-3 text-sm text-destructive">
            {error}
            <button
              className="ml-3 underline hover:no-underline text-xs"
              onClick={() => void fetchSummary()}
            >
              Retry
            </button>
          </div>
        ) : (
          <div className="space-y-0.5">{renderSummary(summary ?? "")}</div>
        )}
        <button
          className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground underline transition-colors disabled:opacity-50"
          onClick={() => void fetchSummary()}
          disabled={loading}
        >
          <RefreshCw className={`size-3 ${loading ? "animate-spin" : ""}`} />
          {loading ? "Refreshing…" : "Refresh summary"}
        </button>
      </div>
    </details>
  );
}
