"use client";

import { useState } from "react";
import { Stethoscope, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getAnalytics } from "@/components/WebAnalytics";

interface FailureDiagnosisProps {
  taskId: string;
}

/**
 * Shows an "Analyze Failure" button for failed tasks.
 * On click, calls the AI to diagnose what went wrong and surfaces
 * a structured explanation (root cause, details, suggested fix).
 */
export function FailureDiagnosis({ taskId }: FailureDiagnosisProps) {
  const [loading, setLoading] = useState(false);
  const [diagnosis, setDiagnosis] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);

  async function analyze() {
    setLoading(true);
    setError(null);
    setDiagnosis(null);
    try {
      const res = await fetch(`/api/tasks/${taskId}/diagnose`, { method: "POST" });
      const data = await res.json() as { diagnosis?: string; error?: string };
      if (!res.ok || data.error) {
        throw new Error(data.error ?? "Diagnosis failed");
      }
      getAnalytics()?.capture("task_action", { action: "diagnose" });
      setDiagnosis(data.diagnosis ?? "No diagnosis returned.");
      setOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Diagnosis failed");
    } finally {
      setLoading(false);
    }
  }

  /**
   * Renders AI diagnosis text with **bold** markdown support and bullet list formatting.
   * We avoid a full markdown parser to keep bundle size minimal.
   */
  function renderDiagnosis(text: string) {
    return text.split("\n").map((line, i) => {
      // Replace **text** with <strong>
      const parts = line.split(/\*\*([^*]+)\*\*/g);
      const content = parts.map((part, j) =>
        j % 2 === 1 ? <strong key={j} className="text-foreground font-semibold">{part}</strong> : part
      );
      return (
        <p key={i} className={`${line.startsWith("- ") ? "pl-3" : ""} ${i > 0 ? "mt-1.5" : ""} text-sm text-card-foreground leading-relaxed`}>
          {content}
        </p>
      );
    });
  }

  if (!diagnosis && !error) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => void analyze()}
        disabled={loading}
        className="gap-1.5"
      >
        <Stethoscope className="size-3.5" />
        {loading ? "Analyzing…" : "Analyze Failure"}
      </Button>
    );
  }

  return (
    <details
      className="group rounded-lg border border-border bg-card text-card-foreground shadow-sm"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="flex cursor-pointer items-center justify-between px-6 py-4 text-base font-semibold select-none list-none">
        <span className="flex items-center gap-2">
          <Stethoscope className="size-4 text-amber-400" />
          Failure Analysis
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>

      <div className="px-6 pb-5">
        {error ? (
          <div className="rounded-md bg-destructive/10 border border-destructive/30 px-4 py-3 text-sm text-destructive">
            {error}
            <button
              className="ml-3 underline hover:no-underline text-xs"
              onClick={() => void analyze()}
            >
              Retry
            </button>
          </div>
        ) : (
          <div className="space-y-0.5">{renderDiagnosis(diagnosis ?? "")}</div>
        )}
        <button
          className="mt-4 text-xs text-muted-foreground hover:text-foreground underline transition-colors"
          onClick={() => void analyze()}
          disabled={loading}
        >
          {loading ? "Re-analyzing…" : "Re-analyze"}
        </button>
      </div>
    </details>
  );
}
