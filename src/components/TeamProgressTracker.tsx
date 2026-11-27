"use client";
import { useEffect, useState } from "react";
import type React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Circle, Hand, Loader2, MinusCircle, OctagonX, PauseCircle, ShieldCheck, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownContent } from "@/components/MarkdownContent";
import { estimateRunCost, formatCost, formatTokens } from "@/lib/token-cost";
import {
  buildTeamProgressView,
  type TeamProgress,
  type TeamRosterMember,
  type TeamStageDisplayStatus,
} from "@/lib/team-progress";

/** Window event the tracker fires when a member is clicked; LogViewer filters to that member. */
export const TEAM_MEMBER_FILTER_EVENT = "team-member-filter";
export interface TeamMemberFilterDetail {
  taskId: string;
  member: string | null;
}

const TERMINAL_STATUSES = new Set(["completed", "no_changes", "failed", "killed", "timedout"]);

const STATUS_META: Record<TeamStageDisplayStatus, { label: string; icon: React.ReactNode; tone: string }> = {
  pending: { label: "Waiting", icon: <Circle className="size-4" />, tone: "text-muted-foreground" },
  running: { label: "Working now", icon: <Loader2 className="size-4 animate-spin" />, tone: "text-blue-500" },
  completed: { label: "Finished", icon: <CheckCircle2 className="size-4" />, tone: "text-green-500" },
  awaiting_approval: { label: "Waiting for your approval", icon: <Hand className="size-4" />, tone: "text-purple-500" },
  failed: { label: "Failed", icon: <XCircle className="size-4" />, tone: "text-red-500" },
  stopped: { label: "Stopped", icon: <OctagonX className="size-4" />, tone: "text-amber-500" },
  skipped: { label: "Not run", icon: <MinusCircle className="size-4" />, tone: "text-muted-foreground/60" },
  paused: { label: "Paused — will resume", icon: <PauseCircle className="size-4" />, tone: "text-yellow-500" },
  interrupted: { label: "Interrupted", icon: <AlertTriangle className="size-4" />, tone: "text-amber-500" },
};

