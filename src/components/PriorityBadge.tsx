import { Flag } from "lucide-react";
import { normalizePriority, PRIORITY_LABELS, DEFAULT_PRIORITY } from "@/lib/priority";

// Only shown for non-default priorities so task cards/headers aren't cluttered with a
// badge for the common case — mirrors the worker's priority-first pick-up order (see
// comparePriorityThenPosition in src/lib/priority.ts).
const PRIORITY_BADGE_STYLES: Record<string, string> = {
  urgent: "bg-red-500/10 text-red-500 border-red-500/20",
  high: "bg-orange-500/10 text-orange-500 border-orange-500/20",
  low: "bg-zinc-800 text-zinc-400 border-zinc-600",
};

export function PriorityBadge({ priority }: { priority: string | null | undefined }) {
  const normalized = normalizePriority(priority);
  if (normalized === DEFAULT_PRIORITY) return null;
  return (
    <span
      title={`Priority: ${PRIORITY_LABELS[normalized]} (affects worker pick-up order)`}
      className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full border ${PRIORITY_BADGE_STYLES[normalized]}`}
    >
      <Flag className="size-3" />
      {PRIORITY_LABELS[normalized]}
    </span>
  );
}
