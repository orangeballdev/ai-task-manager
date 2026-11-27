"use client";
import Link from "next/link";
import { Flame, GitFork, GitBranch, Bot, Cpu, Trash2, Pause, Play, PlayCircle, Pencil, MoreVertical } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import type { Task } from "@/lib/types";
import { formatRunUsage, hasReachedRunLimit } from "@/lib/max-runs";

/**
 * "3 / 5 runs" chip — only rendered for templates that have a run cap, so unlimited
 * schedules (the default) keep the card exactly as it was.
 */
function RunLimitBadge({ task }: { task: Task }) {
  if (task.maxRuns == null) return null;
  const done = hasReachedRunLimit(task);
  return (
    <span
      title={done ? "Run limit reached: this task won't be scheduled again" : "Scheduled runs used out of the configured maximum"}
      className={`text-xs px-1.5 py-0.5 rounded shrink-0 border ${
        done
          ? "bg-amber-500/15 text-amber-400 border-amber-500/30"
          : "bg-muted text-muted-foreground border-transparent"
      }`}
    >
      {formatRunUsage(task)}{done ? " (limit reached)" : ""}
    </span>
  );
}

function nextCronDate(expr: string, after?: string | null): Date | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { CronExpressionParser } = require("cron-parser") as typeof import("cron-parser");
    return CronExpressionParser.parse(expr, { currentDate: after ? new Date(after) : undefined }).next().toDate();
  } catch {
    return null;
  }
}

