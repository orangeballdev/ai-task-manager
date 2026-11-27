"use client";

import { useState, useEffect, useRef } from "react";
import { CheckCircle2, ChevronDown } from "lucide-react";
import { MarkdownContent } from "@/components/MarkdownContent";

interface CompletionVerifierProps {
  taskId: string;
}

/**
 * Shows the completion verification result for completed tasks.
 * The trigger button lives in the TaskActionsDropdown; this component
 * listens for the `verify-completion-<taskId>` custom event and then
 * fetches + renders the AI assessment.
 */
export function CompletionVerifier({ taskId }: CompletionVerifierProps) {
  const [loading, setLoading] = useState(false);
  const [assessment, setAssessment] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);

  async function verify() {
    if (loading) return;
    setLoading(true);
    setError(null);
    setAssessment(null);
    try {
      const res = await fetch(`/api/tasks/${taskId}/verify`, { method: "POST" });
      const data = await res.json() as { assessment?: string; error?: string };
      if (!res.ok || data.error) {
        throw new Error(data.error ?? "Verification failed");
      }
      setAssessment(data.assessment ?? "No assessment returned.");
      setOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setLoading(false);
    }
  }

  // Keep a ref so the event handler always calls the latest verify()
  const verifyRef = useRef(verify);
  useEffect(() => { verifyRef.current = verify; });

  // Listen for trigger events dispatched by the Actions dropdown
  useEffect(() => {
    const handler = () => void verifyRef.current();
    const eventName = `verify-completion-${taskId}`;
    window.addEventListener(eventName, handler);
    return () => window.removeEventListener(eventName, handler);
  }, [taskId]);

  // Render an invisible anchor so the dropdown can scroll here, even before loading starts
  if (!loading && !assessment && !error) {
    return <div id={`cv-anchor-${taskId}`} aria-hidden className="h-0 -mt-2 -mb-2 overflow-hidden" />;
  }

  if (loading) {
    return (
      <div id={`cv-anchor-${taskId}`} className="rounded-lg border border-border bg-card px-6 py-4 flex items-center gap-2 text-sm text-muted-foreground">
        <CheckCircle2 className="size-4 text-green-400 animate-pulse shrink-0" />
        Verifying completion…
      </div>
    );
  }

  return (
    <details
      id={`cv-anchor-${taskId}`}
      className="group rounded-lg border border-border bg-card text-card-foreground shadow-sm"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="flex cursor-pointer items-center justify-between px-6 py-4 text-base font-semibold select-none list-none">
        <span className="flex items-center gap-2">
          <CheckCircle2 className="size-4 text-green-400" />
          Completion Verification
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>

      <div className="px-6 pb-5">
        {error ? (
          <div className="rounded-md bg-destructive/10 border border-destructive/30 px-4 py-3 text-sm text-destructive">
            {error}
            <button
              className="ml-3 underline hover:no-underline text-xs"
              onClick={() => void verify()}
            >
              Retry
            </button>
          </div>
        ) : (
          <MarkdownContent content={assessment ?? ""} />
        )}
        <button
          className="mt-4 text-xs text-muted-foreground hover:text-foreground underline transition-colors"
          onClick={() => void verify()}
          disabled={loading}
        >
          {loading ? "Re-verifying…" : "Re-verify"}
        </button>
      </div>
    </details>
  );
}
