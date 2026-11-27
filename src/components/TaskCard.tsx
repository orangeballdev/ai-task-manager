"use client";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import Link from "next/link";
import { ArrowUpToLine, Bot, CircleDollarSign, Copy, GitBranch, GitFork, Pause, Pencil, Play, PlayCircle, RotateCcw, Star, Tag, Trash2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { StatusBadge } from "./StatusBadge";
import type { Task } from "@/lib/types";
import { getDisplayStatus } from "@/lib/types";

function parseLabels(labels: string | null | undefined): string[] {
  if (!labels) return [];
  try {
    const parsed = JSON.parse(labels) as string[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function relativeTime(date: Date): string {
  const ms = date.getTime() - Date.now();
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.round(ms / 3600000);
  if (hrs < 24) return `in ${hrs}h`;
  return `in ${Math.round(hrs / 24)}d`;
}

function timeAgo(date: Date): string {
  const ms = Date.now() - date.getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(ms / 3600000);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function ActionButtons({ task, onDelete, onRetry, onResume, onRunNow, onToggle, onEditThrottled, onMoveToTop, onPin, pinned, queuePosition }: { task: Task; onDelete?: (id: string) => void; onRetry?: (id: string) => void; onResume?: (id: string) => void; onRunNow?: (id: string) => void; onToggle?: (id: string, enabled: boolean) => void; onEditThrottled?: (id: string) => void; onMoveToTop?: (id: string) => void; onPin?: (id: string) => void; pinned?: boolean; queuePosition?: number }) {
  const displayStatus = getDisplayStatus(task);
  return (
    <>
      {onRunNow && displayStatus === "backlog" && (
        <Tooltip label="Run now">
          <Button
            variant="secondary"
            size="icon-sm"
            aria-label="Run now"
            onClick={(e) => { e.stopPropagation(); onRunNow(task.id); }}
          >
            <PlayCircle />
          </Button>
        </Tooltip>
      )}
      {onRunNow && task.status === "pending" && task.isEnabled && task.scheduledFor && new Date(task.scheduledFor) > new Date() && (
        <Tooltip label="Run now">
          <Button
            variant="secondary"
            size="icon-sm"
            aria-label="Run now"
            onClick={(e) => { e.stopPropagation(); onRunNow(task.id); }}
          >
            <PlayCircle />
          </Button>
        </Tooltip>
      )}
      {onMoveToTop && task.status === "pending" && task.isEnabled && queuePosition !== 1 && (
        <Tooltip label="Move to top of queue">
          <Button
            variant="secondary"
            size="icon-sm"
            aria-label="Move to top of queue"
            onClick={(e) => { e.stopPropagation(); onMoveToTop(task.id); }}
          >
            <ArrowUpToLine />
          </Button>
        </Tooltip>
      )}
      {task.status === "pending" && (
        <Tooltip label="Edit">
          <Link
            href={`/tasks/${task.id}/edit`}
            aria-label="Edit task"
            className={buttonVariants({ variant: "secondary", size: "icon-sm" })}
            onClick={(e) => e.stopPropagation()}
          >
            <Pencil />
          </Link>
        </Tooltip>
      )}
      {onResume && task.status === "throttled" && (
        <Tooltip label="Resume now">
          <Button
            variant="secondary"
            size="icon-sm"
            aria-label="Resume task now"
            onClick={(e) => { e.stopPropagation(); onResume(task.id); }}
          >
            <PlayCircle />
          </Button>
        </Tooltip>
      )}
      {onEditThrottled && task.status === "throttled" && (
        <Tooltip label="Edit">
          <Button
            variant="secondary"
            size="icon-sm"
            aria-label="Edit task"
            onClick={(e) => { e.stopPropagation(); onEditThrottled(task.id); }}
          >
            <Pencil />
          </Button>
        </Tooltip>
      )}
      {onRetry && !task.reviewOnly && (task.status === "failed" || task.status === "killed" || task.status === "timedout" || task.status === "completed" || task.status === "no_changes") && (
        <Tooltip label="Retry">
          <Button
            variant="secondary"
            size="icon-sm"
            aria-label="Retry task"
            onClick={(e) => { e.stopPropagation(); onRetry(task.id); }}
          >
            <RotateCcw />
          </Button>
        </Tooltip>
      )}
      {onToggle && (
        <Tooltip label={task.isEnabled ? "Disable" : "Enable"}>
          <Button
            variant="secondary"
            size="icon-sm"
            aria-label={task.isEnabled ? "Disable task" : "Enable task"}
            onClick={(e) => { e.stopPropagation(); onToggle(task.id, !task.isEnabled); }}
          >
            {task.isEnabled ? <Pause /> : <Play />}
          </Button>
        </Tooltip>
      )}
      {onPin && (
        <Tooltip label={pinned ? "Unpin task" : "Pin to top"}>
          <Button
            variant="secondary"
            size="icon-sm"
            aria-label={pinned ? "Unpin task" : "Pin task to top of list"}
            onClick={(e) => { e.stopPropagation(); onPin(task.id); }}
          >
            <Star className={pinned ? "fill-yellow-400 text-yellow-400" : ""} />
          </Button>
        </Tooltip>
      )}
      <Tooltip label="Duplicate">
        <Link
          href={`/tasks/new?from=${task.id}`}
          aria-label="Duplicate task"
          className={buttonVariants({ variant: "secondary", size: "icon-sm" })}
          onClick={(e) => e.stopPropagation()}
        >
          <Copy />
        </Link>
      </Tooltip>
      {onDelete && (
        <Tooltip label="Delete">
          <Button
            variant="destructive"
            size="icon-sm"
            aria-label="Delete task"
            onClick={(e) => { e.stopPropagation(); onDelete(task.id); }}
          >
            <Trash2 />
          </Button>
        </Tooltip>
      )}
    </>
  );
}

export function TaskCard({ task, onDelete, onRetry, onResume, onRunNow, onToggle, onEditThrottled, onMoveToTop, onPin, pinned, queuePosition, compact }: { task: Task; onDelete?: (id: string) => void; onRetry?: (id: string) => void; onResume?: (id: string) => void; onRunNow?: (id: string) => void; onToggle?: (id: string, enabled: boolean) => void; onEditThrottled?: (id: string) => void; onMoveToTop?: (id: string) => void; onPin?: (id: string) => void; pinned?: boolean; queuePosition?: number; compact?: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: task.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  // "no_changes" tasks ran to completion just like "completed" ones (tokens spent, timestamp
  // updated) — they just didn't touch any code. Treat them the same for cosmetic bits like
  // the cost badge and "ran Xm ago" timestamp.
  const isFinished = task.status === "completed" || task.status === "no_changes";

  if (compact) {
    return (
      <div ref={setNodeRef} style={style} className="group relative">
        <Card className={`hover:border-border/60 transition-colors ${!task.isEnabled ? "opacity-50" : ""} ${pinned ? "border-yellow-500/30" : ""}`}>
          <CardContent className="px-3 py-2">
            <div className="flex items-center gap-2">
              <button
                {...attributes}
                {...listeners}
                className="relative z-[1] cursor-grab active:cursor-grabbing text-muted-foreground/40 hover:text-muted-foreground shrink-0"
                aria-label="Drag to reorder"
                suppressHydrationWarning
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                  <circle cx="5" cy="4" r="1.5" /><circle cx="11" cy="4" r="1.5" />
                  <circle cx="5" cy="8" r="1.5" /><circle cx="11" cy="8" r="1.5" />
                  <circle cx="5" cy="12" r="1.5" /><circle cx="11" cy="12" r="1.5" />
                </svg>
              </button>
              <Link href={`/tasks/${task.id}`} className="relative z-[1] flex-1 min-w-0 flex items-center gap-2">
                {pinned && <Star className="size-3 fill-yellow-400 text-yellow-400 shrink-0" />}
                <span className="font-medium text-card-foreground truncate text-sm">
                  {task.title}
                </span>
                <StatusBadge status={getDisplayStatus(task)} />
                {task.estimatedCost != null && task.estimatedCost > 0 && isFinished && (
                  <span className="inline-flex items-center gap-1 text-xs bg-emerald-500/10 text-emerald-400/90 px-1.5 py-0.5 rounded shrink-0 font-mono">
                    <CircleDollarSign className="size-3 shrink-0" />
                    ${task.estimatedCost.toFixed(4)}
                  </span>
                )}
                {task.aiProvider?.name && (
                  <span className="hidden sm:inline-flex items-center gap-1 text-xs text-muted-foreground/60 shrink-0">
                    <Bot className="size-3 shrink-0" />
                    {task.aiProvider.name}
                  </span>
                )}
                {queuePosition !== undefined && task.status === "pending" && task.isEnabled && (
                  <span className="text-xs text-muted-foreground/60 shrink-0">
                    {queuePosition === 1 ? "▶ next" : `#${queuePosition}`}
                  </span>
                )}
                {task.status === "running" && task.logs && task.logs.length > 0 && task.logs[0].level === "info" && (
                  <span className="text-xs text-blue-400/70 italic truncate hidden md:block">
                    ↪ {task.logs[0].content}
                  </span>
                )}
              </Link>
              {/* Desktop: hover to reveal */}
              <div className="relative z-[1] hidden sm:flex gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                <ActionButtons task={task} onDelete={onDelete} onRetry={onRetry} onResume={onResume} onRunNow={onRunNow} onToggle={onToggle} onEditThrottled={onEditThrottled} onMoveToTop={onMoveToTop} onPin={onPin} pinned={pinned} queuePosition={queuePosition} />
              </div>
            </div>
            {/* Mobile: always visible */}
            <div className="relative z-[1] flex sm:hidden gap-1 mt-1.5 justify-end">
              <ActionButtons task={task} onDelete={onDelete} onRetry={onRetry} onResume={onResume} onRunNow={onRunNow} onToggle={onToggle} onEditThrottled={onEditThrottled} onMoveToTop={onMoveToTop} onPin={onPin} pinned={pinned} queuePosition={queuePosition} />
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div ref={setNodeRef} style={style} className="group relative">
      <Card className={`hover:border-border/60 transition-colors ${!task.isEnabled ? "opacity-50" : ""} ${pinned ? "border-yellow-500/30" : ""}`}>
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <button
              {...attributes}
              {...listeners}
              className="relative z-[1] mt-1 cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-muted-foreground shrink-0"
              aria-label="Drag to reorder"
              suppressHydrationWarning
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <circle cx="5" cy="4" r="1.5" /><circle cx="11" cy="4" r="1.5" />
                <circle cx="5" cy="8" r="1.5" /><circle cx="11" cy="8" r="1.5" />
                <circle cx="5" cy="12" r="1.5" /><circle cx="11" cy="12" r="1.5" />
              </svg>
            </button>
            <Link href={`/tasks/${task.id}`} className="relative z-[1] flex-1 min-w-0 block">
              <div className="flex items-center gap-2 mb-1">
                {pinned && <Star className="size-3.5 fill-yellow-400 text-yellow-400 shrink-0" />}
                <span className="font-medium text-card-foreground truncate">
                  {task.title}
                </span>
                <StatusBadge status={getDisplayStatus(task)} />
                {isFinished && (
                  <span className="text-xs text-muted-foreground shrink-0" suppressHydrationWarning>
                    ran {timeAgo(new Date(task.updatedAt))}
                  </span>
                )}
              </div>
              <p className="text-sm text-muted-foreground line-clamp-2">{task.description}</p>
              {task.status === "running" && task.logs && task.logs.length > 0 && task.logs[0].level === "info" && (
                <p className="text-xs text-blue-400/80 mt-1.5 line-clamp-1 italic">
                  ↪ {task.logs[0].content}
                </p>
              )}
              {(task.repos.length > 0 || task.aiProvider?.name || task.model || (task.estimatedCost != null && task.estimatedCost > 0 && isFinished)) && (
                <div className="flex gap-1 mt-2 flex-wrap">
                  {task.repos.map((r) => (
                    <span key={r.id} className="inline-flex items-center gap-1 text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded">
                      <GitFork className="size-3" />
                      {r.alias}
                      {r.branch && (
                        <>
                          <span className="text-muted-foreground/40">·</span>
                          <GitBranch className="size-3" />
                          <span className="font-mono">{r.branch}</span>
                        </>
                      )}
                    </span>
                  ))}
                  {/* Branch is already prominently shown on the task detail page — omitted here to keep the row compact. */}
                  {/* Provider + model combined into a single chip instead of two. */}
                  {(task.aiProvider?.name || task.model || task.aiProvider?.model) && (
                    <span className="inline-flex items-center gap-1 text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded shrink-0 max-w-[16rem] truncate">
                      <Bot className="size-3 shrink-0" />
                      {[task.aiProvider?.name, task.model ?? task.aiProvider?.model].filter(Boolean).join(" · ")}
                    </span>
                  )}
                  {task.estimatedCost != null && task.estimatedCost > 0 && isFinished && (
                    <span className="inline-flex items-center gap-1 text-xs bg-emerald-500/10 text-emerald-400/90 px-2 py-0.5 rounded shrink-0 font-mono">
                      <CircleDollarSign className="size-3 shrink-0" />
                      ${task.estimatedCost.toFixed(4)}
                    </span>
                  )}
                  {task.estimatedCost != null && task.estimatedCost > 0 && task.status === "completed" && (
                    <span className="inline-flex items-center gap-1 text-xs bg-emerald-500/10 text-emerald-400/90 px-2 py-0.5 rounded shrink-0 font-mono">
                      <CircleDollarSign className="size-3 shrink-0" />
                      ${task.estimatedCost.toFixed(4)}
                    </span>
                  )}
                </div>
              )}
              {(() => {
                const labelList = parseLabels(task.labels);
                if (labelList.length === 0) return null;
                return (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {labelList.map((label) => (
                      <span
                        key={label}
                        className="inline-flex items-center gap-1 text-xs bg-primary/10 text-primary/80 px-2 py-0.5 rounded-full border border-primary/20"
                      >
                        <Tag className="size-2.5 shrink-0" />
                        {label}
                      </span>
                    ))}
                  </div>
                );
              })()}
              {task.status === "running" && (() => {
                const totalTokens = (task.inputTokens ?? 0) + (task.outputTokens ?? 0);
                if (task.tokenBudget && task.tokenBudget > 0 && totalTokens > 0) {
                  const pct = Math.min(100, (totalTokens / task.tokenBudget) * 100);
                  return (
                    <div className="mt-2" title={`Token budget: ${totalTokens.toLocaleString()} / ${task.tokenBudget.toLocaleString()} tokens`}>
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-xs text-muted-foreground">Token budget</span>
                        <span className="text-xs text-muted-foreground tabular-nums">{pct.toFixed(0)}%</span>
                      </div>
                      <div className="h-1 bg-muted rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${pct > 80 ? "bg-orange-400" : "bg-sky-400"}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                }
                if (task.costBudget && task.costBudget > 0 && task.estimatedCost != null && task.estimatedCost > 0) {
                  const pct = Math.min(100, (task.estimatedCost / task.costBudget) * 100);
                  return (
                    <div className="mt-2" title={`Cost budget: $${task.estimatedCost.toFixed(4)} / $${task.costBudget.toFixed(2)}`}>
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-xs text-muted-foreground">Cost budget</span>
                        <span className="text-xs text-muted-foreground tabular-nums">{pct.toFixed(0)}%</span>
                      </div>
                      <div className="h-1 bg-muted rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${pct > 80 ? "bg-orange-400" : "bg-sky-400"}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                }
                return null;
              })()}
              {task.scheduledFor && task.status === "pending" && new Date(task.scheduledFor) > new Date() && (
                <p className="text-xs text-sky-400 mt-1" suppressHydrationWarning>
                  Scheduled for {new Date(task.scheduledFor).toLocaleString(undefined, { timeZoneName: "short" })} ({relativeTime(new Date(task.scheduledFor))})
                </p>
              )}
              {queuePosition !== undefined && task.status === "pending" && task.isEnabled && (
                <p className="text-xs text-muted-foreground/70 mt-1">
                  {queuePosition === 1 ? "▶ Next in queue" : `#${queuePosition} in queue`}
                </p>
              )}
              {task.nextRetryAt && (task.status === "paused" || task.status === "throttled") && (
                <p className="text-xs text-yellow-500 mt-1">
                  Resumes at {new Date(task.nextRetryAt).toLocaleString()}
                </p>
              )}
              {task.status === "pending" && task.dependsOn && (
                <p className="text-xs text-muted-foreground mt-1">
                  Waiting on: <Link href={`/tasks/${task.dependsOn.id}`} className="text-foreground hover:underline" onClick={(e) => e.stopPropagation()}>{task.dependsOn.title}</Link>
                </p>
              )}
            </Link>
            {/* Desktop: hover to reveal */}
            <div className="relative z-[1] hidden sm:flex gap-1 shrink-0 self-center opacity-0 group-hover:opacity-100 transition-opacity">
              <ActionButtons task={task} onDelete={onDelete} onRetry={onRetry} onResume={onResume} onRunNow={onRunNow} onToggle={onToggle} onEditThrottled={onEditThrottled} onMoveToTop={onMoveToTop} onPin={onPin} pinned={pinned} queuePosition={queuePosition} />
            </div>
          </div>
          {/* Mobile: always visible below content */}
          <div className="relative z-[1] flex sm:hidden gap-1 mt-2 justify-end">
            <ActionButtons task={task} onDelete={onDelete} onRetry={onRetry} onResume={onResume} onRunNow={onRunNow} onToggle={onToggle} onEditThrottled={onEditThrottled} onMoveToTop={onMoveToTop} onPin={onPin} pinned={pinned} queuePosition={queuePosition} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
