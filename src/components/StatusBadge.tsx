"use client";
import { Badge } from "@/components/ui/badge";
import type { TaskStatus } from "@/lib/types";

const styles: Record<TaskStatus, string> = {
  pending: "bg-zinc-700 text-zinc-200",
  backlog: "bg-zinc-800 text-zinc-400 border border-zinc-600",
  running: "bg-blue-600 text-white animate-pulse",
  paused: "bg-yellow-600 text-white",
  throttled: "bg-orange-600 text-white",
  completed: "bg-green-700 text-white",
  no_changes: "bg-slate-600 text-white",
  failed: "bg-red-700 text-white",
  killed: "bg-zinc-600 text-white",
  timedout: "bg-amber-700 text-white",
  awaiting_approval: "bg-purple-600 text-white",
};

// Most statuses read fine as-is (e.g. "completed", "timedout"), but "no_changes"
// needs its underscore turned into a space to read as a label rather than a code symbol.
const labels: Partial<Record<TaskStatus, string>> = {
  no_changes: "no changes",
  awaiting_approval: "awaiting approval",
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  return <Badge className={`text-xs ${styles[status]}`}>{labels[status] ?? status}</Badge>;
}
