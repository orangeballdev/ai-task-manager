"use client";

import { RecurringTemplateList } from "@/components/RecurringTemplateList";
import { TaskList } from "@/components/TaskList";
import type { Task } from "@/lib/types";
import Link from "next/link";
import { Flame, List, Repeat, Webhook, Zap } from "lucide-react";
import { useState, useMemo, useCallback } from "react";
import { toast } from "sonner";
import { useRouter, useSearchParams } from "next/navigation";
import { useViewMode } from "@/lib/use-layout-preferences";
import { getAnalytics } from "@/components/WebAnalytics";

type Tab = "all" | "adhoc" | "scheduled" | "webhook";
const TABS: Tab[] = ["all", "adhoc", "scheduled", "webhook"];
export type { ViewMode } from "@/lib/use-layout-preferences";

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative px-2.5 sm:px-4 py-2.5 text-sm font-medium transition-colors whitespace-nowrap ${
        active
          ? "text-foreground after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-foreground after:rounded-full"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function CountBadge({ count, active }: { count: number; active: boolean }) {
  return (
    <span
      className={`ml-1.5 text-xs px-1.5 py-0.5 rounded-full font-normal tabular-nums ${
        active
          ? "bg-foreground/10 text-foreground"
          : "bg-muted text-muted-foreground"
      }`}
    >
      {count}
    </span>
  );
}

export type InstanceStats = Record<string, { completed: number; failed: number; total: number }>;

export function TasksPageView({
  tasks,
  scheduledTasks,
  webhookTasks,
  recurringTemplates,
  instanceStats = {},
}: {
  tasks: Task[];
  scheduledTasks: Task[];
  webhookTasks: Task[];
  recurringTemplates: Task[];
  instanceStats?: InstanceStats;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Default to the "All" tab on first load so users always land on the
  // full combined task list rather than being routed to "Scheduled" based on
  // the current task mix. A tab param in the URL (set when the user switches
  // tabs) overrides this so the back button can restore the tab they left.
  const tabParam = searchParams.get("tab");
  const initialTab: Tab = TABS.includes(tabParam as Tab) ? (tabParam as Tab) : "all";
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);
  const [runningHailMary, setRunningHailMary] = useState(false);
  const viewMode = useViewMode();

  const selectTab = useCallback((tab: Tab) => {
    setActiveTab(tab);
    router.replace(tab === "all" ? "/tasks" : `/tasks?tab=${tab}`, { scroll: false });
  }, [router]);

  const enabledCount = recurringTemplates.filter((t) => t.isEnabled).length;
  const hailMaryCount = recurringTemplates.filter((t) => t.isHailMary && t.isEnabled).length;

  const handleRunAllHailMary = useCallback(async () => {
    setRunningHailMary(true);
    try {
      const res = await fetch("/api/tasks/bulk-hail-mary", { method: "POST" });
      if (res.ok) {
        const data = await res.json() as { count: number };
        if (data.count === 0) {
          toast.info("No enabled Hail Mary tasks to run");
        } else {
          getAnalytics()?.capture("task_action", { action: "hail_mary", count: data.count });
          toast.success(`${data.count} Hail Mary task instance${data.count !== 1 ? "s" : ""} queued`);
          router.refresh();
        }
      } else {
        toast.error("Failed to run Hail Mary tasks");
      }
    } catch {
      toast.error("Failed to run Hail Mary tasks");
    } finally {
      setRunningHailMary(false);
    }
  }, [router]);

  // "no_changes" tasks ran to completion (just without code changes), so treat them as
  // inactive alongside the other terminal statuses when counting active tasks per tab.
  const INACTIVE_STATUSES = ["completed", "no_changes", "failed", "killed", "timedout"] as const;
  const adHocActiveCount = tasks.filter((t) => !INACTIVE_STATUSES.includes(t.status as typeof INACTIVE_STATUSES[number])).length;
  const webhookActiveCount = webhookTasks.filter((t) => !INACTIVE_STATUSES.includes(t.status as typeof INACTIVE_STATUSES[number])).length;
  const scheduledActiveCount = scheduledTasks.filter((t) => !INACTIVE_STATUSES.includes(t.status as typeof INACTIVE_STATUSES[number])).length;
  const scheduledBadgeCount = enabledCount + scheduledActiveCount;

  // All non-template tasks combined for the "All" tab (sorted by updatedAt desc)
  const allTasks = useMemo(() => {
    return [...tasks, ...scheduledTasks, ...webhookTasks].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }, [tasks, scheduledTasks, webhookTasks]);
  const allActiveCount = allTasks.filter((t) => !INACTIVE_STATUSES.includes(t.status as typeof INACTIVE_STATUSES[number])).length;

  return (
    <div>
      <div className="flex items-center justify-between border-b border-border mb-6">
        <div className="flex overflow-x-auto">
          <TabButton active={activeTab === "all"} onClick={() => selectTab("all")}>
            <span className="inline-flex items-center gap-1.5">
              <List className="size-3.5" />
              All
            </span>
            {allTasks.length > 0 && <CountBadge count={allActiveCount || allTasks.length} active={activeTab === "all"} />}
          </TabButton>
          <TabButton active={activeTab === "adhoc"} onClick={() => selectTab("adhoc")}>
            <span className="inline-flex items-center gap-1.5">
              <Zap className="size-3.5" />
              <span className="hidden sm:inline">Ad-hoc</span>
              <span className="sm:hidden">Ad-hoc</span>
            </span>
            {tasks.length > 0 && <CountBadge count={adHocActiveCount || tasks.length} active={activeTab === "adhoc"} />}
          </TabButton>
          <TabButton active={activeTab === "scheduled"} onClick={() => selectTab("scheduled")}>
            <span className="inline-flex items-center gap-1.5">
              <Repeat className="size-3.5" />
              Scheduled
            </span>
            {scheduledBadgeCount > 0 && (
              <CountBadge count={scheduledBadgeCount} active={activeTab === "scheduled"} />
            )}
          </TabButton>
          <TabButton active={activeTab === "webhook"} onClick={() => selectTab("webhook")}>
            <span className="inline-flex items-center gap-1.5">
              <Webhook className="size-3.5" />
              Webhook
            </span>
            {webhookTasks.length > 0 && (
              <CountBadge count={webhookActiveCount || webhookTasks.length} active={activeTab === "webhook"} />
            )}
          </TabButton>
        </div>
      </div>

      {activeTab === "all" && (
        <TaskList initialTasks={allTasks} viewMode={viewMode} />
      )}

      {activeTab === "adhoc" && <TaskList initialTasks={tasks} viewMode={viewMode} />}

      {activeTab === "scheduled" && (
        <>
          {recurringTemplates.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              No scheduled tasks yet.{" "}
              <Link href="/tasks/new" className="text-blue-400 hover:text-blue-300 underline">
                Create a recurring task
              </Link>
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-medium text-foreground">
                  Schedules <span className="text-muted-foreground font-normal">· {enabledCount} of {recurringTemplates.length} enabled</span>
                </h2>
                {hailMaryCount > 0 && (
                  <button
                    type="button"
                    disabled={runningHailMary}
                    onClick={() => void handleRunAllHailMary()}
                    className="flex items-center gap-1.5 text-xs font-medium text-orange-400 hover:text-orange-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ml-auto"
                    title={`Run all ${hailMaryCount} Hail Mary task${hailMaryCount !== 1 ? "s" : ""} now`}
                  >
                    <Flame size={13} />
                    {runningHailMary ? "Running…" : `Run Hail Mary (${hailMaryCount})`}
                  </button>
                )}
              </div>
              <RecurringTemplateList initialTemplates={recurringTemplates} instanceStats={instanceStats} viewMode={viewMode} />
            </div>
          )}
        </>
      )}

      {activeTab === "webhook" && (
        <>
          {webhookTasks.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground flex flex-col items-center gap-3">
              <p>No webhook-triggered tasks yet.</p>
              <a
                href="/webhooks"
                className="inline-flex items-center gap-1.5 text-sm bg-primary text-primary-foreground hover:bg-primary/90 px-4 py-2 rounded-md font-medium transition-colors"
              >
                <Webhook className="size-4" />
                Add New Webhook
              </a>
            </div>
          ) : (
            <TaskList initialTasks={webhookTasks} viewMode={viewMode} />
          )}
        </>
      )}
    </div>
  );
}
