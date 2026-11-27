"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  pointerWithin,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useSensor,
  useSensors,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
  type CollisionDetection,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, arrayMove, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AlertTriangle, ArrowRight, Bot, Check, CheckSquare, ChevronDown, ChevronRight, CircleDashed, Copy, ExternalLink, Eye, EyeOff, Filter, FolderOpen, GitBranch, GitFork, GitMerge, Loader2, MessageSquarePlus, MinusCircle, Pause, PlayCircle, RefreshCw, RotateCcw, Search, Settings2, Square, Tag, Trash2, X } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { confirm } from "@/components/ui/confirm-dialog";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/StatusBadge";
import { PriorityBadge } from "@/components/PriorityBadge";
import { CopyButton } from "@/components/CopyButton";
import { TestPlanDisplay } from "@/components/TestPlanDisplay";
import { getCheckoutCommand, getCommitUrl, getCompareUrl, parseCommitShas, parsePRUrls } from "@/lib/git-urls";
import { copyToClipboard } from "@/lib/clipboard";
import { getDisplayStatus } from "@/lib/types";
import { isFileBasedOutput, getTaskFilesHref } from "@/lib/output-type";
import { useIsMobile } from "@/hooks/useIsMobile";
import { toggleKanbanColumnCollapsed, useCollapsedKanbanColumns } from "@/lib/use-layout-preferences";
import type { Task } from "@/lib/types";
import { comparePriorityThenPosition } from "@/lib/priority";
import { columnFor, hasNothingToReview, isHiddenOnBoard, visibleOnBoard, type ColumnKey } from "@/lib/kanban-column";
import { githubCommitUrl, readReviewMetadata, shortSha } from "@/lib/review-only";
import { beginDelete, endDelete } from "@/lib/delete-lock";
import { getAnalytics } from "@/components/WebAnalytics";

// ─── Modal-aware drag sensors ─────────────────────────────────────────────────
//
// React synthetic events bubble through portals in the React component tree (not the
// DOM tree). The task-detail Dialog is rendered via a portal inside KanbanCard's JSX,
// so a mousedown/touchstart inside the modal bubbles up through the React tree to the
// dnd-kit listener spread on the SortableTodoCard wrapper — triggering the drag sensor
// and blocking text selection inside the modal.
//
// Fix: subclass MouseSensor and TouchSensor to check whether the originating element is
// inside an open dialog/drawer ([role="dialog"]) and abort activation if so. This lets
// text selection, button clicks, and textarea input work normally inside modals while
// leaving card dragging fully intact when no modal is open.
function isInsideModal(event: Event): boolean {
  return !!(event.target as Element | null)?.closest('[role="dialog"]');
}

class ModalAwareMouseSensor extends MouseSensor {
  static activators: (typeof MouseSensor.activators) = [
    {
      eventName: "onMouseDown" as const,
      handler: (
        event: Parameters<(typeof MouseSensor.activators)[0]["handler"]>[0],
        options: Parameters<(typeof MouseSensor.activators)[0]["handler"]>[1],
      ): boolean => {
        if (isInsideModal(event.nativeEvent)) return false;
        return MouseSensor.activators[0].handler(event, options);
      },
    },
  ];
}

class ModalAwareTouchSensor extends TouchSensor {
  static activators: (typeof TouchSensor.activators) = [
    {
      eventName: "onTouchStart" as const,
      handler: (
        event: Parameters<(typeof TouchSensor.activators)[0]["handler"]>[0],
        options: Parameters<(typeof TouchSensor.activators)[0]["handler"]>[1],
      ): boolean => {
        if (isInsideModal(event.nativeEvent)) return false;
        return TouchSensor.activators[0].handler(event, options);
      },
    },
  ];
}

const ACTIVE_STATUSES = new Set(["pending", "running", "paused", "throttled", "awaiting_approval"]);

const COLUMNS: { key: ColumnKey; title: string }[] = [
  { key: "todo", title: "To Do" },
  { key: "in_progress", title: "In Progress" },
  { key: "in_review", title: "In Review" },
  { key: "done", title: "Done" },
];

// Only the In Review <-> Done transition is user-editable: it's the one piece of board
// state (reviewStatus) this app owns. To Do/In Progress are driven by the worker, which
// "is the only process that mutates task status" (see CLAUDE.md) — letting the column
// dropdown set those would fake a state the worker hasn't actually reached. Dragging a
// To Do card into In Progress doesn't set status either — it just bumps the task to the
// front of the worker's queue so it runs next.
const EDITABLE_COLUMNS = new Set<ColumnKey>(["in_review", "done"]);

const STATUS_LABELS: Record<ColumnKey, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
};

// Drag sources and the one column each can be dropped into (native HTML5 drag).
// "todo" is excluded because its drag-and-drop is handled by @dnd-kit:
//   - drag within To Do → reorder execution priority
//   - drag To Do → In Progress → bump to front of queue (or resume throttled task)
// Dragging Done -> In Review reopens it for review.
// Browsers suppress click when a real drag occurs, so draggable cards still open
// their detail dialog on a plain click with no conflict.
const DRAG_TARGETS: Partial<Record<ColumnKey, ColumnKey>> = {
  in_review: "done",
  done: "in_review",
};

const COLUMN_DROP_IDS = new Set(["in_progress", "in_review", "done"]);

function getFilesHref(task: Task): string {
  // `task.files` holds only top-level entries (see the query in tasks/kanban/page.tsx) —
  // a task's output files are grouped into a single wrapper folder, which opens
  // directly in the file browser.
  return getTaskFilesHref(task.files);
}

function parseLabels(labels: string | null): string[] {
  if (!labels) return [];
  try {
    const parsed = JSON.parse(labels) as string[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ─── Swim lanes ───────────────────────────────────────────────────────────────

type SwimLaneField = "repo" | "label" | "provider" | "template";

interface KanbanSettings {
  swimLanesEnabled: boolean;
  swimLaneField: SwimLaneField;
  // Whether To Do cards the user hid ("not now" tasks, Task.hiddenOnBoard) are shown,
  // dimmed with a "Hidden" badge. Off by default — hiding them is the point.
  showHiddenTasks: boolean;
}

const DEFAULT_SETTINGS: KanbanSettings = {
  swimLanesEnabled: false,
  swimLaneField: "repo",
  showHiddenTasks: false,
};

const SETTINGS_KEY = "kanban-settings";
const FILTERS_KEY = "kanban-filters";

interface KanbanFilters {
  repoFilter: string | null;
  searchQuery: string;
}

const DEFAULT_FILTERS: KanbanFilters = {
  repoFilter: null,
  searchQuery: "",
};

function loadKanbanFilters(): KanbanFilters {
  if (typeof window === "undefined") return DEFAULT_FILTERS;
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    if (!raw) return DEFAULT_FILTERS;
    return { ...DEFAULT_FILTERS, ...(JSON.parse(raw) as Partial<KanbanFilters>) };
  } catch {
    return DEFAULT_FILTERS;
  }
}

function saveKanbanFilters(filters: KanbanFilters) {
  try {
    localStorage.setItem(FILTERS_KEY, JSON.stringify(filters));
  } catch { /* ignore */ }
}

const SWIM_LANE_FIELD_LABELS: Record<SwimLaneField, string> = {
  repo: "Repository",
  label: "Label",
  provider: "AI Provider",
  template: "Task Type",
};

function loadSettings(): KanbanSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<KanbanSettings>) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(settings: KanbanSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* ignore */ }
}

/** Returns the swim lane key for a task given the selected field. */
function getSwimLaneKey(task: Task, field: SwimLaneField): string {
  switch (field) {
    case "repo":
      return task.repos.length > 0 ? task.repos.map((r) => r.alias).join(", ") : "No repository";
    case "label": {
      const labels = parseLabels(task.labels);
      return labels.length > 0 ? labels[0] : "No label";
    }
    case "provider":
      return getProviderLabel(task);
    case "template":
      return task.isRecurringTemplate ? "Recurring template" : task.recurringTemplateId ? "Recurring instance" : "One-off task";
  }
}

/** Short display name for the AI provider/connection that ran (or will run) a task. */
function getProviderLabel(task: Task): string {
  return task.aiProvider?.name ?? task.provider ?? "Unknown provider";
}

