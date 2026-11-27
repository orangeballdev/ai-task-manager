"use client";
import { useState, useCallback, useEffect, useRef } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { SortableContext, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { ArrowDownUp, ChevronDown, Filter, RotateCcw, Star, Tag, Trash2, X } from "lucide-react";
import { useCompactView, type ViewMode } from "@/lib/use-layout-preferences";
import { TaskCard } from "./TaskCard";
import { Button } from "@/components/ui/button";
import type { Task } from "@/lib/types";
import { toast } from "sonner";
import { confirm } from "@/components/ui/confirm-dialog";
import { getAnalytics } from "@/components/WebAnalytics";

const ACTIVE_STATUSES = new Set(["pending", "running", "paused", "throttled", "awaiting_approval"]);
const FILTERABLE_STATUSES = ["completed", "no_changes", "failed", "killed", "timedout"] as const;
const TERMINAL_STATUSES = new Set(["completed", "no_changes", "failed", "killed", "timedout"]);
const PINNED_STORAGE_KEY = "pinned-tasks";
const TASK_LIST_FILTERS_KEY = "task-list-filters";

type SortMode = "default" | "newest" | "oldest" | "cost-desc" | "title-asc";
const SORT_LABELS: Record<SortMode, string> = {
  default: "Default order",
  newest: "Newest first",
  oldest: "Oldest first",
  "cost-desc": "Highest cost",
  "title-asc": "Title A–Z",
};

interface TaskListFilters {
  hiddenStatuses: string[];
  hideDisabled: boolean;
  sortMode: SortMode;
  repoFilter: string | null;
  labelFilter: string | null;
}

const DEFAULT_TASK_LIST_FILTERS: TaskListFilters = {
  hiddenStatuses: ["completed", "no_changes", "failed", "killed", "timedout"],
  hideDisabled: true,
  sortMode: "default",
  repoFilter: null,
  labelFilter: null,
};

function loadTaskListFilters(): TaskListFilters {
  if (typeof window === "undefined") return DEFAULT_TASK_LIST_FILTERS;
  try {
    const raw = localStorage.getItem(TASK_LIST_FILTERS_KEY);
    if (!raw) return DEFAULT_TASK_LIST_FILTERS;
    return { ...DEFAULT_TASK_LIST_FILTERS, ...(JSON.parse(raw) as Partial<TaskListFilters>) };
  } catch {
    return DEFAULT_TASK_LIST_FILTERS;
  }
}

function saveTaskListFilters(filters: TaskListFilters) {
  try {
    localStorage.setItem(TASK_LIST_FILTERS_KEY, JSON.stringify(filters));
  } catch { /* ignore */ }
}

function loadPinnedIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(PINNED_STORAGE_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function savePinnedIds(ids: Set<string>): void {
  try {
    localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(Array.from(ids)));
  } catch { /* ignore */ }
}

export function TaskList({ initialTasks, viewMode = "list" }: { initialTasks: Task[]; viewMode?: ViewMode }) {
  const router = useRouter();
  const [tasks, setTasks] = useState(initialTasks);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: sync local state when parent passes new tasks
  useEffect(() => { setTasks(initialTasks); }, [initialTasks]);
  const [hiddenStatuses, setHiddenStatuses] = useState<Set<string>>(new Set(["completed", "no_changes", "failed", "killed", "timedout"]));
  const [hideDisabled, setHideDisabled] = useState(true);
  const [clearMenuOpen, setClearMenuOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>("default");
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const compactView = useCompactView();
  const [repoFilter, setRepoFilter] = useState<string | null>(null);
  const [repoMenuOpen, setRepoMenuOpen] = useState(false);
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [labelMenuOpen, setLabelMenuOpen] = useState(false);
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => loadPinnedIds());
  // Track tasks pending deletion so we can undo within the grace period
  const deleteTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const deletedTasksRef = useRef<Map<string, Task>>(new Map());
  const clearMenuRef = useRef<HTMLDivElement>(null);
  const sortMenuRef = useRef<HTMLDivElement>(null);
  const repoMenuRef = useRef<HTMLDivElement>(null);
  const labelMenuRef = useRef<HTMLDivElement>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  // Load filters from localStorage on mount (client only — reading it during
  // render would make the server and client markup disagree).
  useEffect(() => {
    const saved = loadTaskListFilters();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHiddenStatuses(new Set(saved.hiddenStatuses));
    setHideDisabled(saved.hideDisabled);
    setSortMode(saved.sortMode);
    setRepoFilter(saved.repoFilter);
    setLabelFilter(saved.labelFilter);
  }, []);

  // Persist filters to localStorage whenever they change
  useEffect(() => {
    saveTaskListFilters({
      hiddenStatuses: Array.from(hiddenStatuses),
      hideDisabled,
      sortMode,
      repoFilter,
      labelFilter,
    });
  }, [hiddenStatuses, hideDisabled, sortMode, repoFilter, labelFilter]);

  // Close the clear menu when clicking outside of it
  useEffect(() => {
    if (!clearMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (clearMenuRef.current && !clearMenuRef.current.contains(e.target as Node)) {
        setClearMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [clearMenuOpen]);

  // Close the sort menu when clicking outside of it
  useEffect(() => {
    if (!sortMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (sortMenuRef.current && !sortMenuRef.current.contains(e.target as Node)) {
        setSortMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [sortMenuOpen]);

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

  // Close the label filter menu when clicking outside of it
  useEffect(() => {
    if (!labelMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (labelMenuRef.current && !labelMenuRef.current.contains(e.target as Node)) {
        setLabelMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [labelMenuOpen]);

  const refreshTasks = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks");
      if (!res.ok) return;
      const fresh: Task[] = await res.json();
      setTasks((prev) => prev.map((t) => fresh.find((f) => f.id === t.id) ?? t));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    const hasActive = tasks.some((t) => ACTIVE_STATUSES.has(t.status));
    if (!hasActive) return;
    const interval = setInterval(refreshTasks, 5000);
    return () => clearInterval(interval);
  }, [tasks, refreshTasks]);

  const beginDelete = useCallback(() => setDeleting(true), []);
  const endDelete = useCallback(() => setDeleting(false), []);

  const handleDelete = useCallback((id: string) => {
    // Find and stash the task before removing it
    setTasks((prev) => {
      const task = prev.find((t) => t.id === id);
      if (!task) return prev;
      deletedTasksRef.current.set(id, task);
      return prev.filter((t) => t.id !== id);
    });

    // Schedule the actual API delete after a 5-second grace period
    const timeout = setTimeout(async () => {
      deleteTimeoutsRef.current.delete(id);
      deletedTasksRef.current.delete(id);
      beginDelete();
      try {
        const res = await fetch(`/api/tasks/${id}`, { method: "DELETE" });
        if (!res.ok) {
          toast.error("Failed to delete task, it may already be gone.");
        }
      } catch {
        toast.error("Failed to delete task");
      } finally {
        endDelete();
      }
    }, 5000);
    deleteTimeoutsRef.current.set(id, timeout);

    // Show toast with Undo action
    toast("Task deleted", {
      action: {
        label: "Undo",
        onClick: () => {
          // Cancel the pending delete and restore the task
          const pending = deleteTimeoutsRef.current.get(id);
          if (pending) {
            clearTimeout(pending);
            deleteTimeoutsRef.current.delete(id);
          }
          const task = deletedTasksRef.current.get(id);
          if (task) {
            deletedTasksRef.current.delete(id);
            setTasks((prev) => {
              // Re-insert at the original position by createdAt order (approximate)
              const withRestored = [...prev, task];
              return withRestored.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
            });
            toast.success("Task restored");
          }
        },
      },
      duration: 5000,
    });
  }, [beginDelete, endDelete]);

  const handleRetry = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "pending", nextRetryAt: null, retryCount: 0 }),
      });
      if (res.ok) {
        const updated = await res.json();
        setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...updated } : t)));
      } else {
        toast.error("Failed to retry task");
      }
    } catch {
      toast.error("Failed to retry task");
    }
  }, []);

  const handleResume = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "pending", nextRetryAt: null }),
      });
      if (res.ok) {
        const updated = await res.json();
        setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...updated } : t)));
      } else {
        toast.error("Failed to resume task");
      }
    } catch {
      toast.error("Failed to resume task");
    }
  }, []);

  const handleToggle = useCallback(async (id: string, enabled: boolean) => {
    try {
      const res = await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isEnabled: enabled }),
      });
      if (res.ok) {
        const updated = await res.json();
        setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...updated } : t)));
        toast.success(enabled ? "Task enabled" : "Task disabled");
      } else {
        toast.error("Failed to update task");
      }
    } catch {
      toast.error("Failed to update task");
    }
  }, []);

  const handleRunNow = useCallback(async (id: string) => {
    const task = tasks.find((t) => t.id === id);
    const isBacklog = task && !task.isEnabled;
    try {
      const res = await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isBacklog ? { isEnabled: true, scheduledFor: null } : { scheduledFor: null }),
      });
      if (res.ok) {
        const updated = await res.json();
        setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...updated } : t)));
      } else {
        toast.error("Failed to run task");
      }
    } catch {
      toast.error("Failed to run task");
    }
  }, [tasks]);

  const toggleStatus = useCallback((status: string) => {
    setHiddenStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }, []);

  const handleBulkClear = useCallback(async (status: "completed" | "no_changes" | "failed" | "killed" | "timedout" | "all") => {
    const label =
      status === "all" ? "all finished tasks" :
      status === "completed" ? "all completed tasks" :
      status === "no_changes" ? "all no-changes tasks" :
      status === "failed" ? "all failed tasks" :
      status === "killed" ? "all killed tasks" :
      "all timed-out tasks";
    const ok = await confirm({
      title: "Delete tasks",
      description: `Delete ${label}? This cannot be undone.`,
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    setClearing(true);
    setClearMenuOpen(false);
    beginDelete();
    try {
      const res = await fetch("/api/tasks/delete-by-status", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const data = await res.json() as { ok: boolean; count?: number; error?: string };
      if (!res.ok || !data.ok) {
        toast.error(data.error ?? "Failed to delete tasks");
        return;
      }
      if (status === "all") {
        setTasks([]);
      } else {
        setTasks((prev) => prev.filter((t) => t.status !== status));
      }
      toast.success(`Deleted ${data.count ?? 0} task${data.count === 1 ? "" : "s"}`);
      router.refresh();
    } catch {
      toast.error("Failed to delete tasks");
    } finally {
      setClearing(false);
      endDelete();
    }
  }, [router, beginDelete, endDelete]);

  const handleBulkRetry = useCallback(async (statuses: string[]) => {
    const label = statuses.length === 1 ? `all ${statuses[0]} tasks` : "all failed/killed/timed-out tasks";
    const ok = await confirm({
      title: "Retry tasks",
      description: `Retry ${label}? They will be re-queued as pending.`,
      confirmLabel: "Retry",
    });
    if (!ok) return;
    setRetrying(true);
    try {
      const res = await fetch("/api/tasks/bulk-retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ statuses }),
      });
      const data = await res.json() as { ok: boolean; count?: number; error?: string };
      if (!res.ok || !data.ok) {
        toast.error(data.error ?? "Failed to retry tasks");
        return;
      }
      setTasks((prev) =>
        prev.map((t) =>
          statuses.includes(t.status)
            ? { ...t, status: "pending" as typeof t.status, retryCount: 0, nextRetryAt: null }
            : t
        )
      );
      getAnalytics()?.capture("task_action", { action: "bulk_retry", count: data.count ?? 0 });
      toast.success(`Queued ${data.count ?? 0} task${data.count === 1 ? "" : "s"} for retry`);
      router.refresh();
    } catch {
      toast.error("Failed to retry tasks");
    } finally {
      setRetrying(false);
    }
  }, [router]);

  const handleEditThrottled = useCallback(async (id: string) => {
    try {
      await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isEnabled: false }),
      });
    } catch {
      // non-fatal — still navigate
    }
    router.push(`/tasks/${id}/edit?reenable=true`);
  }, [router]);

  const handleMoveToTop = useCallback(async (id: string) => {
    setTasks((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      if (idx <= 0) return prev;
      const reordered = [prev[idx], ...prev.slice(0, idx), ...prev.slice(idx + 1)]
        .map((t, i) => ({ ...t, position: i }));
      // Fire-and-forget the reorder API call
      fetch("/api/tasks/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: reordered.map((t) => t.id) }),
      }).catch(() => toast.error("Failed to save order"));
      return reordered;
    });
  }, []);

  const handlePin = useCallback((id: string) => {
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      savePinnedIds(next);
      return next;
    });
  }, []);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = tasks.findIndex((t) => t.id === active.id);
      const newIndex = tasks.findIndex((t) => t.id === over.id);
      const reordered = arrayMove(tasks, oldIndex, newIndex).map((t, i) => ({ ...t, position: i }));
      setTasks(reordered);

      try {
        await fetch("/api/tasks/reorder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: reordered.map((t) => t.id) }),
        });
      } catch {
        toast.error("Failed to save order");
        setTasks(tasks);
      }
    },
    [tasks]
  );

  // Compute queue positions for pending tasks (mirrors worker pick-up order: position asc).
  // Only tasks that are immediately runnable count toward the queue:
  // pending + enabled + not scheduled in the future + not waiting on an incomplete dependency.
  const now = new Date();
  const isRunnable = (t: Task) =>
    t.status === "pending" &&
    t.isEnabled &&
    (!t.scheduledFor || new Date(t.scheduledFor) <= now) &&
    (!t.dependsOn || t.dependsOn.status === "completed" || t.dependsOn.status === "no_changes");
  const queuePositions = new Map<string, number>();
  [...tasks]
    .filter(isRunnable)
    .sort((a, b) => a.position - b.position)
    .forEach((t, i) => queuePositions.set(t.id, i + 1));

  // "Next running" rank: groups tasks by how soon they'll run, mirroring the worker's
  // own pick-up logic. 0 = running now, 1 = next up in the runnable queue (drag to reorder),
  // 2 = paused/throttled (will retry), 3 = pending but blocked/scheduled for later, 4 = terminal.
  const runRank = (t: Task): number => {
    if (t.status === "running") return 0;
    if (TERMINAL_STATUSES.has(t.status)) return 4;
    if (t.status === "paused" || t.status === "throttled") return 2;
    return isRunnable(t) ? 1 : 3;
  };
  const runSecondary = (t: Task): number => {
    switch (runRank(t)) {
      case 1: return t.position;
      case 2: return t.nextRetryAt ? new Date(t.nextRetryAt).getTime() : Infinity;
      case 3: return t.scheduledFor ? new Date(t.scheduledFor).getTime() : Infinity;
      default: return -new Date(t.updatedAt).getTime();
    }
  };

  // Collect unique repos across all tasks for the filter dropdown
  const allRepos = Array.from(
    new Map(
      tasks.flatMap((t) => t.repos).map((r) => [r.alias, r])
    ).values()
  ).sort((a, b) => a.alias.localeCompare(b.alias));

  // Collect unique labels across all tasks for the label filter dropdown
  const allLabels = Array.from(
    new Set(
      tasks.flatMap((t) => {
        if (!t.labels) return [];
        try { return JSON.parse(t.labels) as string[]; } catch { return []; }
      })
    )
  ).sort((a, b) => a.localeCompare(b));

  const visibleTasks = tasks
    .filter((t) => !hiddenStatuses.has(t.status))
    .filter((t) => !hideDisabled || t.isEnabled)
    .filter((t) => {
      if (!repoFilter) return true;
      return t.repos.some((r) => r.alias === repoFilter);
    })
    .filter((t) => {
      if (!labelFilter) return true;
      if (!t.labels) return false;
      try {
        const taskLabels = JSON.parse(t.labels) as string[];
        return taskLabels.includes(labelFilter);
      } catch { return false; }
    })
    .sort((a, b) => {
      // Pinned tasks always sort to the top, regardless of other sort modes
      const aPinned = pinnedIds.has(a.id);
      const bPinned = pinnedIds.has(b.id);
      if (aPinned !== bPinned) return aPinned ? -1 : 1;
      // In default mode: order by how soon a task will next run (running now, then the
      // runnable queue in drag-and-drop order, then paused/scheduled, then terminal last).
      if (sortMode === "default") {
        const rankDiff = runRank(a) - runRank(b);
        if (rankDiff !== 0) return rankDiff;
        return runSecondary(a) - runSecondary(b);
      }
      // User-selected sort modes
      if (sortMode === "newest") return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      if (sortMode === "oldest") return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      if (sortMode === "cost-desc") return (b.estimatedCost ?? 0) - (a.estimatedCost ?? 0);
      if (sortMode === "title-asc") return a.title.localeCompare(b.title);
      return 0;
    });
  const counts = Object.fromEntries(
    FILTERABLE_STATUSES.map((s) => [s, tasks.filter((t) => t.status === s).length])
  );
  const disabledCount = tasks.filter((t) => !t.isEnabled).length;

  const statCounts = ["pending", "paused", "completed", "no_changes", "failed", "killed", "timedout"].map((s) => ({
    status: s,
    count: tasks.filter((t) => t.status === s).length,
  }));
  const runningCount = tasks.filter((t) => t.status === "running").length;

  const statsBar = (
    <div className="flex flex-col gap-2 mb-4">
      {/* Row 1: primary filters */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        <div className="flex items-center gap-2 flex-wrap">
        {/* Repo filter dropdown — only shown when tasks have repos attached */}
        {allRepos.length > 0 && (
          <div className="relative" ref={repoMenuRef}>
            <Button
              variant={repoFilter !== null ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setRepoMenuOpen((o) => !o)}
              className="gap-1"
              title="Filter by repository"
            >
              <Filter className="size-3.5" />
              {repoFilter ?? "Repo"}
              {repoFilter && (
                <span
                  className="ml-0.5 hover:text-foreground text-muted-foreground"
                  onClick={(e) => { e.stopPropagation(); setRepoFilter(null); setRepoMenuOpen(false); }}
                  aria-label="Clear repo filter"
                >
                  <X className="size-3" />
                </span>
              )}
              {!repoFilter && <ChevronDown className="size-3" />}
            </Button>
            {repoMenuOpen && (
              <div className="absolute left-0 top-full mt-1 z-50 bg-popover border border-border rounded-lg shadow-md py-1 min-w-[180px]">
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
        {/* Label filter dropdown — only shown when tasks have labels */}
        {allLabels.length > 0 && (
          <div className="relative" ref={labelMenuRef}>
            <Button
              variant={labelFilter !== null ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setLabelMenuOpen((o) => !o)}
              className="gap-1"
              title="Filter by label"
            >
              <Tag className="size-3.5" />
              {labelFilter ?? "Label"}
              {labelFilter && (
                <span
                  className="ml-0.5 hover:text-foreground text-muted-foreground"
                  onClick={(e) => { e.stopPropagation(); setLabelFilter(null); setLabelMenuOpen(false); }}
                  aria-label="Clear label filter"
                >
                  <X className="size-3" />
                </span>
              )}
              {!labelFilter && <ChevronDown className="size-3" />}
            </Button>
            {labelMenuOpen && (
              <div className="absolute left-0 top-full mt-1 z-50 bg-popover border border-border rounded-lg shadow-md py-1 min-w-[160px]">
                <button
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-accent transition-colors flex items-center justify-between gap-2 ${labelFilter === null ? "text-foreground font-medium" : "text-muted-foreground"}`}
                  onMouseDown={(e) => { e.preventDefault(); setLabelFilter(null); setLabelMenuOpen(false); }}
                >
                  All labels
                  {labelFilter === null && <span className="text-primary text-xs">✓</span>}
                </button>
                <div className="border-t border-border my-1" />
                {allLabels.map((label) => (
                  <button
                    key={label}
                    className={`w-full text-left px-3 py-2 text-sm hover:bg-accent transition-colors flex items-center justify-between gap-2 ${labelFilter === label ? "text-foreground font-medium" : "text-muted-foreground"}`}
                    onMouseDown={(e) => { e.preventDefault(); setLabelFilter(label); setLabelMenuOpen(false); }}
                  >
                    <span className="flex items-center gap-1.5">
                      <Tag className="size-3 shrink-0" />
                      {label}
                    </span>
                    {labelFilter === label && <span className="text-primary text-xs shrink-0">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {/* Sort dropdown */}
        <div className="relative" ref={sortMenuRef}>
          <Button
            variant={sortMode !== "default" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setSortMenuOpen((o) => !o)}
            className="gap-1"
            title="Sort tasks"
          >
            <ArrowDownUp className="size-3.5" />
            {sortMode !== "default" ? SORT_LABELS[sortMode] : "Sort"}
            <ChevronDown className="size-3" />
          </Button>
          {sortMenuOpen && (
            <div className="absolute right-0 top-full mt-1 z-50 bg-popover border border-border rounded-lg shadow-md py-1 min-w-[160px]">
              {(Object.entries(SORT_LABELS) as [SortMode, string][]).map(([mode, label]) => (
                <button
                  key={mode}
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-accent transition-colors flex items-center justify-between gap-2 ${sortMode === mode ? "text-foreground font-medium" : "text-muted-foreground"}`}
                  onMouseDown={(e) => { e.preventDefault(); setSortMode(mode); setSortMenuOpen(false); }}
                >
                  {label}
                  {sortMode === mode && <span className="text-primary text-xs">✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        {/* Bulk-clear dropdown — only shown when there are terminal tasks to remove */}
        {FILTERABLE_STATUSES.some((s) => counts[s] > 0) && (
          <div className="relative" ref={clearMenuRef}>
            <Button
              variant="ghost"
              size="sm"
              disabled={clearing || deleting}
              onClick={() => setClearMenuOpen((o) => !o)}
              className="gap-1"
            >
              <Trash2 className="size-3.5" />
              Clear
              <ChevronDown className="size-3" />
            </Button>
            {clearMenuOpen && (
              <div
                className="absolute right-0 top-full mt-1 z-50 bg-popover border border-border rounded-lg shadow-md py-1 min-w-[170px]"
                onBlur={() => setClearMenuOpen(false)}
              >
                {FILTERABLE_STATUSES
                  .filter((s) => counts[s] > 0)
                  .map((s) => (
                    <button
                      key={s}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-accent capitalize transition-colors"
                      onMouseDown={(e) => { e.preventDefault(); void handleBulkClear(s); }}
                    >
                      Clear {s.replace(/_/g, " ")} ({counts[s]})
                    </button>
                  ))}
                {FILTERABLE_STATUSES.filter((s) => counts[s] > 0).length > 1 && (
                  <>
                    <div className="border-t border-border my-1" />
                    <button
                      className="w-full text-left px-3 py-2 text-sm hover:bg-accent text-destructive transition-colors"
                      onMouseDown={(e) => { e.preventDefault(); void handleBulkClear("all"); }}
                    >
                      Clear all finished
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
        {/* Bulk-retry button — shown when there are failed/killed/timed-out tasks */}
        {(counts["failed"] > 0 || counts["killed"] > 0 || counts["timedout"] > 0) && (
          <Button
            variant="ghost"
            size="sm"
            disabled={retrying}
            onClick={() => {
              const statusesToRetry = (["failed", "killed", "timedout"] as const).filter((s) => counts[s] > 0);
              void handleBulkRetry(statusesToRetry);
            }}
            className="gap-1 shrink-0"
            title="Re-queue all failed, killed, and timed-out tasks as pending"
          >
            <RotateCcw className="size-3.5" />
            {retrying ? "Retrying…" : "Retry failed"}
          </Button>
        )}
        </div>
      </div>
      <p className="text-sm text-zinc-500">
        {runningCount > 0 && <span className="text-blue-400">{runningCount} running · </span>}
        {statCounts.map(({ status, count }, i) => (
          <span key={status}>
            {count} {status.replace(/_/g, " ")}{i < statCounts.length - 1 ? " · " : ""}
          </span>
        ))}
        {repoFilter &&<span className="text-sky-400/80"> · repo: {repoFilter}</span>}
        {labelFilter && <span className="text-primary/70"> · label: {labelFilter}</span>}
        {pinnedIds.size > 0 && <span className="text-yellow-400/70"> · <Star className="inline size-3 fill-yellow-400 text-yellow-400 relative -top-px" /> {pinnedIds.size} pinned</span>}
      </p>
    </div>
  );

  const hasFilters = FILTERABLE_STATUSES.some((s) => counts[s] > 0) || disabledCount > 0;
  const filterBar = hasFilters && (
    <div className="flex gap-2 mb-3 flex-wrap">
      {FILTERABLE_STATUSES.map((status) => {
        if (counts[status] === 0) return null;
        const hidden = hiddenStatuses.has(status);
        return (
          <button
            key={status}
            onClick={() => toggleStatus(status)}
            className={`text-xs px-3 py-1 rounded-full border transition-colors ${
              hidden
                ? "border-zinc-700 text-zinc-500 bg-transparent"
                : "border-zinc-500 text-zinc-300 bg-zinc-800"
            }`}
          >
            {hidden ? "Show" : "Hide"} {status.replace(/_/g, " ")} ({counts[status]})
          </button>
        );
      })}
      {disabledCount > 0 && (
        <button
          onClick={() => setHideDisabled((h) => !h)}
          className={`text-xs px-3 py-1 rounded-full border transition-colors ${
            hideDisabled
              ? "border-zinc-700 text-zinc-500 bg-transparent"
              : "border-zinc-500 text-zinc-300 bg-zinc-800"
          }`}
        >
          {hideDisabled ? "Show" : "Hide"} backlog ({disabledCount})
        </button>
      )}
    </div>
  );


  if (tasks.length === 0) {
    return (
      <>
        {statsBar}
        <div className="text-center py-16 text-muted-foreground col-span-full">
          No tasks yet.{" "}
          <Link href="/tasks/new" className="text-blue-400 hover:text-blue-300 underline">
            Create your first task
          </Link>
        </div>
      </>
    );
  }

  return (
    <>
      {statsBar}
      {filterBar && <div className="mb-3">{filterBar}</div>}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={visibleTasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          <div className={viewMode === "grid" ? "grid grid-cols-1 sm:grid-cols-2 gap-2" : "flex flex-col gap-2"}>
            {visibleTasks.map((task) => (
              <TaskCard key={task.id} task={task} onDelete={handleDelete} onRetry={handleRetry} onResume={handleResume} onRunNow={handleRunNow} onToggle={handleToggle} onEditThrottled={handleEditThrottled} onMoveToTop={handleMoveToTop} onPin={handlePin} pinned={pinnedIds.has(task.id)} queuePosition={queuePositions.get(task.id)} compact={compactView || viewMode === "grid"} />
            ))}
            {visibleTasks.length === 0 && (
              <p className="text-center py-8 text-muted-foreground text-sm col-span-full">
                All tasks hidden by filters.
              </p>
            )}
          </div>
        </SortableContext>
      </DndContext>
    </>
  );
}
