"use client";

import { useState, useEffect, useCallback } from "react";
import {
  CheckCircle2,
  History,
  Loader2,
  MessageSquarePlus,
  OctagonX,
  Pause,
  Play,
  Square,
  Timer,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LocalDateTime } from "@/components/LocalDateTime";
import { CopyButton } from "@/components/CopyButton";
import { MarkdownContent } from "@/components/MarkdownContent";

// Map every task status to a Lucide icon (using icons already present in the codebase).
const STATUS_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  pending: Play,
  backlog: Square,
  running: Loader2,
  paused: Pause,
  throttled: Timer,
  completed: CheckCircle2,
  failed: OctagonX,
  killed: Square,
  timedout: Timer,
};

// Colour classes matching the StatusBadge palette.
const STATUS_COLORS: Record<string, string> = {
  pending: "text-zinc-400",
  backlog: "text-zinc-500",
  running: "text-blue-400",
  paused: "text-yellow-400",
  throttled: "text-orange-400",
  completed: "text-green-400",
  failed: "text-red-400",
  killed: "text-zinc-400",
  timedout: "text-amber-400",
};

interface ChangeRequest {
  id: string;
  title: string;
  description: string;
  status: string;
  createdAt: string;
}

interface Props {
  taskId: string;
  content: string;
  contentTimestamp: string;
  /** Branch name from the parent task — required to enable the Request Change button. */
  branchName: string | null;
  /** Whether the details accordion should start open. */
  defaultOpen?: boolean;
}

/** The task's change requests, or null when they couldn't be fetched. */
async function fetchChangeRequests(taskId: string): Promise<ChangeRequest[] | null> {
  try {
    const res = await fetch(`/api/tasks/${taskId}/request-change`);
    return res.ok ? ((await res.json()) as ChangeRequest[]) : null;
  } catch {
    return null; // ignore network errors
  }
}

export function FileOutputViewer({
  taskId,
  content,
  contentTimestamp,
  branchName,
  defaultOpen,
}: Props) {
  const [requestOpen, setRequestOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [changeText, setChangeText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [changes, setChanges] = useState<ChangeRequest[]>([]);

  const fetchChanges = useCallback(async () => {
    const data = await fetchChangeRequests(taskId);
    if (data) setChanges(data);
  }, [taskId]);

  // Auto-refresh at 5 s — same interval as the task list — while the history modal is open.
  useEffect(() => {
    if (!historyOpen) return;
    let cancelled = false;
    const poll = () => {
      fetchChangeRequests(taskId).then((data) => {
        if (!cancelled && data) setChanges(data);
      });
    };
    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [historyOpen, taskId]);

  const submitChange = async () => {
    if (!changeText.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}/request-change`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: changeText.trim() }),
      });
      if (res.ok) {
        setChangeText("");
        setRequestOpen(false);
        toast.success("Change scheduled, agent will pick it up shortly");
        // Eagerly refresh so the new item appears in Change History immediately.
        fetchChanges();
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(data.error ?? "Failed to schedule change");
      }
    } catch {
      toast.error("Failed to schedule change");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <details
        className="group rounded-lg border border-border bg-card text-card-foreground shadow-sm"
        open={defaultOpen || undefined}
      >
        <summary className="flex cursor-pointer items-center justify-between px-6 py-4 text-base font-semibold select-none list-none">
          Result
          {/* Toolbar buttons — stopPropagation prevents the click from toggling the details. */}
          <div
            className="flex items-center gap-2 ml-auto mr-3"
            onClick={(e) => e.stopPropagation()}
          >
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setHistoryOpen(true);
              }}
            >
              <History className="size-3.5" />
              Change History
            </Button>
            {branchName && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setRequestOpen(true);
                }}
              >
                <MessageSquarePlus className="size-3.5" />
                Request Change
              </Button>
            )}
          </div>
          {/* Chevron — matches the other <details> accordions on this page. */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fillRule="evenodd"
              d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
              clipRule="evenodd"
            />
          </svg>
        </summary>
        <div className="px-6 pb-6">
          <MarkdownContent content={content} />
          <div className="flex items-center justify-between mt-2">
            <p className="text-xs text-muted-foreground">
              Last AI response · <LocalDateTime iso={contentTimestamp} />
            </p>
            <CopyButton text={content} label="Copy result to clipboard" />
          </div>
        </div>
      </details>

      {/* ── Request Change modal ──────────────────────────────────────────── */}
      <Dialog open={requestOpen} onOpenChange={setRequestOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request Change</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Textarea
              autoFocus
              value={changeText}
              onChange={(e) => setChangeText(e.target.value)}
              placeholder="Describe the change to make…"
              rows={3}
              className="text-sm"
              disabled={submitting}
            />
            <div className="flex gap-1.5">
              <Button
                className="flex-1"
                onClick={submitChange}
                disabled={!changeText.trim() || submitting}
              >
                {submitting ? "Scheduling…" : "Schedule"}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setRequestOpen(false);
                  setChangeText("");
                }}
                disabled={submitting}
              >
                Cancel
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Change History modal ─────────────────────────────────────────── */}
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Change History</DialogTitle>
          </DialogHeader>
          {changes.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">
              No change requests yet.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {changes.map((cr) => {
                const Icon = STATUS_ICONS[cr.status] ?? Play;
                const color = STATUS_COLORS[cr.status] ?? "text-zinc-400";
                const isSpinning = cr.status === "running";
                return (
                  <div
                    key={cr.id}
                    className="flex flex-col gap-1 rounded-lg border border-border p-3"
                  >
                    <p className="text-sm text-card-foreground">{cr.description}</p>
                    <div className="flex items-center gap-1.5 mt-1">
                      <Icon
                        className={`size-3.5 ${color} ${isSpinning ? "animate-spin" : ""}`}
                      />
                      <span className={`text-xs capitalize ${color}`}>{cr.status}</span>
                      <span className="text-xs text-muted-foreground">·</span>
                      <span className="text-xs text-muted-foreground">
                        <LocalDateTime iso={new Date(cr.createdAt).toISOString()} />
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
