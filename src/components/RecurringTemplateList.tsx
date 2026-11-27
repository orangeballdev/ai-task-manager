"use client";
import { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Flame, Pencil, PlayCircle, Square, CheckSquare, ChevronDown, Power, PowerOff, Trash2 } from "lucide-react";
import Link from "next/link";
import { RecurringTemplateCard } from "./RecurringTemplateCard";
import { BulkEditScheduledModal } from "./BulkEditScheduledModal";
import { BulkRunNowModal } from "./BulkRunNowModal";
import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import type { Task } from "@/lib/types";
import type { InstanceStats } from "./TasksPageView";
import { toast } from "sonner";
import { confirm } from "@/components/ui/confirm-dialog";
import { useCompactView, type ViewMode } from "@/lib/use-layout-preferences";
import { beginDelete, endDelete } from "@/lib/delete-lock";
import { getAnalytics } from "@/components/WebAnalytics";

export function RecurringTemplateList({ initialTemplates, instanceStats = {}, viewMode = "list" }: { initialTemplates: Task[]; instanceStats?: InstanceStats; viewMode?: ViewMode }) {
  const [templates, setTemplates] = useState(initialTemplates);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkSettingHailMary, setBulkSettingHailMary] = useState(false);
  const [bulkTogglingEnabled, setBulkTogglingEnabled] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [showBulkEditModal, setShowBulkEditModal] = useState(false);
  const [showBulkRunModal, setShowBulkRunModal] = useState(false);
  const compactView = useCompactView();
  const router = useRouter();
  const [defaultBaseBranch, setDefaultBaseBranch] = useState("main");

  const selectionMode = selectedIds.size > 0;

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data: Record<string, string>) => {
        if (data.git_default_base_branch) setDefaultBaseBranch(data.git_default_base_branch);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch("/api/tasks?type=recurring-templates");
        if (!res.ok) return;
        const fresh: Task[] = await res.json();
        setTemplates((prev) => prev.map((t) => fresh.find((f) => f.id === t.id) ?? t));
      } catch { /* ignore */ }
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    const ok = await confirm({
      title: "Delete recurring task",
      description: "Delete this recurring task and all its instances? This cannot be undone.",
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/tasks/${id}`, { method: "DELETE" });
      if (res.ok) {
        setTemplates((prev) => prev.filter((t) => t.id !== id));
        setSelectedIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
      } else {
        toast.error("Failed to delete recurring task");
      }
    } catch {
      toast.error("Failed to delete recurring task");
    } finally {
      endDelete();
    }
  }, []);

  const handleRunNow = useCallback(async (id: string, count?: number) => {
    // Cap mirrors /api/tasks/[id]/run-now (1..50). Passing count > 1 lets the
    // card queue multiple instances inline without using the bulk action UI.
    const runCount = Math.max(1, Math.min(count ?? 1, 50));
    try {
      const res = await fetch(`/api/tasks/${id}/run-now`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: runCount }),
      });
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as { count?: number };
        const queued = data.count ?? runCount;
        toast.success(`${queued} task instance${queued !== 1 ? "s" : ""} queued`);
        router.refresh();
      } else {
        toast.error("Failed to trigger task");
      }
    } catch {
      toast.error("Failed to trigger task");
    }
  }, [router]);

  const handleToggle = useCallback(async (id: string, enabled: boolean) => {
    try {
      const res = await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isEnabled: enabled }),
      });
      if (res.ok) {
        setTemplates((prev) => prev.map((t) => t.id === id ? { ...t, isEnabled: enabled } : t));
        toast.success(enabled ? "Recurring task enabled" : "Recurring task disabled");
      } else {
        toast.error("Failed to update recurring task");
      }
    } catch {
      toast.error("Failed to update recurring task");
    }
  }, []);

  const handleSelectChange = useCallback((id: string, selected: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (selected) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    if (selectedIds.size === templates.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(templates.map((t) => t.id)));
    }
  }, [selectedIds, templates]);

  const handleBulkRunNow = useCallback(async (count: number) => {
    if (selectedIds.size === 0) return;
    const runCount = Math.max(1, Math.min(count || 1, 50));
    setBulkRunning(true);
    try {
      const res = await fetch("/api/tasks/bulk-run-now", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selectedIds), count: runCount }),
      });
      if (res.ok) {
        const data = await res.json() as { count: number };
        getAnalytics()?.capture("task_action", { action: "bulk_run_now", count: data.count });
        toast.success(`${data.count} task instance${data.count !== 1 ? "s" : ""} queued`);
        setSelectedIds(new Set());
        setShowBulkRunModal(false);
        router.refresh();
      } else {
        toast.error("Failed to queue tasks");
      }
    } catch {
      toast.error("Failed to queue tasks");
    } finally {
      setBulkRunning(false);
    }
  }, [selectedIds, router]);

  const handleBulkToggleEnabled = useCallback(async (isEnabled: boolean) => {
    if (selectedIds.size === 0) return;
    setBulkTogglingEnabled(true);
    const ids = Array.from(selectedIds);
    try {
      const res = await fetch("/api/tasks/bulk-edit", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, isEnabled }),
      });
      if (res.ok) {
        const data = await res.json() as { updated: number };
        setTemplates((prev) => prev.map((t) => ids.includes(t.id) ? { ...t, isEnabled } : t));
        toast.success(`${data.updated} task${data.updated !== 1 ? "s" : ""} ${isEnabled ? "enabled" : "disabled"}`);
        setSelectedIds(new Set());
      } else {
        toast.error("Failed to update tasks");
      }
    } catch {
      toast.error("Failed to update tasks");
    } finally {
      setBulkTogglingEnabled(false);
    }
  }, [selectedIds]);

  const handleBulkMarkHailMary = useCallback(async (isHailMary: boolean) => {
    if (selectedIds.size === 0) return;
    setBulkSettingHailMary(true);
    const ids = Array.from(selectedIds);
    try {
      const res = await fetch("/api/tasks/bulk-hail-mary", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, isHailMary }),
      });
      if (res.ok) {
        setTemplates((prev) => prev.map((t) => ids.includes(t.id) ? { ...t, isHailMary } : t));
        toast.success(isHailMary ? `${ids.length} task${ids.length !== 1 ? "s" : ""} marked as Hail Mary` : `Hail Mary removed from ${ids.length} task${ids.length !== 1 ? "s" : ""}`);
        setSelectedIds(new Set());
      } else {
        toast.error("Failed to update tasks");
      }
    } catch {
      toast.error("Failed to update tasks");
    } finally {
      setBulkSettingHailMary(false);
    }
  }, [selectedIds]);

  const handleBulkDelete = useCallback(async () => {
    if (selectedIds.size === 0) return;
    const ok = await confirm({
      title: "Delete recurring tasks",
      description: `Delete ${selectedIds.size} recurring task${selectedIds.size !== 1 ? "s" : ""} and all their instances? This cannot be undone.`,
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    const ids = Array.from(selectedIds);
    setBulkDeleting(true);
    beginDelete();
    try {
      const results = await Promise.all(ids.map((id) => fetch(`/api/tasks/${id}`, { method: "DELETE" }).then((res) => ({ id, ok: res.ok }))));
      const deletedIds = new Set(results.filter((r) => r.ok).map((r) => r.id));
      const failedCount = results.length - deletedIds.size;
      setTemplates((prev) => prev.filter((t) => !deletedIds.has(t.id)));
      setSelectedIds(new Set());
      if (failedCount > 0) {
        toast.error(`Failed to delete ${failedCount} task${failedCount !== 1 ? "s" : ""}`);
      } else {
        toast.success(`${deletedIds.size} task${deletedIds.size !== 1 ? "s" : ""} deleted`);
      }
    } finally {
      setBulkDeleting(false);
      endDelete();
    }
  }, [selectedIds]);

  const handleBulkEditSuccess = useCallback((updates: { cronExpression?: string | null; aiProviderId?: string | null; model?: string | null }) => {
    const ids = Array.from(selectedIds);
    setTemplates((prev) => prev.map((t) => {
      if (!ids.includes(t.id)) return t;
      return {
        ...t,
        ...(updates.cronExpression !== undefined ? { cronExpression: updates.cronExpression } : {}),
        ...(updates.aiProviderId !== undefined ? { aiProviderId: updates.aiProviderId } : {}),
        ...(updates.model !== undefined ? { model: updates.model } : {}),
      };
    }));
    setShowBulkEditModal(false);
    setSelectedIds(new Set());
    router.refresh();
  }, [selectedIds, router]);

  const allSelected = templates.length > 0 && selectedIds.size === templates.length;
  const someSelected = selectedIds.size > 0 && selectedIds.size < templates.length;

  return (
    <div className="flex flex-col gap-3">
      {showBulkEditModal && (
        <BulkEditScheduledModal
          selectedIds={Array.from(selectedIds)}
          onClose={() => setShowBulkEditModal(false)}
          onSuccess={handleBulkEditSuccess}
        />
      )}
      {showBulkRunModal && (
        <BulkRunNowModal
          selectedCount={selectedIds.size}
          running={bulkRunning}
          onClose={() => setShowBulkRunModal(false)}
          onConfirm={(count) => void handleBulkRunNow(count)}
        />
      )}
      {/* Select all / bulk controls header */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSelectAll}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          title={allSelected ? "Deselect all" : "Select all"}
        >
          {allSelected ? (
            <CheckSquare size={14} className="text-primary" />
          ) : someSelected ? (
            <CheckSquare size={14} className="text-primary/60" />
          ) : (
            <Square size={14} />
          )}
          {allSelected ? "Deselect all" : "Select all"}
        </button>

        {/* Hail Mary info */}
        {templates.some((t) => t.isHailMary) && (
          <span className="text-xs text-muted-foreground ml-auto flex items-center gap-1">
            <Flame size={12} className="text-orange-400" />
            {templates.filter((t) => t.isHailMary).length} Hail Mary task{templates.filter((t) => t.isHailMary).length !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* Bulk action bar */}
      {selectionMode && (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 bg-primary/5 border border-primary/20 rounded-lg">
          <span className="text-sm font-medium text-foreground shrink-0">
            {selectedIds.size} selected
          </span>
          <div className="flex flex-wrap items-center gap-2 ml-auto">
            <DropdownMenu>
              <DropdownMenuTrigger
                className={buttonVariants({ variant: "secondary", size: "sm" }) + " h-7 text-xs gap-1.5"}
                disabled={bulkRunning || bulkSettingHailMary || bulkTogglingEnabled || bulkDeleting}
              >
                Actions
                <ChevronDown className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48">
                <DropdownMenuItem onClick={() => setShowBulkRunModal(true)}>
                  <PlayCircle className="size-4" />
                  Run now…
                </DropdownMenuItem>
                {selectedIds.size === 1 ? (
                  <DropdownMenuItem render={<Link href={`/tasks/${Array.from(selectedIds)[0]}/edit`} />}>
                    <Pencil className="size-4" />
                    Edit
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onClick={() => setShowBulkEditModal(true)}>
                    <Pencil className="size-4" />
                    Edit…
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => void handleBulkToggleEnabled(true)}>
                  <Power className="size-4 text-green-400" />
                  Enable
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => void handleBulkToggleEnabled(false)}>
                  <PowerOff className="size-4 text-muted-foreground" />
                  Disable
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => void handleBulkMarkHailMary(true)}>
                  <Flame className="size-4 text-orange-400" />
                  Mark as Hail Mary
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => void handleBulkMarkHailMary(false)}>
                  <Flame className="size-4 text-muted-foreground" />
                  Remove Hail Mary
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => void handleBulkDelete()}>
                  <Trash2 className="size-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors ml-1"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className={viewMode === "grid" ? "grid grid-cols-1 sm:grid-cols-2 gap-2" : "flex flex-col gap-2"}>
        {templates.map((t) => (
          <RecurringTemplateCard
            key={t.id}
            task={t}
            onDelete={handleDelete}
            onToggle={handleToggle}
            onRunNow={handleRunNow}
            stats={instanceStats[t.id]}
            selectable={true}
            selected={selectedIds.has(t.id)}
            onSelectChange={handleSelectChange}
            compact={compactView || viewMode === "grid"}
            defaultBaseBranch={defaultBaseBranch}
          />
        ))}
      </div>
    </div>
  );
}