function formatElapsed(ms: number): string {
  if (ms < 0) ms = 0;
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) return `${hrs}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}

export function TeamProgressTracker({
  taskId,
  initialStatus,
  initialProgress,
  initialRoster,
  model = null,
  providerType = null,
}: {
  taskId: string;
  initialStatus: string;
  initialProgress: TeamProgress | null;
  initialRoster: TeamRosterMember[];
  /** Model and provider type the task runs on, used to price each stage's tokens. */
  model?: string | null;
  providerType?: string | null;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);
  const [progress, setProgress] = useState(initialProgress);
  const [roster, setRoster] = useState(initialRoster);
  const [now, setNow] = useState(() => Date.now());
  const [selected, setSelected] = useState<string | null>(null);

  // Server re-render (router.refresh after a status change) brings fresh props.
  const [synced, setSynced] = useState({ initialStatus, initialProgress, initialRoster });
  if (synced.initialStatus !== initialStatus || synced.initialProgress !== initialProgress || synced.initialRoster !== initialRoster) {
    setSynced({ initialStatus, initialProgress, initialRoster });
    setStatus(initialStatus);
    setProgress(initialProgress);
    setRoster(initialRoster);
  }

  const live = !TERMINAL_STATUSES.has(status);

  // Poll while the task can still move through the pipeline.
  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/tasks/${taskId}/team-progress`);
        if (!res.ok) return;
        const data = (await res.json()) as { status: string; progress: TeamProgress | null; roster: TeamRosterMember[] };
        if (cancelled) return;
        setProgress(data.progress);
        setRoster(data.roster);
        setStatus((prev) => {
          if (prev !== data.status && (TERMINAL_STATUSES.has(data.status) || data.status === "awaiting_approval")) router.refresh();
          return data.status;
        });
      } catch { /* ignore — try again next tick */ }
    };
    const interval = setInterval(tick, 2000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [taskId, live, router]);

  // Tick the clock for the running stage's elapsed time.
  useEffect(() => {
    if (status !== "running") return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [status]);

  // Stay in sync with the activity log's member dropdown (and our own clicks).
  useEffect(() => {
    const onFilter = (e: Event) => {
      const detail = (e as CustomEvent<TeamMemberFilterDetail>).detail;
      if (detail?.taskId === taskId) setSelected(detail.member);
    };
    window.addEventListener(TEAM_MEMBER_FILTER_EVENT, onFilter);
    return () => window.removeEventListener(TEAM_MEMBER_FILTER_EVENT, onFilter);
  }, [taskId]);

  const view = buildTeamProgressView(progress, roster, status);

  const selectMember = (name: string) => {
    const next = selected === name ? null : name;
    window.dispatchEvent(new CustomEvent<TeamMemberFilterDetail>(TEAM_MEMBER_FILTER_EVENT, { detail: { taskId, member: next } }));
  };

  if (view.total === 0) {
    return <p className="text-sm text-muted-foreground">This team has no members.</p>;
  }

  const current = view.currentIndex !== null ? view.stages[view.currentIndex] : null;
  const pct = Math.round((view.completed / view.total) * 100);

  let headline: string;
  if (!view.hasRun) headline = "Not started yet — members will run in this order.";
  else if (current) headline = `${current.name} is working (stage ${view.currentIndex! + 1} of ${view.total})`;
  else if (view.awaitingIndex !== null) headline = `${view.stages[view.awaitingIndex].name} finished — waiting for your approval`;
  else if (view.completed === view.total) headline = "All members finished.";
  else {
    const ended = view.stages.find((s) => ["failed", "stopped", "interrupted", "paused"].includes(s.status));
    headline = ended ? `${STATUS_META[ended.status].label} at ${ended.name}` : "Waiting to run.";
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="font-medium">{headline}</span>
          <span className="text-xs text-muted-foreground tabular-nums shrink-0">
            {view.completed}/{view.total} finished
          </span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <div className="h-full bg-green-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <ol className="flex flex-col">
        {view.stages.map((stage, i) => {
          const meta = STATUS_META[stage.status];
          const started = stage.startedAt ? new Date(stage.startedAt).getTime() : null;
          const finished = stage.finishedAt ? new Date(stage.finishedAt).getTime() : null;
          const duration = started !== null
            ? finished !== null
              ? formatElapsed(finished - started)
              : stage.status === "running" ? formatElapsed(now - started) : null
            : null;
          const hasTokens = stage.inputTokens !== null || stage.outputTokens !== null;
          const inTokens = stage.inputTokens ?? 0;
          const outTokens = stage.outputTokens ?? 0;
          const stageCost = hasTokens ? estimateRunCost(model, providerType, inTokens, outTokens) : null;
          const tokenTitle = [
            `${inTokens.toLocaleString()} input · ${outTokens.toLocaleString()} output tokens`,
            stageCost && `${stageCost.atApiPricing ? "~" : ""}${formatCost(stageCost.cost)}${stageCost.atApiPricing ? " (estimated at API pricing)" : ""}`,
          ].filter(Boolean).join("\n");
          const isLast = i === view.stages.length - 1;
          const isSelected = selected === stage.name;
          return (
            <li key={stage.key} className="flex gap-3">
              <div className="flex flex-col items-center">
                <span className={`mt-1.5 ${meta.tone}`}>{meta.icon}</span>
                {!isLast && <span className="w-px flex-1 bg-border my-1" />}
              </div>
              <button
                type="button"
                onClick={() => selectMember(stage.name)}
                title={isSelected ? "Show all activity" : `Show only ${stage.name}'s activity`}
                className={`flex-1 min-w-0 text-left rounded-md px-2 py-1 mb-1 transition-colors ${
                  isSelected ? "bg-muted ring-1 ring-border" : "hover:bg-muted/60"
                } ${stage.status === "running" ? "bg-blue-500/5" : ""}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium truncate">
                    <span className="text-muted-foreground tabular-nums mr-1.5">{i + 1}.</span>
                    {stage.name}
                    {stage.requiresApproval && !isLast && (
                      <ShieldCheck className="inline size-3.5 ml-1.5 text-muted-foreground align-text-bottom" aria-label="Needs approval" />
                    )}
                  </span>
                  <span className={`text-xs shrink-0 ${meta.tone}`}>
                    {meta.label}
                    {duration && <span className="text-muted-foreground tabular-nums"> · {duration}</span>}
                    {hasTokens && (
                      <span
                        className="text-muted-foreground tabular-nums"
                        title={tokenTitle}
                      >
                        {" "}· {formatTokens(inTokens + outTokens)} tokens
                      </span>
                    )}
                  </span>
                </div>
                {stage.note && <p className="text-xs text-muted-foreground mt-0.5 break-words line-clamp-2">{stage.note}</p>}
              </button>
            </li>
          );
        })}
      </ol>
      {view.awaitingIndex !== null && (
        <ApprovalPanel
          taskId={taskId}
          stageName={view.stages[view.awaitingIndex].name}
          nextStageName={view.stages[view.awaitingIndex + 1]?.name ?? null}
          output={view.stages[view.awaitingIndex].output}
          onDecided={(next) => {
            setStatus(next);
            router.refresh();
          }}
        />
      )}
      {view.hasRun && (
        <p className="text-xs text-muted-foreground">Click a member to filter the activity log to their output.</p>
      )}
    </div>
  );
}

/** Approve / request changes for a team stage that is waiting on manual approval. */
function ApprovalPanel({
  taskId,
  stageName,
  nextStageName,
  output,
  onDecided,
}: {
  taskId: string;
  stageName: string;
  nextStageName: string | null;
  output: string | null;
  onDecided: (status: string) => void;
}) {
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState<"approve" | "revise" | null>(null);

  const decide = async (decision: "approve" | "revise") => {
    if (decision === "revise" && !feedback.trim()) {
      toast.error("Describe the changes you want first.");
      return;
    }
    setBusy(decision);
    try {
      const res = await fetch(`/api/tasks/${taskId}/team-approval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, feedback: feedback.trim() || null }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(data.error ?? "Failed to record your decision");
        return;
      }
      toast.success(decision === "approve"
        ? `Approved — ${nextStageName ?? "the next member"} will start shortly`
        : `Changes requested — ${stageName} will run again`);
      setFeedback("");
      onDecided("pending");
    } catch {
      toast.error("Failed to record your decision");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-md border border-purple-500/40 bg-purple-500/5 p-3 flex flex-col gap-3">
      <div>
        <p className="text-sm font-medium flex items-center gap-1.5">
          <Hand className="size-4 text-purple-500" />
          Review {stageName}&apos;s output
        </p>
        <p className="text-xs text-muted-foreground mt-0.5">
          The pipeline is paused. Approve to let {nextStageName ? `"${nextStageName}"` : "the next member"} continue with this output,
          or request changes to have {stageName} run again with your feedback.
        </p>
      </div>
      <div className="max-h-96 overflow-auto rounded border border-border bg-background p-3 text-sm">
        {output?.trim()
          ? <MarkdownContent content={output} />
          : <p className="text-xs text-muted-foreground">No output was captured for this stage — check the activity log below.</p>}
      </div>
      <Textarea
        rows={3}
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        placeholder={`Optional notes for ${nextStageName ?? "the next member"} when approving — or, required, the changes you want ${stageName} to make.`}
        className="text-sm"
      />
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" size="sm" onClick={() => void decide("revise")} disabled={busy !== null}>
          {busy === "revise" ? "Sending..." : "Request changes"}
        </Button>
        <Button size="sm" onClick={() => void decide("approve")} disabled={busy !== null}>
          {busy === "approve" ? "Approving..." : "Approve & continue"}
        </Button>
      </div>
    </div>
  );
}