/** Groups tasks by swim lane key, preserving insertion order. Returns [laneKey, tasks][] sorted alphabetically. */
function groupBySwimLane(tasks: Task[], field: SwimLaneField): [string, Task[]][] {
  const map = new Map<string, Task[]>();
  for (const task of tasks) {
    const key = getSwimLaneKey(task, field);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(task);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}

// ─── Settings modal ───────────────────────────────────────────────────────────

function KanbanSettingsModal({
  open,
  onOpenChange,
  settings,
  onSettingsChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: KanbanSettings;
  onSettingsChange: (settings: KanbanSettings) => void;
}) {
  const isMobile = useIsMobile();

  const content = (
    <div className="flex flex-col gap-6 p-1">
      {/* Swim lanes toggle */}
      <div className="flex flex-col gap-3">
        <div>
          <h3 className="text-sm font-semibold">Swim Lanes</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Group tasks into horizontal rows by a shared field.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Switch
            id="swim-lanes-toggle"
            checked={settings.swimLanesEnabled}
            onCheckedChange={(checked) =>
              onSettingsChange({ ...settings, swimLanesEnabled: checked })
            }
          />
          <Label htmlFor="swim-lanes-toggle" className="cursor-pointer">
            {settings.swimLanesEnabled ? "Enabled" : "Disabled"}
          </Label>
        </div>

        {settings.swimLanesEnabled && (
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Group by</Label>
            <Select
              value={settings.swimLaneField}
              onValueChange={(v) =>
                onSettingsChange({ ...settings, swimLaneField: v as SwimLaneField })
              }
            >
              <SelectTrigger className="w-48">
                <SelectValue>
                  {(value: SwimLaneField) => SWIM_LANE_FIELD_LABELS[value]}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(SWIM_LANE_FIELD_LABELS) as SwimLaneField[]).map((field) => (
                  <SelectItem key={field} value={field}>
                    {SWIM_LANE_FIELD_LABELS[field]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground/70">
              {settings.swimLaneField === "repo" && "One row per repository (or set of repos) attached to each task."}
              {settings.swimLaneField === "label" && 'One row per first label. Unlabelled tasks appear in "No label".'}
              {settings.swimLaneField === "provider" && "One row per AI provider (CLI, API key, or named provider)."}
              {settings.swimLaneField === "template" && "Separates recurring templates, their instances, and one-off tasks."}
            </p>
          </div>
        )}
      </div>

      {/* Hidden To Do cards */}
      <div className="flex flex-col gap-3">
        <div>
          <h3 className="text-sm font-semibold">Hidden Tasks</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            To Do cards you&apos;ve hidden for later. Hiding only tidies the board, it doesn&apos;t stop a queued task from running.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Switch
            id="show-hidden-toggle"
            checked={settings.showHiddenTasks}
            onCheckedChange={(checked) =>
              onSettingsChange({ ...settings, showHiddenTasks: checked })
            }
          />
          <Label htmlFor="show-hidden-toggle" className="cursor-pointer">
            {settings.showHiddenTasks ? "Show hidden tasks" : "Hide hidden tasks"}
          </Label>
        </div>
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>Board Settings</DrawerTitle>
          </DrawerHeader>
          <div className="px-4 pb-6">{content}</div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Board Settings</DialogTitle>
        </DialogHeader>
        {content}
      </DialogContent>
    </Dialog>
  );
}

function ConflictBadge({ message }: { message?: string | null }) {
  return (
    <span
      title={message || "Merge conflict detected while syncing this branch"}
      className="inline-flex items-center gap-1 text-xs bg-destructive/10 text-destructive px-1.5 py-0.5 rounded-full border border-destructive/20"
    >
      <AlertTriangle className="size-3" />
      Conflict
    </span>
  );
}

// Shown when the task's PR/MR merged with an empty diff. These are deliberately
// kept out of the auto "merged -> Done" transition (see syncPRStatuses), so this
// badge explains why the card is still sitting in In Review.
function NoChangesBadge() {
  return (
    <span
      title="This PR merged with no code changes, so it wasn't auto-moved to Done. Drag it to Done once you've reviewed it."
      className="inline-flex items-center gap-1 text-xs bg-muted text-muted-foreground px-1.5 py-0.5 rounded-full border border-border"
    >
      <MinusCircle className="size-3" />
      No changes
    </span>
  );
}

// SortableTodoCard wraps KanbanCard with @dnd-kit sortable behaviour for the
// To Do column. Clicking still opens the detail dialog (PointerSensor only
// activates after the pointer moves ≥5 px, so plain clicks are not swallowed).
function SortableTodoCard(props: {
  task: Task;
  column: ColumnKey;
  onRequestChange: (id: string, description: string) => Promise<boolean>;
  onUpdateStatus: (id: string, reviewStatus: string | null) => Promise<void>;
  onRebase: (id: string) => Promise<boolean>;
  onQueueTask?: (id: string) => Promise<void>;
  onToggleEnabled?: (id: string, enabled: boolean) => Promise<void>;
  onDisableTask?: (id: string) => Promise<void>;
  onRetry?: (id: string) => Promise<void>;
  onSetHidden?: (ids: string[], hidden: boolean) => Promise<void>;
  deleting?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
  hasSelection?: boolean;
  onClearSelection?: () => void;
  coDragging?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: props.task.id });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        // Hidden (not just faded) while dragging: the DragOverlay renders the floating
        // copy that follows the cursor, so the source would otherwise show as a duplicate.
        // Other To Do cards still shift via the sortable strategy to open up the drop gap.
        // Cards that are along for the ride (selected + same column as the active drag,
        // but not themselves the drag source) fade instead of disappearing, so the board
        // visibly shows the whole group being picked up rather than just one card.
        opacity: isDragging ? 0 : props.coDragging ? 0.4 : 1,
        cursor: isDragging ? "grabbing" : "grab",
        // touch-manipulation lets the browser scroll the column on a finger swipe;
        // the TouchSensor's delay activation only takes over after a long-press,
        // so dragging a To Do card no longer fights with vertical scrolling on mobile.
        touchAction: "manipulation",
      }}
      {...attributes}
      {...listeners}
    >
      <KanbanCard {...props} />
    </div>
  );
}

