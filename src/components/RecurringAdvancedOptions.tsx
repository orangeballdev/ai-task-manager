"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Flame } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface RecurringAdvancedOptionsProps {
  taskId: string;
  isHailMary: boolean;
}

export function RecurringAdvancedOptions({ taskId, isHailMary: initialHailMary }: RecurringAdvancedOptionsProps) {
  const router = useRouter();
  const [runCount, setRunCount] = useState("1");
  const [runningCount, setRunningCount] = useState(false);
  const [isHailMary, setIsHailMary] = useState(initialHailMary);
  const [togglingHailMary, setTogglingHailMary] = useState(false);

  async function handleRunNowCount() {
    const count = parseInt(runCount, 10);
    if (isNaN(count) || count < 1) return;
    setRunningCount(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}/run-now`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count }),
      });
      if (!res.ok) throw new Error();
      const data = await res.json() as { count: number };
      toast.success(`${data.count} task instance${data.count !== 1 ? "s" : ""} queued`);
      router.refresh();
    } catch {
      toast.error("Failed to queue task instances");
    } finally {
      setRunningCount(false);
    }
  }

  async function handleToggleHailMary() {
    const next = !isHailMary;
    setTogglingHailMary(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isHailMary: next }),
      });
      if (!res.ok) throw new Error();
      setIsHailMary(next);
      toast.success(next ? "Marked as Hail Mary task" : "Removed from Hail Mary tasks");
    } catch {
      toast.error("Failed to update task");
    } finally {
      setTogglingHailMary(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Queue multiple runs now */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">Queue multiple runs now</span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground shrink-0">Run</span>
          <input
            type="number"
            min="1"
            max="50"
            value={runCount}
            onChange={(e) => setRunCount(e.target.value)}
            className="w-16 bg-muted border border-border rounded px-2 py-1 text-xs text-center focus:outline-none focus:border-primary/60"
          />
          <span className="text-xs text-muted-foreground shrink-0">instance{parseInt(runCount, 10) !== 1 ? "s" : ""} now</span>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-7 text-xs"
            disabled={runningCount || !runCount || parseInt(runCount, 10) < 1}
            onClick={() => void handleRunNowCount()}
          >
            {runningCount ? "Queuing…" : "Queue"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground/70">Creates the specified number of task instances immediately.</p>
      </div>

      {/* Hail Mary toggle */}
      <div className="flex items-start gap-3">
        <div className="flex items-center gap-2 mt-0.5">
          <button
            type="button"
            role="switch"
            aria-checked={isHailMary}
            disabled={togglingHailMary}
            onClick={() => void handleToggleHailMary()}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none disabled:opacity-50 ${isHailMary ? "bg-orange-500" : "bg-muted-foreground/30"}`}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition-transform ${isHailMary ? "translate-x-4" : "translate-x-0"}`}
            />
          </button>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-medium flex items-center gap-1.5">
            <Flame size={12} className={isHailMary ? "text-orange-400" : "text-muted-foreground"} />
            Hail Mary task
          </span>
          <span className="text-xs text-muted-foreground/70">
            Include this task in automatic Hail Mary bursts that use up
            remaining provider quota before it resets. Triggers when a
            healthy (non–rate-limited) CLI provider&apos;s usage window
            resets within 24h and still has over 20% quota remaining;
            runs once per reset window.
          </span>
        </div>
      </div>
    </div>
  );
}