function TemplateActionsMenu({
  task,
  onDelete,
  onToggle,
  onRunNow,
}: {
  task: Task;
  onDelete?: (id: string) => void;
  onToggle?: (id: string, enabled: boolean) => void;
  onRunNow?: (id: string, count?: number) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Task actions"
        className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
        onClick={(e) => e.stopPropagation()}
      >
        <MoreVertical />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem render={<Link href={`/tasks/${task.id}/edit`} />}>
          <Pencil />
          Edit
        </DropdownMenuItem>
        {onRunNow && (
          <DropdownMenuItem onClick={() => onRunNow(task.id, 1)}>
            <PlayCircle />
            Run now
          </DropdownMenuItem>
        )}
        {onToggle && (
          <DropdownMenuItem onClick={() => onToggle(task.id, !task.isEnabled)}>
            {task.isEnabled ? <Pause /> : <Play />}
            {task.isEnabled ? "Disable" : "Enable"}
          </DropdownMenuItem>
        )}
        {onDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => onDelete(task.id)}>
              <Trash2 />
              Delete
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function RecurringTemplateCard({
  task,
  onDelete,
  onToggle,
  onRunNow,
  stats,
  selectable,
  selected,
  onSelectChange,
  compact,
  defaultBaseBranch = "main",
}: {
  task: Task;
  onDelete?: (id: string) => void;
  onToggle?: (id: string, enabled: boolean) => void;
  onRunNow?: (id: string, count?: number) => void;
  stats?: { completed: number; failed: number; total: number };
  selectable?: boolean;
  selected?: boolean;
  onSelectChange?: (id: string, selected: boolean) => void;
  compact?: boolean;
  defaultBaseBranch?: string;
}) {
  // A template that used up its run budget will never fire again, so don't advertise a
  // "next run" date for it.
  const next = task.isEnabled && task.cronExpression && !hasReachedRunLimit(task)
    ? nextCronDate(task.cronExpression, task.lastScheduledAt)
    : null;

  if (compact) {
    return (
      <div className="group relative">
        <Card
          className={`hover:border-border/60 transition-colors ${!task.isEnabled ? "opacity-50" : ""} ${selected ? "border-primary/60 bg-primary/5" : ""} ${selectable ? "cursor-pointer" : ""}`}
          onClick={selectable ? () => onSelectChange?.(task.id, !selected) : undefined}
        >
          <CardContent className="px-3 py-2">
            <div className="flex items-center gap-2">
              {selectable && (
                <div className="flex items-center shrink-0" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selected ?? false}
                    onChange={(e) => onSelectChange?.(task.id, e.target.checked)}
                    className="size-4 rounded border-2 border-muted-foreground accent-primary cursor-pointer"
                    aria-label={`Select ${task.title}`}
                  />
                </div>
              )}
              {task.isHailMary ? (
                <Flame className="size-3.5 text-orange-400 shrink-0" aria-label="Hail Mary task" />
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" className={`size-3.5 shrink-0 ${task.isEnabled ? "text-sky-400" : "text-muted-foreground"}`} viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clipRule="evenodd" />
                </svg>
              )}
              <Link href={`/tasks/${task.id}`} className="flex-1 min-w-0 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                <span className="font-medium text-card-foreground truncate text-sm">{task.title}</span>
                <span className="text-xs font-mono bg-muted text-muted-foreground px-1.5 py-0.5 rounded shrink-0">{task.cronExpression}</span>
                <RunLimitBadge task={task} />
                {!task.isEnabled && <span className="text-xs text-muted-foreground shrink-0">backlog</span>}
                {next && (
                  <span className="hidden sm:inline text-xs text-sky-400 truncate" suppressHydrationWarning>Next: {next.toLocaleString()}</span>
                )}
              </Link>
              <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
                <TemplateActionsMenu task={task} onDelete={onDelete} onToggle={onToggle} onRunNow={onRunNow} />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (compact) {
    return (
      <div className="group relative">
        <Card
          className={`hover:border-border/60 transition-colors ${!task.isEnabled ? "opacity-50" : ""} ${selected ? "border-primary/60 bg-primary/5" : ""} ${selectable ? "cursor-pointer" : ""}`}
          onClick={selectable ? () => onSelectChange?.(task.id, !selected) : undefined}
        >
          <CardContent className="px-3 py-2">
            <div className="flex items-center gap-2">
              {selectable && (
                <div className="flex items-center shrink-0" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selected ?? false}
                    onChange={(e) => onSelectChange?.(task.id, e.target.checked)}
                    className="size-4 rounded border-2 border-muted-foreground accent-primary cursor-pointer"
                    aria-label={`Select ${task.title}`}
                  />
                </div>
              )}
              {task.isHailMary ? (
                <Flame className="size-3.5 text-orange-400 shrink-0" aria-label="Hail Mary task" />
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" className={`size-3.5 shrink-0 ${task.isEnabled ? "text-sky-400" : "text-muted-foreground"}`} viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clipRule="evenodd" />
                </svg>
              )}
              <Link href={`/tasks/${task.id}`} className="flex-1 min-w-0 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                <span className="font-medium text-card-foreground truncate text-sm">{task.title}</span>
                <span className="text-xs font-mono bg-muted text-muted-foreground px-1.5 py-0.5 rounded shrink-0">{task.cronExpression}</span>
                <RunLimitBadge task={task} />
                {!task.isEnabled && <span className="text-xs text-muted-foreground shrink-0">backlog</span>}
                {next && (
                  <span className="hidden sm:inline text-xs text-sky-400 truncate" suppressHydrationWarning>Next: {next.toLocaleString()}</span>
                )}
              </Link>
              <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
                <TemplateActionsMenu task={task} onDelete={onDelete} onToggle={onToggle} onRunNow={onRunNow} />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="group relative">
      <Card
        className={`hover:border-border/60 transition-colors ${!task.isEnabled ? "opacity-50" : ""} ${selected ? "border-primary/60 bg-primary/5" : ""} ${selectable ? "cursor-pointer" : ""}`}
        onClick={selectable ? () => onSelectChange?.(task.id, !selected) : undefined}
      >
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            {/* Selection checkbox */}
            {selectable && (
              <div className="flex items-center mt-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={selected ?? false}
                  onChange={(e) => onSelectChange?.(task.id, e.target.checked)}
                  className="size-4 rounded border-2 border-muted-foreground accent-primary cursor-pointer"
                  aria-label={`Select ${task.title}`}
                />
              </div>
            )}

            {/* Hail Mary indicator / icon */}
            <div className="shrink-0 mt-1">
              {task.isHailMary ? (
                <Flame className="size-4 text-orange-400" aria-label="Hail Mary task" />
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" className={`size-4 ${task.isEnabled ? "text-sky-400" : "text-muted-foreground"}`} viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clipRule="evenodd" />
                </svg>
              )}
            </div>

            <Link href={`/tasks/${task.id}`} className="flex-1 min-w-0 block" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-start gap-2 mb-1 flex-wrap">
                <span className="font-medium text-card-foreground truncate">{task.title}</span>
                <span className="text-xs font-mono bg-muted text-muted-foreground px-1.5 py-0.5 rounded shrink-0">{task.cronExpression}</span>
                <RunLimitBadge task={task} />
                {!task.isEnabled && <span className="text-xs text-muted-foreground shrink-0">backlog</span>}
                {task.isHailMary && (
                  <span className="text-xs bg-orange-500/15 text-orange-400 border border-orange-500/30 px-1.5 py-0.5 rounded shrink-0">Hail Mary</span>
                )}
              </div>
              <p className="text-sm text-muted-foreground line-clamp-2">{task.description}</p>
              <div className="flex gap-1 mt-2 flex-wrap">
                  {task.repos.map((r) => (
                    <span key={r.id} className="inline-flex items-center gap-1 text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded">
                      <GitFork className="size-3" />{r.alias}
                    </span>
                  ))}
                  {(() => {
                    const slug = task.title.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").slice(0, 40).replace(/-+$/, "");
                    const effectiveBranch = task.branchName ?? task.targetBranch ?? (task.pushToMain ? defaultBaseBranch : `agent/${task.id.slice(0, 8)}-${slug}`);
                    if (!effectiveBranch) return null;
                    return (
                      <span className="inline-flex items-center gap-1 text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded shrink-0 max-w-[16rem] truncate font-mono">
                        <GitBranch className="size-3 shrink-0" />
                        {effectiveBranch}
                      </span>
                    );
                  })()}
                  {task.aiProvider?.name && (
                    <span className="inline-flex items-center gap-1 text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded shrink-0 max-w-[12rem] truncate">
                      <Bot className="size-3 shrink-0" />
                      {task.aiProvider.name}
                    </span>
                  )}
                  {(task.model ?? task.aiProvider?.model) && (
                    <span className="inline-flex items-center gap-1 text-xs bg-muted/60 text-muted-foreground/80 px-2 py-0.5 rounded shrink-0 max-w-[14rem] truncate font-mono">
                      <Cpu className="size-3 shrink-0" />
                      {task.model ?? task.aiProvider?.model}
                    </span>
                  )}
              </div>
              {next && (
                <p className="text-xs text-sky-400 mt-1" suppressHydrationWarning>Next run: {next.toLocaleString()}</p>
              )}
              {hasReachedRunLimit(task) && (
                <p className="text-xs text-amber-400 mt-1">
                  Run limit reached ({formatRunUsage(task)}). Edit the task to raise the limit.
                </p>
              )}
              {task.lastScheduledAt && (
                <p className="text-xs text-muted-foreground mt-0.5" suppressHydrationWarning>Last triggered: {new Date(task.lastScheduledAt).toLocaleString()}</p>
              )}
              {stats && stats.total > 0 && (
                <div className="flex items-center gap-2 mt-1.5" title={`${stats.completed} completed, ${stats.failed} failed, ${stats.total - stats.completed - stats.failed} other in the last 30 days`}>
                  <span className="text-xs text-muted-foreground">30d:</span>
                  {stats.completed > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-xs text-green-400">
                      <svg xmlns="http://www.w3.org/2000/svg" className="size-3" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>
                      {stats.completed}
                    </span>
                  )}
                  {stats.failed > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-xs text-red-400">
                      <svg xmlns="http://www.w3.org/2000/svg" className="size-3" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" /></svg>
                      {stats.failed}
                    </span>
                  )}
                  {stats.total - stats.completed - stats.failed > 0 && (
                    <span className="text-xs text-muted-foreground/60">
                      +{stats.total - stats.completed - stats.failed} other
                    </span>
                  )}
                </div>
              )}
            </Link>

            {/* Single kebab menu holds all per-card actions */}
            <div className="shrink-0 self-center" onClick={(e) => e.stopPropagation()}>
              <TemplateActionsMenu task={task} onDelete={onDelete} onToggle={onToggle} onRunNow={onRunNow} />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