function KanbanCard({ task, column: col, onRequestChange, onUpdateStatus, onRebase, onQueueTask, onToggleEnabled, onDisableTask, onRetry, onSetHidden, deleting, selected, onToggleSelect, hasSelection, onClearSelection, coDragging }: {
  task: Task;
  column: ColumnKey;
  onRequestChange: (id: string, description: string) => Promise<boolean>;
  onUpdateStatus: (id: string, reviewStatus: string | null) => Promise<void>;
  onRebase: (id: string) => Promise<boolean>;
  onQueueTask?: (id: string) => Promise<void>;
  onToggleEnabled?: (id: string, enabled: boolean) => Promise<void>;
  onDisableTask?: (id: string) => Promise<void>;
  onRetry?: (id: string) => Promise<void>;
  // Hides/unhides To Do cards on the board (Task.hiddenOnBoard). Only offered in To Do.
  onSetHidden?: (ids: string[], hidden: boolean) => Promise<void>;
  deleting?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
  // True while a card elsewhere on the board has an active selection — a plain
  // (non-shift) click on any card in that state clears the selection instead of
  // opening it, mirroring how clicking away from a multi-select clears it in a
  // desktop file manager.
  hasSelection?: boolean;
  onClearSelection?: () => void;
  // True while this card is part of the same-column selection being dragged
  // together with the actively-dragged card (but isn't the literal drag source
  // itself, which already hides/fades via its own drag hook). Gives every card
  // in the group a "picked up" look instead of just the one under the cursor.
  coDragging?: boolean;
}) {
  const labels = parseLabels(task.labels);
  // Review-only tickets never run (src/lib/review-only.ts): no provider, no retry,
  // no request-change — just their review metadata and approve/reopen by dragging.
  const reviewOnly = Boolean(task.reviewOnly);
  const reviewMeta = readReviewMetadata(task);
  const providerLabel = reviewOnly ? null : getProviderLabel(task);
  const commitShaMap = parseCommitShas(task.commitSha);
  // Tasks that work on an existing target/main branch never get a task.branchName (see
  // worker/index.ts), but the worker still records a commitSha for them — so anything
  // gating "is there a commit/branch link to show" must check this too, not just branchName.
  const hasAnyCommit = Object.keys(commitShaMap).length > 0;
  const prUrlsMap = parsePRUrls(task.prUrls);
  const prUrlEntries = Object.entries(prUrlsMap);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [requestingChange, setRequestingChange] = useState(false);
  const [changeText, setChangeText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [rebasing, setRebasing] = useState(false);
  const [confirmRebaseOpen, setConfirmRebaseOpen] = useState(false);
  const [checkoutCopied, setCheckoutCopied] = useState(false);
  const [queuingTask, setQueuingTask] = useState(false);
  const [togglingEnabled, setTogglingEnabled] = useState(false);
  const [disablingTask, setDisablingTask] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [togglingHidden, setTogglingHidden] = useState(false);
  // Only To Do cards can be hidden — anything running or awaiting review stays visible.
  const canHide = col === "todo" && Boolean(onSetHidden);
  const hidden = isHiddenOnBoard(task);
  // Terminal tasks can be re-run in one click, matching the list and detail views. A
  // completed/no_changes task lands in In Review/Done; failed/killed/timed-out sits in To Do.
  const canRetry = !reviewOnly && !task.isRecurringTemplate && ["failed", "killed", "timedout", "completed", "no_changes"].includes(task.status);
  // Unlike rebase (which needs a real branch to operate on), requesting a change just
  // schedules a follow-up run — that's meaningful for any completed task, including
  // file-output tasks and other runs that never pushed a branch/PR.
  const canRequestChange = !reviewOnly && (col === "in_review" || col === "done");
  const canRebase = task.branchName && (col === "in_review" || col === "done");
  // Once a task is in Done, mergeableState/ciStatus are no longer meaningful (merged
  // or manually resolved) — don't show stale conflict/CI chips regardless of how it got there.
  const hasConflicts = col !== "done" && task.mergeableState === "conflicting";
  const ciFailing = col !== "done" && task.ciStatus === "failing";
  // A no-change run with no open PR has nothing to review, so it's pinned to Done:
  // no "In Review" option and no dragging it back (columnFor() would bounce it anyway).
  const pinnedToDone = hasNothingToReview(task);
  const editableStatus = EDITABLE_COLUMNS.has(col) && !pinnedToDone;
  const isMobile = useIsMobile();
  const dragTarget = pinnedToDone ? undefined : DRAG_TARGETS[col];
  const isBacklog = getDisplayStatus(task) === "backlog";

  // @dnd-kit drag for column-to-column transitions (in_review ↔ done).
  // PointerSensor handles both mouse and touch, so this works on mobile.
  // The todo column uses SortableTodoCard/useSortable instead.
  const { attributes: dndAttributes, listeners: dndListeners, setNodeRef: setDragRef, isDragging: isColDragging } = useDraggable({
    id: task.id,
    data: { from: col },
    disabled: !dragTarget,
  });

  const submitChange = async () => {
    if (!changeText.trim()) return;
    setSubmitting(true);
    const ok = await onRequestChange(task.id, changeText.trim());
    setSubmitting(false);
    if (ok) {
      setChangeText("");
      setRequestingChange(false);
      setDetailsOpen(false);
    }
  };

  const handleRebase = async () => {
    setRebasing(true);
    await onRebase(task.id);
    setRebasing(false);
  };

  const copyCheckout = async () => {
    if (!task.branchName) return;
    try {
      await copyToClipboard(`git checkout ${task.branchName}`);
      setCheckoutCopied(true);
      toast.success("Copied checkout command");
      setTimeout(() => setCheckoutCopied(false), 2000);
    } catch {
      toast.error("Failed to copy to clipboard");
    }
  };

  const confirmRebaseDescription = hasConflicts && ciFailing
    ? "This branch has merge conflicts with the base branch and failing CI checks."
    : hasConflicts
      ? "This branch has merge conflicts with the base branch."
      : "CI is currently failing on this branch.";

  const confirmRebaseBody = (
    <div className="flex flex-col gap-3 text-sm text-muted-foreground">
      <p>{confirmRebaseDescription}</p>
      <p>Confirming will resume the agent on this task to:</p>
      <ul className="list-disc list-inside space-y-1">
        <li>fetch the latest base branch and rebase this branch onto it</li>
        <li>resolve any conflicts by hand, preserving changes from both sides</li>
        {ciFailing && <li>investigate and fix the failing CI checks</li>}
        <li>force-push the result once everything is resolved</li>
      </ul>
      <div className="flex gap-2 justify-end mt-1">
        <Button size="sm" variant="ghost" onClick={() => setConfirmRebaseOpen(false)} disabled={rebasing}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={async () => { setConfirmRebaseOpen(false); await handleRebase(); }}
          disabled={rebasing}
        >
          {rebasing ? <Loader2 className="size-3.5 animate-spin" /> : <GitMerge className="size-3.5" />}
          {rebasing ? "Queuing…" : "Resolve & Rebase"}
        </Button>
      </div>
    </div>
  );

  const quickActions = (
    <div className="flex flex-wrap gap-1.5 mt-2" onClick={(e) => e.stopPropagation()}>
      {prUrlEntries.length > 0 ? (
        prUrlEntries.map(([alias, pr]) => (
          <Button key={alias} size="sm" variant="outline" render={<a href={pr.url} target="_blank" rel="noopener noreferrer" />}>
            <ExternalLink className="size-3.5" />
            View PR{prUrlEntries.length > 1 ? ` (${alias})` : ""}{pr.merged ? " ✓" : ""}
          </Button>
        ))
      ) : task.prUrl ? (
        <Button size="sm" variant="outline" render={<a href={task.prUrl} target="_blank" rel="noopener noreferrer" />}>
          <ExternalLink className="size-3.5" />
          View PR
        </Button>
      ) : (
        task.repos.map((r) => {
          // Direct-push tasks (no PR) still leave a commit — link straight to it instead
          // of just the branch compare view, so there's a one-click way to see what landed.
          // commitSha is recorded even for tasks that work on an existing target/main branch
          // (which never get a task.branchName), so this must not depend on branchName.
          const sha = commitShaMap[r.alias];
          const commitHref = sha ? getCommitUrl(r.url, sha) : null;
          if (commitHref) {
            return (
              <Button key={r.id} size="sm" variant="outline" render={<a href={commitHref} target="_blank" rel="noopener noreferrer" />}>
                <ExternalLink className="size-3.5" />
                View Commit{task.repos.length > 1 ? ` (${r.alias})` : ""}
              </Button>
            );
          }
          if (!task.branchName) return null;
          const compareHref = getCompareUrl(r.url, task.branchName);
          if (!compareHref) return null;
          return (
            <Button key={r.id} size="sm" variant="outline" render={<a href={compareHref} target="_blank" rel="noopener noreferrer" />}>
              <ExternalLink className="size-3.5" />
              Compare{task.repos.length > 1 ? ` (${r.alias})` : ""}
            </Button>
          );
        })
      )}
      {task.branchName && (
        <Button size="sm" variant="outline" onClick={copyCheckout} title={`git checkout ${task.branchName}`}>
          {checkoutCopied ? <Check className="size-3.5 text-green-400" /> : <Copy className="size-3.5" />}
          {checkoutCopied ? "Copied!" : "Copy checkout"}
        </Button>
      )}
      {isFileBasedOutput(task.outputType) && task.status === "completed" && (
        <Button size="sm" variant="outline" render={<Link href={getFilesHref(task)} />}>
          <FolderOpen className="size-3.5" />
          View files
        </Button>
      )}
      {canRequestChange && !requestingChange && (
        <Button size="sm" variant="secondary" onClick={() => setRequestingChange(true)}>
          <MessageSquarePlus className="size-3.5" />
          Request Change
        </Button>
      )}
      {canRebase && (
        <Button size="sm" variant="outline" onClick={handleRebase} disabled={rebasing}>
          {rebasing ? <Loader2 className="size-3.5 animate-spin" /> : <GitMerge className="size-3.5" />}
          {rebasing ? "Queuing…" : "Rebase Branch"}
        </Button>
      )}
      {canRetry && onRetry && (
        <Button
          size="sm"
          variant="outline"
          disabled={retrying}
          onClick={async () => {
            setRetrying(true);
            await onRetry(task.id);
            setRetrying(false);
          }}
        >
          {retrying ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
          {retrying ? "Retrying…" : "Retry"}
        </Button>
      )}
      <Button size="sm" variant="outline" render={<Link href={`/tasks/new?from=${task.id}`} />}>
        <Copy className="size-3.5" />
        Duplicate
      </Button>
      <Button size="sm" render={<Link href={`/tasks/${task.id}?from=kanban`} />}>
        Go to task
        <ArrowRight className="size-3.5" />
      </Button>
    </div>
  );

  const cardDetails = (
    <div className="flex flex-col gap-4 p-1">
      {editableStatus && (
        <div>
          <Select value={col} onValueChange={(value) => onUpdateStatus(task.id, value === "done" ? "done" : "in_review")}>
            <SelectTrigger size="sm" className="w-28">
              <SelectValue>{(value: ColumnKey) => STATUS_LABELS[value]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="in_review">{STATUS_LABELS.in_review}</SelectItem>
              <SelectItem value="done">{STATUS_LABELS.done}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {task.status === "no_changes" && (
        <p className="text-xs text-muted-foreground">
          {task.prUrl || prUrlEntries.length > 0
            ? "No changes requested. This review found nothing to fix. The pull request is still open and awaiting merge."
            : "No code changes were made, nothing to commit or open a PR for."}
        </p>
      )}

      {!task.prUrl && task.prError && (
        <p className="text-xs text-amber-500" title={task.prError}>
          PR creation failed, create one manually using the compare link above.
        </p>
      )}

      {task.branchName && (
        <div>
          <p className="text-xs text-muted-foreground/70 uppercase tracking-wide mb-1.5">Branch</p>
          <div className="flex items-center gap-1 flex-wrap">
            <code className="text-xs bg-muted text-muted-foreground px-2 py-1 rounded font-mono">{task.branchName}</code>
            <span onClick={(e) => e.stopPropagation()}>
              <CopyButton text={getCheckoutCommand(task.branchName)} label="Copy checkout command" />
            </span>
          </div>
        </div>
      )}

      {isFileBasedOutput(task.outputType) && task.status === "completed" && (
        <div>
          <p className="text-xs text-muted-foreground/70 uppercase tracking-wide mb-1.5">Files</p>
          <Link
            href={getFilesHref(task)}
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1 text-sm text-blue-400 hover:underline"
          >
            <FolderOpen className="size-3.5" />
            View files
          </Link>
        </div>
      )}

      {task.testPlan && (
        <TestPlanDisplay testPlan={task.testPlan} compact />
      )}

      {canRequestChange && requestingChange && (
        <div className="flex flex-col gap-1.5">
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
            <Button size="sm" className="flex-1" onClick={submitChange} disabled={!changeText.trim() || submitting}>
              {submitting ? "Scheduling…" : "Schedule"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setRequestingChange(false); setChangeText(""); }} disabled={submitting}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {isBacklog && onQueueTask && (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            className="flex-1"
            disabled={queuingTask}
            onClick={async () => {
              setQueuingTask(true);
              await onQueueTask(task.id);
              setQueuingTask(false);
              setDetailsOpen(false);
            }}
          >
            <PlayCircle className="size-3.5" />
            {queuingTask ? "Queuing…" : "Queue Task"}
          </Button>
          <Button size="sm" className="flex-1" render={<Link href={`/tasks/${task.id}?from=kanban`} />}>
            Go to task
            <ArrowRight className="size-3.5" />
          </Button>
        </div>
      )}
      {task.status === "throttled" && onDisableTask && (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            className="flex-1"
            disabled={disablingTask}
            onClick={async () => {
              setDisablingTask(true);
              await onDisableTask(task.id);
              setDisablingTask(false);
              setDetailsOpen(false);
            }}
          >
            <Pause className="size-3.5" />
            {disablingTask ? "Moving…" : "Move to Backlog"}
          </Button>
          <Button size="sm" className="flex-1" render={<Link href={`/tasks/${task.id}`} />}>
            Go to task
            <ArrowRight className="size-3.5" />
          </Button>
        </div>
      )}

      {onToggleEnabled && task.status !== "completed" && task.status !== "no_changes" && task.status !== "failed" &&
        // Throttled tasks already get a dedicated "Move to Backlog" action above (onDisableTask),
        // which fully resets them to pending+disabled. Showing this generic toggle too would put
        // two identically-labeled "Move to Backlog" buttons on the same card that do different
        // things (this one would only flip isEnabled and leave status stuck at "throttled").
        !(task.status === "throttled" && onDisableTask) && (
        <div className="pt-1 border-t border-border/40">
          <Button
            size="sm"
            variant={task.isEnabled ? "outline" : "secondary"}
            disabled={togglingEnabled}
            onClick={async () => {
              setTogglingEnabled(true);
              await onToggleEnabled(task.id, !task.isEnabled);
              setTogglingEnabled(false);
            }}
            className={task.isEnabled ? "text-muted-foreground hover:text-foreground" : ""}
            title={task.isEnabled ? "Disable this task so the worker skips it — pending tasks show up in the Backlog" : "Re-enable this task so the worker can pick it up again"}
          >
            {togglingEnabled ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : task.isEnabled ? (
              <Pause className="size-3.5" />
            ) : (
              <PlayCircle className="size-3.5" />
            )}
            {togglingEnabled
              ? task.isEnabled ? "Moving to backlog…" : "Enabling…"
              : task.isEnabled ? "Move to Backlog" : "Enable Task"}
          </Button>
        </div>
      )}

      {canHide && (
        <div className="pt-1 border-t border-border/40 flex flex-col gap-1">
          <Button
            size="sm"
            variant="outline"
            className="self-start text-muted-foreground hover:text-foreground"
            disabled={togglingHidden}
            onClick={async () => {
              setTogglingHidden(true);
              await onSetHidden!([task.id], !hidden);
              setTogglingHidden(false);
              // A card hidden while hidden cards aren't shown disappears from the board,
              // taking this dialog with it — close it explicitly so its state is reset.
              if (!hidden) setDetailsOpen(false);
            }}
            title={hidden ? "Show this card in the To Do column again" : "Hide this card from the To Do column until you need it. It still runs if it's queued."}
          >
            {togglingHidden ? <Loader2 className="size-3.5 animate-spin" /> : hidden ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
            {togglingHidden ? (hidden ? "Unhiding…" : "Hiding…") : hidden ? "Unhide from board" : "Hide from board"}
          </Button>
        </div>
      )}
    </div>
  );

  // No inline transform on the source: the DragOverlay renders the floating copy that
  // follows the cursor. The source card stays put (faded via isColDragging below) to hold
  // its slot. This also sidesteps @dnd-kit's adjustScale(), which would otherwise scale the
  // dragged element up to the In Review/Done column droppable's dimensions.
  return (
    <div
      ref={dragTarget ? setDragRef : undefined}
      // touch-manipulation (not touch-none): with the TouchSensor's delay activation,
      // we let the browser handle short swipes as column scrolls and only take over
      // once the user has long-pressed past the activation threshold. touch-none would
      // block scrolling even before the drag is armed.
      className={dragTarget ? "cursor-grab active:cursor-grabbing touch-manipulation" : undefined}
      {...(dragTarget ? { ...dndAttributes, ...dndListeners } : {})}
    >
    <Card
      className={`relative py-0 hover:border-border/60 transition-colors cursor-pointer ${isColDragging || coDragging ? "opacity-40 pointer-events-none" : ""} ${deleting ? "opacity-40 pointer-events-none animate-pulse" : ""} ${selected ? "ring-2 ring-primary border-primary/50 bg-primary/5" : ""} ${hidden && !selected ? "opacity-60 border-dashed" : ""}`}
      title={hasSelection ? "Click to clear selection" : "Shift+click to select multiple cards, then drag one to move them all together"}
      onClick={(e) => {
        if (e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          onToggleSelect?.(task.id);
          return;
        }
        // Windows-Explorer-style: a plain click while a multi-select is active
        // clears the selection instead of opening the card underneath it.
        if (hasSelection) {
          e.preventDefault();
          e.stopPropagation();
          onClearSelection?.();
          return;
        }
        setDetailsOpen(true);
      }}
    >
      {selected && (
        <div className="absolute -top-1.5 -left-1.5 z-10 flex items-center justify-center size-4 rounded-full bg-primary text-primary-foreground shadow">
          <Check className="size-2.5" />
        </div>
      )}
      <CardContent className="p-3">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium text-card-foreground line-clamp-2">{task.title}</p>
          <div className="flex flex-col items-end gap-1 shrink-0">
            <div className="flex items-center gap-1">
              {hidden && (
                <span
                  title="Hidden from the board. Shown because Board Settings → Show hidden tasks is on."
                  className="inline-flex items-center gap-1 text-xs bg-muted text-muted-foreground border border-border px-1.5 py-0.5 rounded-full"
                >
                  <EyeOff className="size-3" />
                  Hidden
                </span>
              )}
              {!task.isEnabled && (
                <span className="text-xs bg-zinc-800 text-zinc-400 border border-zinc-600 px-1.5 py-0.5 rounded-full">
                  Disabled
                </span>
              )}
              {task.hasConflict && !hasConflicts && <ConflictBadge message={task.conflictMessage} />}
              {task.noChanges && <NoChangesBadge />}
              <PriorityBadge priority={task.priority} />
              {reviewOnly ? (
                <span
                  title="Review-only ticket: a reminder to review work done elsewhere. It never runs an agent."
                  className="inline-flex items-center gap-1 text-xs bg-sky-500/10 text-sky-400 px-1.5 py-0.5 rounded-full border border-sky-500/20"
                >
                  <Eye className="size-3" />
                  Review
                </span>
              ) : (
                <StatusBadge status={getDisplayStatus(task)} />
              )}
            </div>
            {task.prUrl && (() => {
              const blocked = hasConflicts || ciFailing;
              if (blocked) {
                const reason = hasConflicts && ciFailing ? "Conflicts · CI failing" : hasConflicts ? "Conflicts" : "CI failing";
                return (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setConfirmRebaseOpen(true); }}
                    disabled={rebasing}
                    title="This PR can't be merged yet: click to have the agent rebase, resolve conflicts, and fix CI"
                    className="inline-flex items-center gap-1 text-xs bg-red-500/10 text-red-500 px-1.5 py-0.5 rounded-full border border-red-500/20 hover:bg-red-500/20 disabled:opacity-60"
                  >
                    <AlertTriangle className="size-3 shrink-0" />
                    {rebasing ? "Queuing…" : reason}
                  </button>
                );
              }
              if (task.ciStatus === "pending") {
                return (
                  <span className="inline-flex items-center gap-1 text-xs bg-amber-500/10 text-amber-500 px-1.5 py-0.5 rounded-full border border-amber-500/20">
                    <CircleDashed className="size-3 shrink-0" />
                    CI running
                  </span>
                );
              }
              return null;
            })()}
          </div>
        </div>
        {reviewOnly && (reviewMeta.branch || reviewMeta.commits.length > 0 || reviewMeta.prUrl) && (
          <div className="flex flex-wrap items-center gap-1 mt-2">
            {reviewMeta.branch && (
              <span className="inline-flex items-center gap-1 text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded font-mono max-w-[10rem] truncate">
                <GitBranch className="size-3 shrink-0" />
                {reviewMeta.branch}
              </span>
            )}
            {reviewMeta.commits.slice(0, 3).map((sha) => {
              const href = githubCommitUrl(reviewMeta, sha);
              return href ? (
                <a key={sha} href={href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="text-xs text-blue-400 hover:underline font-mono" title={sha}>
                  @{shortSha(sha)}
                </a>
              ) : (
                <code key={sha} className="text-xs bg-muted text-muted-foreground px-1.5 py-0.5 rounded font-mono" title={sha}>@{shortSha(sha)}</code>
              );
            })}
            {reviewMeta.commits.length > 3 && <span className="text-xs text-muted-foreground">+{reviewMeta.commits.length - 3}</span>}
            {reviewMeta.prUrl && (
              <a href={reviewMeta.prUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="text-xs text-blue-400 hover:underline">
                View PR
              </a>
            )}
          </div>
        )}
        {(task.repos.length > 0 || providerLabel) && (
          <div className="flex flex-wrap items-center gap-1 mt-2">
            {task.repos.map((r) => {
              const sha = commitShaMap[r.alias];
              const commitHref = sha ? getCommitUrl(r.url, sha) : null;
              return (
                <span key={r.id} className="inline-flex items-center gap-1 text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded">
                  <GitFork className="size-3 shrink-0" />
                  {r.alias}
                  {commitHref && (
                    <a href={commitHref} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="text-blue-400 hover:underline font-mono">
                      @{sha.slice(0, 7)}
                    </a>
                  )}
                </span>
              );
            })}
            {task.branchName && (
              <span className="inline-flex items-center gap-1 text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded font-mono max-w-[10rem] truncate">
                <GitBranch className="size-3 shrink-0" />
                {task.branchName}
              </span>
            )}
            {providerLabel && (
              <span
                title={`AI provider: ${providerLabel}`}
                className="inline-flex items-center gap-1 text-xs bg-violet-500/10 text-violet-400 px-2 py-0.5 rounded border border-violet-500/20 max-w-[10rem] truncate"
              >
                <Bot className="size-3 shrink-0" />
                {providerLabel}
              </span>
            )}
          </div>
        )}
        {(task.prUrl || task.branchName || hasAnyCommit || (isFileBasedOutput(task.outputType) && task.status === "completed")) && (
          <div className="flex flex-wrap gap-2 mt-1.5">
            {prUrlEntries.length > 1 ? (
              // Multi-repo task: one PR per repo — link each individually rather than
              // showing a single "View PR" that only points at the first one.
              prUrlEntries.map(([alias, pr]) => (
                <a key={alias} href={pr.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="text-xs text-blue-400 hover:underline">
                  View PR ({alias}){pr.merged ? " ✓" : ""}
                </a>
              ))
            ) : task.prUrl && (
              <a href={task.prUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="text-xs text-blue-400 hover:underline">
                View PR
              </a>
            )}
            {!task.prUrl && task.repos.map((r) => {
              // Direct-push tasks (no PR) still leave a commit — prefer linking straight to
              // it over the branch compare view, same as the quick-action button above.
              const sha = commitShaMap[r.alias];
              const commitHref = sha ? getCommitUrl(r.url, sha) : null;
              if (commitHref) {
                return (
                  <a key={r.id} href={commitHref} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="text-xs text-blue-400 hover:underline">
                    View Commit{task.repos.length > 1 ? ` (${r.alias})` : ""}
                  </a>
                );
              }
              if (!task.branchName) return null;
              const compareHref = getCompareUrl(r.url, task.branchName);
              if (!compareHref) return null;
              return (
                <a key={r.id} href={compareHref} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="text-xs text-blue-400 hover:underline">
                  View diff{task.repos.length > 1 ? ` (${r.alias})` : ""}
                </a>
              );
            })}
            {isFileBasedOutput(task.outputType) && task.status === "completed" && (
              <Link
                href={getFilesHref(task)}
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1 text-xs text-blue-400 hover:underline"
              >
                <FolderOpen className="size-3" />
                View files
              </Link>
            )}
          </div>
        )}
        {task.status === "no_changes" && (
          <p className="mt-1.5 text-xs text-muted-foreground">
            {task.prUrl || prUrlEntries.length > 0 ? "No changes requested" : "No code changes"}
          </p>
        )}
        {!task.prUrl && task.prError && (
          <p className="mt-1.5 text-xs text-amber-500" title={task.prError}>
            PR creation failed
          </p>
        )}
        {labels.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {labels.map((l) => (
              <span key={l} className="inline-flex items-center gap-1 text-xs bg-primary/10 text-primary/80 px-1.5 py-0.5 rounded-full border border-primary/20">
                <Tag className="size-2.5 shrink-0" />
                {l}
              </span>
            ))}
          </div>
        )}
      </CardContent>
      <span onClick={(e) => e.stopPropagation()}>
        {isMobile ? (
          <Drawer open={detailsOpen} onOpenChange={setDetailsOpen}>
            <DrawerContent>
              <DrawerHeader>
                <div className="flex items-center gap-1.5 mb-0.5">
                  {!task.isEnabled && (
                    <span className="text-xs bg-zinc-800 text-zinc-400 border border-zinc-600 px-1.5 py-0.5 rounded-full">
                      Disabled
                    </span>
                  )}
                  <StatusBadge status={getDisplayStatus(task)} />
                  <PriorityBadge priority={task.priority} />
                  {task.hasConflict && <ConflictBadge message={task.conflictMessage} />}
                  {task.noChanges && <NoChangesBadge />}
                </div>
                <DrawerTitle>{task.title}</DrawerTitle>
                {quickActions}
              </DrawerHeader>
              {cardDetails}
            </DrawerContent>
          </Drawer>
        ) : (
          <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
            <DialogContent className="max-h-[85vh] overflow-y-auto">
              <DialogHeader>
                <div className="flex items-center gap-1.5 mb-0.5">
                  {!task.isEnabled && (
                    <span className="text-xs bg-zinc-800 text-zinc-400 border border-zinc-600 px-1.5 py-0.5 rounded-full">
                      Disabled
                    </span>
                  )}
                  <StatusBadge status={getDisplayStatus(task)} />
                  <PriorityBadge priority={task.priority} />
                  {task.hasConflict && <ConflictBadge message={task.conflictMessage} />}
                  {task.noChanges && <NoChangesBadge />}
                </div>
                <DialogTitle className="text-lg leading-snug">{task.title}</DialogTitle>
                {quickActions}
              </DialogHeader>
              {cardDetails}
            </DialogContent>
          </Dialog>
        )}
        {isMobile ? (
          <Drawer open={confirmRebaseOpen} onOpenChange={setConfirmRebaseOpen}>
            <DrawerContent>
              <DrawerHeader>
                <DrawerTitle>Make this branch mergeable?</DrawerTitle>
              </DrawerHeader>
              <div className="px-4 pb-4">{confirmRebaseBody}</div>
            </DrawerContent>
          </Drawer>
        ) : (
          <Dialog open={confirmRebaseOpen} onOpenChange={setConfirmRebaseOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Make this branch mergeable?</DialogTitle>
              </DialogHeader>
              {confirmRebaseBody}
            </DialogContent>
          </Dialog>
        )}
      </span>
    </Card>
    </div>
  );
}

// Presentational copy of a card rendered inside the DragOverlay so the dragged card
// visibly follows the cursor. It carries no drag hooks (so it can't double-register a
// draggable id) and no dialogs/handlers — it's purely the card's visual top section.
function KanbanCardPreview({ task, extraCount = 0 }: { task: Task; extraCount?: number }) {
  const labels = parseLabels(task.labels);
  const providerLabel = task.reviewOnly ? null : getProviderLabel(task);
  return (
    <div className="relative">
      {/* Stacked cards behind the top one hint that multiple selected cards are being dragged together. */}
      {extraCount > 0 && (
        <>
          <div className="absolute inset-0 translate-x-2 translate-y-2 rotate-2 rounded-xl border bg-card opacity-60" />
          <div className="absolute inset-0 translate-x-1 translate-y-1 rotate-1 rounded-xl border bg-card opacity-80" />
        </>
      )}
      <Card className="relative py-0 shadow-lg cursor-grabbing rotate-1">
        {extraCount > 0 && (
          <div className="absolute -top-2 -right-2 z-10 flex items-center justify-center min-w-5 h-5 px-1 rounded-full bg-primary text-primary-foreground text-xs font-semibold shadow">
            +{extraCount}
          </div>
        )}
      <CardContent className="p-3">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium text-card-foreground line-clamp-2">{task.title}</p>
          <div className="flex items-center gap-1 shrink-0">
            {!task.isEnabled && (
              <span className="text-xs bg-zinc-800 text-zinc-400 border border-zinc-600 px-1.5 py-0.5 rounded-full">
                Disabled
              </span>
            )}
            {task.hasConflict && <ConflictBadge message={task.conflictMessage} />}
            <StatusBadge status={getDisplayStatus(task)} />
          </div>
        </div>
        {(task.repos.length > 0 || providerLabel) && (
          <div className="flex flex-wrap items-center gap-1 mt-2">
            {task.repos.map((r) => (
              <span key={r.id} className="inline-flex items-center gap-1 text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded">
                <GitFork className="size-3 shrink-0" />
                {r.alias}
              </span>
            ))}
            {task.branchName && (
              <span className="inline-flex items-center gap-1 text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded font-mono max-w-[10rem] truncate">
                <GitBranch className="size-3 shrink-0" />
                {task.branchName}
              </span>
            )}
            {providerLabel && (
              <span className="inline-flex items-center gap-1 text-xs bg-violet-500/10 text-violet-400 px-2 py-0.5 rounded border border-violet-500/20 max-w-[10rem] truncate">
                <Bot className="size-3 shrink-0" />
                {providerLabel}
              </span>
            )}
          </div>
        )}
        {!task.prUrl && task.prError && (
          <p className="mt-1.5 text-xs text-amber-500" title={task.prError}>
            PR creation failed
          </p>
        )}
        {labels.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {labels.map((l) => (
              <span key={l} className="inline-flex items-center gap-1 text-xs bg-primary/10 text-primary/80 px-1.5 py-0.5 rounded-full border border-primary/20">
                <Tag className="size-2.5 shrink-0" />
                {l}
              </span>
            ))}
          </div>
        )}
      </CardContent>
      </Card>
    </div>
  );
}

function KanbanColumn({ col, tasks, collapsed, onToggleCollapsed, ...cardProps }: {
  col: { key: ColumnKey; title: string };
  tasks: Task[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onRequestChange: (id: string, description: string) => Promise<boolean>;
  onUpdateStatus: (id: string, reviewStatus: string | null) => Promise<void>;
  onRebase: (id: string) => Promise<boolean>;
  onQueueTask?: (id: string) => Promise<void>;
  onToggleEnabled?: (id: string, enabled: boolean) => Promise<void>;
  onDisableTask?: (id: string) => Promise<void>;
  onRetry?: (id: string) => Promise<void>;
  onSetHidden?: (ids: string[], hidden: boolean) => Promise<void>;
  // To Do only: how many cards (after the repo/search filter) are hidden, whether
  // they're currently shown, and a toggle to reveal/conceal them without opening Board Settings.
  hiddenCount?: number;
  showHidden?: boolean;
  onToggleShowHidden?: () => void;
  onClearDone?: () => void;
  clearingDone?: boolean;
  deletingIds?: Set<string>;
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string) => void;
  onClearSelection?: () => void;
  // Adds or removes a batch of ids from the board's selection in one go — backs the
  // per-column "select all" control below, so it can select/deselect every card
  // currently visible in this column (i.e. already filtered) with a single click.
  onSelectAll?: (ids: string[], select: boolean) => void;
  // Id of the card currently being dragged anywhere on the board — used to figure out
  // whether *this* column is the source column of an active multi-card drag, so its
  // other selected cards can be dimmed alongside the literal drag source.
  activeDragId?: string | null;
}) {
  const isMobile = useIsMobile();
  // Collapse is only allowed on mobile — on desktop columns are always expanded.
  const isCollapsed = isMobile && collapsed;

  // @dnd-kit droppable — covers all columns that accept drops:
  //   in_progress: accepts todo cards dragged to run now
  //   in_review / done: accept column-to-column transitions via useDraggable
  const acceptsDrop = col.key === "in_progress" || col.key === "in_review" || col.key === "done";
  const { setNodeRef: setDndDropRef, isOver: isDndOver } = useDroppable({
    id: col.key,
    disabled: !acceptsDrop,
  });

  const highlightDrop = acceptsDrop && isDndOver;

  // This column is the source of the active drag if the dragged card lives in it.
  // Combined with "the drag source is part of a >1 selection", every *other* selected
  // card in this column is being moved along with it and should look picked-up too.
  const isDragSourceColumn = cardProps.activeDragId != null && tasks.some((t) => t.id === cardProps.activeDragId);
  const isMultiCardDrag = isDragSourceColumn && (cardProps.selectedIds?.size ?? 0) > 1 && (cardProps.selectedIds?.has(cardProps.activeDragId!) ?? false);

  // Bulk select: ids of the cards actually rendered in this column, i.e. already
  // narrowed by the board's repo filter / search query — selecting "all" here only
  // ever grabs what's currently in view, never hidden/filtered-out cards.
  const columnTaskIds = tasks.map((t) => t.id);
  const allSelected = columnTaskIds.length > 0 && columnTaskIds.every((id) => cardProps.selectedIds?.has(id));

  return (
    <div className={isCollapsed ? "md:min-w-[40px]" : "md:flex-1 md:min-w-[280px] md:max-w-[340px] flex flex-col"}>
      <div className="flex items-center justify-between mb-2 px-1">
        <button
          type="button"
          onClick={isMobile ? onToggleCollapsed : undefined}
          className={`flex items-center gap-1.5 ${isMobile ? "cursor-pointer hover:opacity-80" : "cursor-default"}`}
          aria-expanded={isMobile ? !isCollapsed : undefined}
          aria-label={isMobile ? `${isCollapsed ? "Expand" : "Collapse"} ${col.title} column` : undefined}
        >
          {isMobile && (isCollapsed ? <ChevronRight className="size-3.5 text-muted-foreground" /> : <ChevronDown className="size-3.5 text-muted-foreground" />)}
          <h2 className="text-sm font-semibold text-foreground">{col.title}</h2>
          <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full tabular-nums">{tasks.length}</span>
        </button>
        {!isCollapsed && (tasks.length > 0 || (cardProps.hiddenCount ?? 0) > 0) && (
          <div className="flex items-center gap-1">
            {col.key === "todo" && (cardProps.hiddenCount ?? 0) > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-1.5 text-xs text-muted-foreground hover:text-foreground"
                onClick={cardProps.onToggleShowHidden}
                title={cardProps.showHidden ? "Hidden cards are shown, click to hide them again" : "Click to show the cards you've hidden"}
              >
                {cardProps.showHidden ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
                {cardProps.hiddenCount} hidden
              </Button>
            )}
            {tasks.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-1.5 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => cardProps.onSelectAll?.(columnTaskIds, !allSelected)}
              title={
                allSelected
                  ? `Deselect all ${tasks.length} card${tasks.length === 1 ? "" : "s"} in ${col.title}`
                  : `Select all ${tasks.length} card${tasks.length === 1 ? "" : "s"} in view in ${col.title}, to drag them together`
              }
            >
              {allSelected ? <CheckSquare className="size-3" /> : <Square className="size-3" />}
              {allSelected ? "Deselect all" : "Select all"}
            </Button>
            )}
            {col.key === "done" && tasks.length > 0 && (
              <Button size="sm" variant="ghost" className="h-6 px-1.5 text-xs text-muted-foreground hover:text-destructive" onClick={cardProps.onClearDone} disabled={cardProps.clearingDone}>
                {cardProps.clearingDone ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
                {cardProps.clearingDone ? "Deleting…" : "Clear all"}
              </Button>
            )}
          </div>
        )}
      </div>
      {!isCollapsed && (
        <div
          ref={acceptsDrop ? setDndDropRef : undefined}
          className={`flex flex-col gap-2 min-h-[100px] flex-1 rounded-lg transition-colors ${highlightDrop ? "bg-primary/5 ring-2 ring-primary/30" : ""}`}
        >
          {col.key === "todo"
            ? tasks.map((task) => (
                <SortableTodoCard
                  key={task.id}
                  task={task}
                  column={col.key}
                  onRequestChange={cardProps.onRequestChange}
                  onUpdateStatus={cardProps.onUpdateStatus}
                  onRebase={cardProps.onRebase}
                  onQueueTask={cardProps.onQueueTask}
                  onToggleEnabled={cardProps.onToggleEnabled}
                  onDisableTask={cardProps.onDisableTask}
                  onRetry={cardProps.onRetry}
                  onSetHidden={cardProps.onSetHidden}
                  deleting={cardProps.deletingIds?.has(task.id)}
                  selected={cardProps.selectedIds?.has(task.id)}
                  onToggleSelect={cardProps.onToggleSelect}
                  hasSelection={(cardProps.selectedIds?.size ?? 0) > 0}
                  onClearSelection={cardProps.onClearSelection}
                  coDragging={isMultiCardDrag && task.id !== cardProps.activeDragId && (cardProps.selectedIds?.has(task.id) ?? false)}
                />
              ))
            : tasks.map((task) => (
                <KanbanCard
                  key={task.id}
                  task={task}
                  column={col.key}
                  onRequestChange={cardProps.onRequestChange}
                  onUpdateStatus={cardProps.onUpdateStatus}
                  onRebase={cardProps.onRebase}
                  onQueueTask={cardProps.onQueueTask}
                  onToggleEnabled={cardProps.onToggleEnabled}
                  onDisableTask={cardProps.onDisableTask}
                  onRetry={cardProps.onRetry}
                  onSetHidden={cardProps.onSetHidden}
                  deleting={cardProps.deletingIds?.has(task.id)}
                  selected={cardProps.selectedIds?.has(task.id)}
                  onToggleSelect={cardProps.onToggleSelect}
                  hasSelection={(cardProps.selectedIds?.size ?? 0) > 0}
                  onClearSelection={cardProps.onClearSelection}
                  coDragging={isMultiCardDrag && task.id !== cardProps.activeDragId && (cardProps.selectedIds?.has(task.id) ?? false)}
                />
              ))}
          {tasks.length === 0 && (
            <div className="text-xs text-muted-foreground/50 italic px-1 py-2">No tasks</div>
          )}
        </div>
      )}
    </div>
  );
}

export function KanbanBoard({ tasks: initialTasks }: { tasks: Task[] }) {
  const [tasks, setTasks] = useState(initialTasks);
  const [clearingDone, setClearingDone] = useState(false);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [repoFilter, setRepoFilter] = useState<string | null>(null);
  const [repoMenuOpen, setRepoMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const repoMenuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<KanbanSettings>(DEFAULT_SETTINGS);
  // Id of the card currently being dragged — drives the DragOverlay floating preview.
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  // Shift-click multi-select: ids of cards selected for a bulk drag-to-move. When the
  // dragged card is part of this set (and more than one card is selected), the whole
  // selection is moved together instead of just the dragged card.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const collapsedColumns = useCollapsedKanbanColumns();

  const toggleCardSelection = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  // Backs each column's "select all" control: adds or removes a whole batch of ids
  // (the cards currently rendered in that column, already filtered by repo/search) from
  // the selection in one update, rather than toggling them one at a time.
  const setColumnSelection = useCallback((ids: string[], select: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (select) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  // Drop any selected ids whose task no longer exists (deleted, filtered out, etc.)
  // so a stale selection can't be "moved" after the fact. Adjusted during render
  // when the task list changes, so a stale selection is never painted.
  const [selectionTasks, setSelectionTasks] = useState(tasks);
  if (selectionTasks !== tasks) {
    setSelectionTasks(tasks);
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const liveIds = new Set(tasks.map((t) => t.id));
      const next = new Set([...prev].filter((id) => liveIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }

  // Escape clears the current selection.
  useEffect(() => {
    if (selectedIds.size === 0) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearSelection();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [selectedIds.size, clearSelection]);

  // Mouse: a 5px drag is enough to start dragging — keeps desktop snappy.
  // Touch: require a 200ms long-press before a drag begins (with 5px tolerance so a
  // tiny finger jiggle during the hold doesn't cancel it). Without this, any vertical
  // finger swipe on a card immediately triggers a drag and the column can't be
  // scrolled on mobile. Using delay-based activation also means we can keep
  // `touch-action: manipulation` on the card so the browser still handles the swipe
  // as a scroll until the long-press threshold is met.
  const sensors = useSensors(
    useSensor(ModalAwareMouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(ModalAwareTouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } })
  );

  // For column-to-column drags (in_review ↔ done), use pointer position to find
  // the column the pointer is over. Fallback to closestCenter for todo reorders.
  const collisionDetection = useCallback<CollisionDetection>((args) => {
    const fromCol = (args.active.data.current as { from?: ColumnKey } | undefined)?.from;
    if (fromCol === "in_review" || fromCol === "done") {
      return pointerWithin({
        ...args,
        droppableContainers: args.droppableContainers.filter((c) => COLUMN_DROP_IDS.has(String(c.id))),
      });
    }
    // Todo-column drags use useSortable, so every other todo card is also a
    // droppable candidate. closestCenter alone almost always resolves to the
    // nearest todo card instead of the (usually larger, sparser) In Progress
    // container, so dragging a todo card there never registers as "over" it —
    // the column doesn't highlight and the drop doesn't count. Check the
    // dedicated column containers first with pointerWithin (same as the
    // in_review/done case above); only fall back to closestCenter — for
    // reordering within the todo list itself — when the pointer isn't over
    // one of them.
    const columnHits = pointerWithin({
      ...args,
      droppableContainers: args.droppableContainers.filter((c) => COLUMN_DROP_IDS.has(String(c.id))),
    });
    if (columnHits.length > 0) return columnHits;
    return closestCenter(args);
  }, []);

  // Load settings and filters from localStorage on mount (client only — reading
  // it during render would make the server and client markup disagree).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSettings(loadSettings());
    const savedFilters = loadKanbanFilters();
    setRepoFilter(savedFilters.repoFilter);
    setSearchQuery(savedFilters.searchQuery);
  }, []);

  // Persist filters to localStorage whenever they change
  useEffect(() => {
    saveKanbanFilters({ repoFilter, searchQuery });
  }, [repoFilter, searchQuery]);

  const handleSettingsChange = (next: KanbanSettings) => {
    setSettings(next);
    saveSettings(next);
  };

  const refreshAbortRef = useRef<AbortController | null>(null);

  const refreshTasks = useCallback(async () => {
    // Cancel any in-flight refresh so its (potentially older) response can't
    // land after this one and overwrite fresher state with stale data.
    refreshAbortRef.current?.abort();
    const controller = new AbortController();
    refreshAbortRef.current = controller;
    try {
      const res = await fetch("/api/tasks", { signal: controller.signal });
      if (!res.ok) return;
      const fresh: Task[] = await res.json();
      if (controller.signal.aborted) return;
      setTasks(fresh);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
    }
  }, []);

  // These two flags track the manual refresh's two concurrent phases separately so the
  // button can report exactly what's still in flight rather than a single generic label.
  const [refreshingTasks, setRefreshingTasks] = useState(false);
  const [syncingPrStatus, setSyncingPrStatus] = useState(false);

  const handleManualRefresh = async () => {
    setRefreshing(true);
    setRefreshingTasks(true);
    setSyncingPrStatus(true);
    // Run the task-state refresh and PR status sync (merged/conflict/CI state) in
    // parallel, then re-fetch tasks again once the sync lands so the board picks up
    // whatever it just wrote.
    await Promise.all([
      refreshTasks().finally(() => setRefreshingTasks(false)),
      fetch("/api/tasks/sync-pr-status", { method: "POST" })
        .then(() => refreshTasks())
        .catch(() => { /* non-fatal — PR sync is best-effort */ })
        .finally(() => setSyncingPrStatus(false)),
    ]);
    setRefreshing(false);
  };

  const [retryingFailed, setRetryingFailed] = useState(false);
  const failedStatuses = ["failed", "killed", "timedout"] as const;
  const failedTaskCount = tasks.filter((t) => !t.isRecurringTemplate && failedStatuses.includes(t.status as (typeof failedStatuses)[number])).length;

  const handleBulkRetry = async () => {
    const ok = await confirm({
      title: "Retry tasks",
      description: "Retry all failed, killed, and timed-out tasks? They will be re-queued as pending.",
      confirmLabel: "Retry",
    });
    if (!ok) return;
    setRetryingFailed(true);
    try {
      const res = await fetch("/api/tasks/bulk-retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ statuses: failedStatuses }),
      });
      const data = await res.json() as { ok: boolean; count?: number; error?: string };
      if (!res.ok || !data.ok) {
        toast.error(data.error ?? "Failed to retry tasks");
        return;
      }
      setTasks((prev) =>
        prev.map((t) =>
          (failedStatuses as readonly string[]).includes(t.status)
            ? { ...t, status: "pending" as typeof t.status, retryCount: 0, nextRetryAt: null }
            : t
        )
      );
      getAnalytics()?.capture("task_action", { action: "bulk_retry", count: data.count ?? 0 });
      toast.success(`Queued ${data.count ?? 0} task${data.count === 1 ? "" : "s"} for retry`);
      await refreshTasks();
    } catch {
      toast.error("Failed to retry tasks");
    } finally {
      setRetryingFailed(false);
    }
  };

  useEffect(() => {
    const hasActive = tasks.some((t) => ACTIVE_STATUSES.has(t.status));
    if (!hasActive) return;
    const interval = setInterval(refreshTasks, 5000);
    return () => clearInterval(interval);
  }, [tasks, refreshTasks]);

  // Close the repo filter menu when clicking outside of it
  useEffect(() => {
    if (!repoMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (repoMenuRef.current && !repoMenuRef.current.contains(e.target as Node)) {
        setRepoMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [repoMenuOpen]);

  // Focus the search box as soon as it expands
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  // Collapse the search box back to an icon button when clicking outside of it,
  // but only if it's empty — an active search stays expanded so the query stays visible.
  useEffect(() => {
    if (!searchOpen) return;
    const handler = (e: MouseEvent) => {
      if (searchQuery) return;
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setSearchOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [searchOpen, searchQuery]);

  useEffect(() => {
    const hasActive = tasks.some((t) => ACTIVE_STATUSES.has(t.status));
    if (!hasActive) return;
    const interval = setInterval(refreshTasks, 5000);
    return () => clearInterval(interval);
  }, [tasks, refreshTasks]);

  // Close the repo filter menu when clicking outside of it
  useEffect(() => {
    if (!repoMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (repoMenuRef.current && !repoMenuRef.current.contains(e.target as Node)) {
        setRepoMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [repoMenuOpen]);

  // Focus the search box as soon as it expands
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  // Collapse the search box back to an icon button when clicking outside of it,
  // but only if it's empty — an active search stays expanded so the query stays visible.
  useEffect(() => {
    if (!searchOpen) return;
    const handler = (e: MouseEvent) => {
      if (searchQuery) return;
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setSearchOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [searchOpen, searchQuery]);

  const updateReviewStatus = async (id: string, reviewStatus: string | null) => {
    try {
      const res = await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewStatus }),
      });
      if (res.ok) {
        const updated = await res.json();
        setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...updated } : t)));
        toast.success(reviewStatus === "done" ? "Marked as done" : "Reopened for review");
      } else {
        toast.error("Failed to update task");
      }
    } catch {
      toast.error("Failed to update task");
    }
  };

  const requestChange = async (id: string, description: string) => {
    try {
      const res = await fetch(`/api/tasks/${id}/request-change`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description }),
      });
      if (res.ok) {
        const updated = await res.json();
        setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...updated } : t)));
        toast.success("Change scheduled, agent will pick it up shortly");
        return true;
      }
      const data = await res.json().catch(() => ({}));
      toast.error(data.error ?? "Failed to schedule change");
      return false;
    } catch {
      toast.error("Failed to schedule change");
      return false;
    }
  };

  const rebase = async (id: string) => {
    try {
      const res = await fetch(`/api/tasks/${id}/rebase-branch`, { method: "POST" });
      if (res.ok) {
        const updated = await res.json();
        setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...updated } : t)));
        toast.success("Rebase queued, agent will resolve conflicts and push");
        return true;
      }
      const data = await res.json().catch(() => ({}));
      toast.error(data.error ?? "Failed to queue rebase");
      return false;
    } catch {
      toast.error("Failed to queue rebase");
      return false;
    }
  };

  const runNow = async (id: string) => {
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    const minPosition = tasks.reduce((min, t) => Math.min(min, t.position), task.position);
    try {
      const res = await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "pending", position: minPosition - 1, scheduledFor: null, nextRetryAt: null, isEnabled: true }),
      });
      if (res.ok) {
        const updated = await res.json();
        setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...updated } : t)));
        toast.success("Moved to front of the queue, worker will pick it up shortly");
      } else {
        toast.error("Failed to run task now");
      }
    } catch {
      toast.error("Failed to run task now");
    }
  };

  const queueTask = async (id: string) => {
    try {
      const res = await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isEnabled: true, scheduledFor: null }),
      });
      if (res.ok) {
        const updated = await res.json();
        setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...updated } : t)));
        toast.success("Task queued, worker will pick it up shortly");
      } else {
        toast.error("Failed to queue task");
      }
    } catch {
      toast.error("Failed to queue task");
    }
  };

  // Clears the throttle/retry timer and puts the task back in pending so the
  // worker picks it up on the next poll. Also enables the task if it was disabled
  // so that dragging a disabled+throttled card to In Progress queues it immediately.
  const resumeThrottled = async (id: string) => {
    try {
      const res = await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "pending", nextRetryAt: null, isEnabled: true }),
      });
      if (res.ok) {
        const updated = await res.json();
        setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...updated } : t)));
        toast.success("Resumed, worker will pick it up shortly");
      } else {
        toast.error("Failed to resume task");
      }
    } catch {
      toast.error("Failed to resume task");
    }
  };

  const toggleEnabled = async (id: string, enabled: boolean) => {
    // If we're disabling a task that's currently running, the API also stops it
    // (flips status to "killed" so the worker's cancellation check picks it up) —
    // reflect that in the toast instead of implying it just gets hidden.
    const wasRunning = !enabled && tasks.find((t) => t.id === id)?.status === "running";
    try {
      const res = await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isEnabled: enabled }),
      });
      if (res.ok) {
        const updated = await res.json();
        setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...updated } : t)));
        toast.success(enabled ? "Task enabled" : wasRunning ? "Task stopped and disabled" : "Task disabled");
      } else {
        toast.error(enabled ? "Failed to enable task" : "Failed to disable task");
      }
    } catch {
      toast.error(enabled ? "Failed to enable task" : "Failed to disable task");
    }
  };

  // Disables a throttled task by clearing the retry timer, resetting status to
  // pending, and setting isEnabled=false so it shows as "backlog" on the board.
  const disableThrottledTask = async (id: string) => {
    try {
      const res = await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "pending", nextRetryAt: null, isEnabled: false }),
      });
      if (res.ok) {
        const updated = await res.json();
        setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...updated } : t)));
        toast.success("Task moved to backlog");
      } else {
        toast.error("Failed to disable task");
      }
    } catch {
      toast.error("Failed to disable task");
    }
  };

  // Re-queue a terminal task (failed/killed/timed-out/completed/no_changes) as a fresh
  // pending run — the same one-click retry the list and detail views already offer, so
  // the board isn't the odd one out that forces a navigation just to re-run a task.
  const retryTask = async (id: string) => {
    try {
      const res = await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "pending", nextRetryAt: null, retryCount: 0, isEnabled: true }),
      });
      if (res.ok) {
        const updated = await res.json();
        setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...updated } : t)));
        toast.success("Retrying, worker will pick it up shortly");
      } else {
        toast.error("Failed to retry task");
      }
    } catch {
      toast.error("Failed to retry task");
    }
  };

  // Hide (or unhide) To Do cards — one card from its detail dialog, or the whole
  // selection from the header. Display only: hiddenOnBoard never affects the worker.
  const setTasksHidden = useCallback(async (ids: string[], hidden: boolean) => {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    setTasks((prev) => prev.map((t) => (idSet.has(t.id) ? { ...t, hiddenOnBoard: hidden } : t)));
    try {
      const res = await fetch("/api/tasks/bulk-hide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, hidden }),
      });
      if (!res.ok) throw new Error();
      const noun = `${ids.length} task${ids.length === 1 ? "" : "s"}`;
      toast.success(hidden ? `Hid ${noun} from the board` : `Unhid ${noun}`);
    } catch {
      // Roll the optimistic flip back to whatever the server actually has.
      void refreshTasks();
      toast.error(hidden ? "Failed to hide tasks" : "Failed to unhide tasks");
    }
  }, [refreshTasks]);

  const toggleShowHidden = () => handleSettingsChange({ ...settings, showHiddenTasks: !settings.showHiddenTasks });

  // Bulk hide/unhide acts on the selected cards that are in To Do — the only column
  // where hiding applies (see isHiddenOnBoard()).
  const selectedTodoTasks = tasks.filter((t) => selectedIds.has(t.id) && columnFor(t) === "todo");
  const selectedToHide = selectedTodoTasks.filter((t) => !t.hiddenOnBoard).map((t) => t.id);
  const selectedToUnhide = selectedTodoTasks.filter((t) => t.hiddenOnBoard).map((t) => t.id);

  const bulkSetHidden = async (ids: string[], hidden: boolean) => {
    await setTasksHidden(ids, hidden);
    clearSelection();
  };

  // Collect unique repos across all tasks — only show filter when there are git/code tasks
  const allRepos = Array.from(
    new Map(
      tasks.flatMap((t) => t.repos).map((r) => [r.alias, r])
    ).values()
  ).sort((a, b) => a.alias.localeCompare(b.alias));

  // Apply repo filter and search query before grouping into columns
  const searchLower = searchQuery.trim().toLowerCase();
  const matchingTasks = tasks.filter((t) => {
    if (repoFilter && !t.repos.some((r) => r.alias === repoFilter)) return false;
    if (searchLower) {
      const titleMatch = t.title.toLowerCase().includes(searchLower);
      const descMatch = (t.description ?? "").toLowerCase().includes(searchLower);
      const repoMatch = t.repos.some((r) => r.alias.toLowerCase().includes(searchLower));
      const labelMatch = parseLabels(t.labels).some((l) => l.toLowerCase().includes(searchLower));
      if (!titleMatch && !descMatch && !repoMatch && !labelMatch) return false;
    }
    return true;
  });
  // Hidden To Do cards are dropped unless Board Settings → "Show hidden tasks" is on.
  const showHidden = settings.showHiddenTasks;
  const filteredTasks = visibleOnBoard(matchingTasks, showHidden);
  const hiddenTodoCount = matchingTasks.filter(isHiddenOnBoard).length;

  const grouped: Record<ColumnKey, Task[]> = { todo: [], in_progress: [], in_review: [], done: [] };
  for (const task of filteredTasks) {
    const col = columnFor(task);
    if (col) grouped[col].push(task);
  }
  // Sort To Do column to mirror the worker's pick-up order: higher priority first,
  // then lowest position first within the same priority level (see comparePriorityThenPosition
  // and the worker's task-selection query in src/worker/index.ts).
  grouped.todo.sort(comparePriorityThenPosition);
  // Sort In Progress by createdAt (stable) rather than the API's default updatedAt order,
  // which reshuffles every time a running task's logs/status are touched.
  grouped.in_progress.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  const handleDragStart = (event: DragStartEvent) => {
    setActiveDragId(String(event.active.id));
  };

  // When the dragged card is part of a multi-card selection (shift-click), returns every
  // selected id that lives in the same source column — those move together. Otherwise
  // just the dragged card moves, as before. Sequenced with a plain for-loop (not
  // Promise.all) so calls like runNow() that read `tasks` to compute a position don't
  // race each other against the same stale snapshot.
  const idsToMoveWith = (activeId: string, sourceCol: ColumnKey): string[] => {
    if (selectedIds.size > 1 && selectedIds.has(activeId)) {
      const inSameColumn = tasks.filter((t) => selectedIds.has(t.id) && columnFor(t) === sourceCol).map((t) => t.id);
      if (inSameColumn.length > 1) return inSameColumn;
    }
    return [activeId];
  };

  const handleTodoDragEnd = async (event: DragEndEvent) => {
    // Tear down the overlay first, before any early return below, so a drag that ends
    // outside a drop target doesn't leave the floating preview stuck on screen.
    setActiveDragId(null);
    const { active, over } = event;
    if (!over) return;

    const activeId = String(active.id);
    const overId = String(over.id);

    // Column-to-column transition (in_review ↔ done) via useDraggable on KanbanCard.
    // active.data.current.from tells us the source column.
    const sourceCol = (active.data.current as { from?: ColumnKey } | undefined)?.from;
    if (sourceCol && DRAG_TARGETS[sourceCol] === overId) {
      const targetStatus = sourceCol === "in_review" ? "done" : "in_review";
      const ids = idsToMoveWith(activeId, sourceCol).filter((id) => {
        if (targetStatus !== "in_review") return true;
        const t = tasks.find((x) => x.id === id);
        return !(t && hasNothingToReview(t));
      });
      for (const id of ids) {
        await updateReviewStatus(id, targetStatus);
      }
      if (ids.length > 1) clearSelection();
      return;
    }

    // Dropped onto the In Progress column → resume throttled task or run now
    if (overId === "in_progress") {
      const ids = idsToMoveWith(activeId, "todo");
      for (const id of ids) {
        const task = tasks.find((t) => t.id === id);
        if (task?.status === "throttled") await resumeThrottled(id);
        else await runNow(id);
      }
      if (ids.length > 1) clearSelection();
      return;
    }

    // Reorder within the To Do column
    const oldIndex = grouped.todo.findIndex((t) => t.id === activeId);
    const newIndex = grouped.todo.findIndex((t) => t.id === overId);
    if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;

    // Reorder the *whole* To Do queue, hidden cards included, so positions stay unique
    // and a hidden card keeps its place relative to the rest when it's unhidden.
    const fullTodo = tasks.filter((t) => columnFor(t) === "todo").sort(comparePriorityThenPosition);
    const fullOld = fullTodo.findIndex((t) => t.id === activeId);
    const fullNew = fullTodo.findIndex((t) => t.id === overId);
    if (fullOld === -1 || fullNew === -1) return;
    const reordered = arrayMove(fullTodo, fullOld, fullNew);

    // Optimistic update: reassign positions in local state
    const updatedPositions = new Map(reordered.map((t, i) => [t.id, i]));
    setTasks((prev) =>
      prev.map((t) => {
        const newPos = updatedPositions.get(t.id);
        return newPos !== undefined ? { ...t, position: newPos } : t;
      })
    );

    try {
      await fetch("/api/tasks/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: reordered.map((t) => t.id) }),
      });
    } catch {
      toast.error("Failed to save order");
    }
  };

  const clearDone = async () => {
    const doneIds = grouped.done.map((t) => t.id);
    if (doneIds.length === 0) return;
    const ok = await confirm({
      title: "Delete done tasks",
      description: `Delete ${doneIds.length} done task${doneIds.length === 1 ? "" : "s"}? This cannot be undone.`,
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    setClearingDone(true);
    setDeletingIds(new Set(doneIds));
    beginDelete();
    try {
      // Single bulk request instead of one DELETE per task — avoids N
      // separate HTTP round trips and N x (3 DB writes) on the server.
      const res = await fetch(`/api/tasks/clear-done`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: doneIds }),
      });
      if (res.ok) {
        const { count } = await res.json();
        const doneIdSet = new Set(doneIds);
        setTasks((prev) => prev.filter((t) => !doneIdSet.has(t.id)));
        if (count === doneIds.length) {
          toast.success(`Deleted ${count} task${count === 1 ? "" : "s"}`);
        } else {
          toast.error(`Deleted ${count}/${doneIds.length} tasks, some were already gone`);
        }
      } else {
        toast.error("Failed to delete done tasks");
      }
    } catch {
      toast.error("Failed to delete done tasks");
    } finally {
      setDeletingIds(new Set());
      setClearingDone(false);
      endDelete();
    }
  };

  const columnProps = {
    onRequestChange: requestChange,
    onUpdateStatus: updateReviewStatus,
    onRebase: rebase,
    onQueueTask: queueTask,
    onToggleEnabled: toggleEnabled,
    onDisableTask: disableThrottledTask,
    onRetry: retryTask,
    onSetHidden: setTasksHidden,
    onClearDone: clearDone,
    clearingDone,
    deletingIds,
    selectedIds,
    onToggleSelect: toggleCardSelection,
    onClearSelection: clearSelection,
    onSelectAll: setColumnSelection,
    activeDragId,
  };

  const renderColumns = (taskSubset: Record<ColumnKey, Task[]>, hiddenCount: number) =>
    COLUMNS.map((col) => (
      <KanbanColumn
        key={col.key}
        col={col}
        tasks={taskSubset[col.key]}
        hiddenCount={col.key === "todo" ? hiddenCount : 0}
        showHidden={showHidden}
        onToggleShowHidden={toggleShowHidden}
        collapsed={collapsedColumns.includes(col.key)}
        onToggleCollapsed={() => toggleKanbanColumnCollapsed(col.key)}
        {...columnProps}
      />
    ));

  const groupTasksIntoColumns = (subset: Task[]): Record<ColumnKey, Task[]> => {
    const g: Record<ColumnKey, Task[]> = { todo: [], in_progress: [], in_review: [], done: [] };
    for (const task of subset) {
      const col = columnFor(task);
      if (col) g[col].push(task);
    }
    return g;
  };

  return (
    <div>
      {/* Header stacks onto two lines below `sm` — title on the first, the action
          buttons on the second — so the controls don't get squashed on phones. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
        <div className="flex items-center gap-2 min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">Task Board</h1>
          {selectedIds.size > 0 && (
            <span className="inline-flex items-center gap-1.5 text-xs bg-primary/10 text-primary px-2 py-1 rounded-full border border-primary/20">
              {selectedIds.size} selected
              <button
                type="button"
                onClick={clearSelection}
                className="hover:text-foreground"
                aria-label="Clear selection"
                title="Clear selection (Esc)"
              >
                <X className="size-3" />
              </button>
            </span>
          )}
          {selectedToHide.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 shrink-0"
              onClick={() => bulkSetHidden(selectedToHide, true)}
              title="Hide the selected To Do cards from the board (they still run if queued)"
            >
              <EyeOff className="size-3.5" />
              Hide {selectedToHide.length}
            </Button>
          )}
          {selectedToUnhide.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 shrink-0"
              onClick={() => bulkSetHidden(selectedToUnhide, false)}
              title="Show the selected hidden cards on the board again"
            >
              <Eye className="size-3.5" />
              Unhide {selectedToUnhide.length}
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2 sm:justify-end">
          {/* Search — collapsed to an icon button matching the other controls; expands
              into a text box on click. Stays expanded while a query is active. */}
          <div className={`relative ${searchOpen ? "flex-1 sm:flex-none" : ""}`} ref={searchRef}>
            {searchOpen ? (
              <>
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  ref={searchInputRef}
                  type="search"
                  placeholder="Search cards…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setSearchQuery("");
                      setSearchOpen(false);
                    }
                  }}
                  className="pl-8 pr-8 h-7 w-full sm:w-48 text-sm"
                />
                <button
                  onClick={() => { setSearchQuery(""); setSearchOpen(false); }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label="Close search"
                >
                  <X className="size-3" />
                </button>
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSearchOpen(true)}
                className="shrink-0"
                aria-label="Search cards"
                title="Search cards"
              >
                <Search className="size-3.5" />
              </Button>
            )}
          </div>
          {/* Repo filter dropdown — only shown when tasks have repos attached (git/code tasks) */}
          {allRepos.length > 0 && (
            <div className="relative" ref={repoMenuRef}>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRepoMenuOpen((o) => !o)}
                className="gap-1 shrink-0 max-w-[45vw] sm:max-w-none"
                title="Filter by repository"
              >
                <Filter className="size-3.5 shrink-0" />
                <span className="truncate">{repoFilter ?? "Repo"}</span>
                {repoFilter && (
                  <span
                    className="ml-0.5 shrink-0 hover:text-foreground text-muted-foreground"
                    onClick={(e) => { e.stopPropagation(); setRepoFilter(null); setRepoMenuOpen(false); }}
                    aria-label="Clear repo filter"
                  >
                    <X className="size-3" />
                  </span>
                )}
                {!repoFilter && <ChevronDown className="size-3 shrink-0" />}
              </Button>
              {repoMenuOpen && (
                <div className="absolute left-0 sm:left-auto sm:right-0 top-full mt-1 z-50 bg-popover border border-border rounded-lg shadow-md py-1 min-w-[180px] max-w-[calc(100vw-2rem)] overflow-x-hidden">
                  <button
                    className={`w-full text-left px-3 py-2 text-sm hover:bg-accent transition-colors flex items-center justify-between gap-2 ${repoFilter === null ? "text-foreground font-medium" : "text-muted-foreground"}`}
                    onMouseDown={(e) => { e.preventDefault(); setRepoFilter(null); setRepoMenuOpen(false); }}
                  >
                    All repositories
                    {repoFilter === null && <span className="text-primary text-xs">✓</span>}
                  </button>
                  <div className="border-t border-border my-1" />
                  {allRepos.map((repo) => (
                    <button
                      key={repo.alias}
                      className={`w-full text-left px-3 py-2 text-sm hover:bg-accent transition-colors flex items-start justify-between gap-2 ${repoFilter === repo.alias ? "text-foreground font-medium" : "text-muted-foreground"}`}
                      onMouseDown={(e) => { e.preventDefault(); setRepoFilter(repo.alias); setRepoMenuOpen(false); }}
                    >
                      <span className="flex flex-col gap-0 min-w-0">
                        <span className="font-mono">{repo.alias}</span>
                        <span className="text-xs opacity-60 truncate max-w-[140px]">{repo.url}</span>
                      </span>
                      {repoFilter === repo.alias && <span className="text-primary text-xs shrink-0 mt-0.5">✓</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {failedTaskCount > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleBulkRetry}
              disabled={retryingFailed}
              className="gap-1 shrink-0"
              title="Re-queue all failed, killed, and timed-out tasks as pending"
            >
              <RotateCcw className="size-3.5" />
              {retryingFailed ? "Retrying…" : "Retry failed"}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={handleManualRefresh}
            disabled={refreshing}
            className="shrink-0"
            title={
              refreshingTasks && syncingPrStatus
                ? "Refreshing task details and syncing PR status (merge conflicts, CI)…"
                : syncingPrStatus
                  ? "Syncing PR status (merge conflicts, CI)…"
                  : refreshingTasks
                    ? "Refreshing task details…"
                    : undefined
            }
          >
            <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button size="sm" variant="outline" onClick={() => setSettingsOpen(true)} className="shrink-0" aria-label="Board settings">
            <Settings2 className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* DndContext + SortableContext enable drag-to-reorder within the To Do column
          and drag-to-run (To Do → In Progress) via the @dnd-kit droppable zone. They wrap
          both layout modes below since handleTodoDragEnd operates on the global todo list
          regardless of how it's visually grouped into swim lanes. */}
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={handleDragStart}
        onDragEnd={handleTodoDragEnd}
        onDragCancel={() => setActiveDragId(null)}
      >
        <SortableContext items={grouped.todo.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {settings.swimLanesEnabled ? (
            // Swim lanes layout: one horizontal band per group value
            <div className="flex flex-col gap-6">
              {(() => {
                const laneSource = tasks.filter((t) => columnFor(t) !== null);
                const allVisibleTasks = visibleOnBoard(laneSource, showHidden);
                const lanes = groupBySwimLane(allVisibleTasks, settings.swimLaneField);
                if (lanes.length === 0) {
                  return (
                    <div className="text-sm text-muted-foreground italic px-1">No tasks</div>
                  );
                }
                return lanes.map(([laneKey, laneTasks]) => (
                  <div key={laneKey} className="flex flex-col gap-2">
                    {/* Lane header */}
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                        {SWIM_LANE_FIELD_LABELS[settings.swimLaneField]}
                      </span>
                      <span className="text-sm font-medium text-foreground">{laneKey}</span>
                      <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full tabular-nums">
                        {laneTasks.length}
                      </span>
                      <div className="flex-1 border-t border-border/40" />
                    </div>
                    {/* Columns inside this lane */}
                    <div className="flex flex-col gap-4 md:flex-row md:overflow-x-auto pb-2">
                      {renderColumns(
                        groupTasksIntoColumns(laneTasks),
                        laneSource.filter((t) => isHiddenOnBoard(t) && getSwimLaneKey(t, settings.swimLaneField) === laneKey).length,
                      )}
                    </div>
                  </div>
                ));
              })()}
            </div>
          ) : (
            // Standard flat layout
            <div className="flex flex-col gap-4 md:flex-row md:overflow-x-auto pb-4">
              {renderColumns(grouped, hiddenTodoCount)}
            </div>
          )}
        </SortableContext>
        {/* Floating copy that tracks the cursor for every drag (To Do reorder/queue and
            In Review ↔ Done), so the card is visibly "held" regardless of which underlying
            drag mechanism (sortable vs draggable) the source column uses. */}
        <DragOverlay>
          {(() => {
            if (!activeDragId) return null;
            const task = tasks.find((t) => t.id === activeDragId);
            if (!task) return null;
            // Mirror idsToMoveWith's same-column filter so the "+N" badge matches what will actually move.
            const sameColumnSelected = selectedIds.size > 1 && selectedIds.has(activeDragId)
              ? tasks.filter((t) => selectedIds.has(t.id) && columnFor(t) === columnFor(task)).length
              : 1;
            return <KanbanCardPreview task={task} extraCount={Math.max(0, sameColumnSelected - 1)} />;
          })()}
        </DragOverlay>
      </DndContext>

      <KanbanSettingsModal
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        onSettingsChange={handleSettingsChange}
      />
    </div>
  );
}
