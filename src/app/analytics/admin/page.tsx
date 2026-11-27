import { prisma } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import Link from "next/link";
import { AnalyticsTabs } from "../AnalyticsTabs";

// ── AWS Batch Fargate pricing (us-east-1, 2024) ──────────────────────────────
// https://aws.amazon.com/fargate/pricing/
const VCPU_PRICE_PER_HR = 0.04048;   // $ per vCPU-hour
const MEM_PRICE_PER_GB_HR = 0.004445; // $ per GB-hour

// Also include Fargate Spot (approx 70 % savings vs on-demand)
const SPOT_VCPU_PRICE_PER_HR = 0.01212;
const SPOT_MEM_PRICE_PER_GB_HR = 0.001334;

interface InstanceSize {
  key: string;
  label: string;
  vcpu: number;
  memGb: number;
  description: string;
}

const INSTANCE_SIZES: InstanceSize[] = [
  { key: "small",    label: "Small",   vcpu: 0.25, memGb: 0.5, description: "0.25 vCPU · 0.5 GB RAM" },
  { key: "standard", label: "Standard",vcpu: 0.5,  memGb: 1,   description: "0.5 vCPU · 1 GB RAM" },
  { key: "large",    label: "Large",   vcpu: 1,    memGb: 2,   description: "1 vCPU · 2 GB RAM" },
  { key: "xlarge",   label: "X-Large", vcpu: 2,    memGb: 4,   description: "2 vCPU · 4 GB RAM" },
];

type RangeKey = "7d" | "30d" | "90d" | "all";

const RANGE_OPTIONS: { key: RangeKey; label: string; days: number | null }[] = [
  { key: "7d",  label: "7d",  days: 7   },
  { key: "30d", label: "30d", days: 30  },
  { key: "90d", label: "90d", days: 90  },
  { key: "all", label: "All", days: null },
];

function getRangeCutoff(range: RangeKey): Date | null {
  const opt = RANGE_OPTIONS.find((r) => r.key === range);
  if (!opt || opt.days === null) return null;
  return new Date(Date.now() - opt.days * 24 * 60 * 60 * 1000);
}

function pricePerHour(vcpu: number, memGb: number, spot: boolean): number {
  if (spot) return vcpu * SPOT_VCPU_PRICE_PER_HR + memGb * SPOT_MEM_PRICE_PER_GB_HR;
  return vcpu * VCPU_PRICE_PER_HR + memGb * MEM_PRICE_PER_GB_HR;
}

function taskCost(durationMs: number, vcpu: number, memGb: number, spot: boolean): number {
  const hours = durationMs / (1000 * 60 * 60);
  return hours * pricePerHour(vcpu, memGb, spot);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) return `${hrs}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}

function statCard(label: string, value: string, sub?: string) {
  return (
    <Card key={label}>
      <CardContent className="pt-5 pb-4">
        <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">{label}</p>
        <p className="text-2xl font-bold">{value}</p>
        {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  );
}

const PAGE_SIZE = 20;

export const dynamic = "force-dynamic";

interface TaskRow {
  id: string;
  title: string;
  status: string;
  createdAt: Date;
}

export default async function AdminAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const resolved = await searchParams;

  const rawRange = resolved.range ?? "30d";
  const range: RangeKey = (["7d", "30d", "90d", "all"] as RangeKey[]).includes(rawRange as RangeKey)
    ? (rawRange as RangeKey)
    : "30d";
  const cutoff = getRangeCutoff(range);

  const rawSize = resolved.size ?? "standard";
  const instanceSize: InstanceSize =
    INSTANCE_SIZES.find((s) => s.key === rawSize) ?? INSTANCE_SIZES[1];

  const spot = resolved.spot === "1";

  const parsedPage = parseInt(resolved.page ?? "1", 10);

  // ── Fetch tasks ─────────────────────────────────────────────────────────────
  const where = {
    isRecurringTemplate: false,
    status: { in: ["completed", "failed", "timedout", "killed"] },
    ...(cutoff ? { createdAt: { gte: cutoff } } : {}),
  };

  const totalTasks = await prisma.task.count({ where });
  const totalPages = Math.max(1, Math.ceil(totalTasks / PAGE_SIZE));
  const page = Math.min(Math.max(1, Number.isNaN(parsedPage) ? 1 : parsedPage), totalPages);

  const tasks = (await prisma.task.findMany({
    where,
    select: { id: true, title: true, status: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
  })) as TaskRow[];

  // ── Compute durations for visible tasks ─────────────────────────────────────
  const taskIds = tasks.map((t) => t.id);

  const startLogs = (await prisma.taskLog.findMany({
    where: { taskId: { in: taskIds }, level: "system", content: { startsWith: "Starting task:" } },
    select: { taskId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    distinct: ["taskId"],
  })) as { taskId: string; createdAt: Date }[];

  const endLogs = (await prisma.taskLog.findMany({
    where: { taskId: { in: taskIds } },
    select: { taskId: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    distinct: ["taskId"],
  })) as { taskId: string; createdAt: Date }[];

  const startMap = new Map(startLogs.map((l) => [l.taskId, new Date(l.createdAt).getTime()]));
  const endMap = new Map(endLogs.map((l) => [l.taskId, new Date(l.createdAt).getTime()]));

  const taskDurations = new Map<string, number>();
  for (const id of taskIds) {
    const s = startMap.get(id);
    const e = endMap.get(id);
    if (s !== undefined && e !== undefined && e > s) taskDurations.set(id, e - s);
  }

  // ── Aggregate durations across ALL tasks in range (for summary) ─────────────
  const allStartLogs = (await prisma.taskLog.findMany({
    where: {
      level: "system",
      content: { startsWith: "Starting task:" },
      task: where,
    },
    select: { taskId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    distinct: ["taskId"],
  })) as { taskId: string; createdAt: Date }[];

  const allEndLogs = (await prisma.taskLog.findMany({
    where: { taskId: { in: allStartLogs.map((l) => l.taskId) } },
    select: { taskId: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    distinct: ["taskId"],
  })) as { taskId: string; createdAt: Date }[];

  const allStartMap = new Map(allStartLogs.map((l) => [l.taskId, new Date(l.createdAt).getTime()]));
  const allEndMap = new Map(allEndLogs.map((l) => [l.taskId, new Date(l.createdAt).getTime()]));

  let totalDurationMs = 0;
  let tasksWithDuration = 0;
  const allTaskCosts: number[] = [];

  for (const [tid, s] of allStartMap) {
    const e = allEndMap.get(tid);
    if (e !== undefined && e > s) {
      const dur = e - s;
      totalDurationMs += dur;
      tasksWithDuration += 1;
      allTaskCosts.push(taskCost(dur, instanceSize.vcpu, instanceSize.memGb, spot));
    }
  }

  const totalEstCost = allTaskCosts.reduce((a, b) => a + b, 0);
  const avgCostPerTask = tasksWithDuration > 0 ? totalEstCost / tasksWithDuration : null;
  const avgDurationMs = tasksWithDuration > 0 ? totalDurationMs / tasksWithDuration : null;

  const hourlyRate = pricePerHour(instanceSize.vcpu, instanceSize.memGb, spot);

  // Helper to build URL preserving current params
  function buildUrl(overrides: Record<string, string>) {
    const params = new URLSearchParams({
      range,
      size: instanceSize.key,
      ...(spot ? { spot: "1" } : {}),
      page: String(page),
      ...overrides,
    });
    return `/analytics/admin?${params.toString()}`;
  }

  return (
    <div className="max-w-7xl mx-auto flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <Link href="/analytics" className="text-sm text-muted-foreground hover:text-foreground block mb-2">
            ← Analytics
          </Link>
          <h1 className="text-2xl font-bold">Admin: AWS Batch Cost Estimates</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Projected cost to run each task as an AWS Batch Fargate job, based on actual task duration.
          </p>
        </div>

        {/* Time range selector */}
        <div className="flex items-center gap-1 bg-muted rounded-lg p-1 shrink-0 mt-6 sm:mt-6">
          {RANGE_OPTIONS.map((opt) => (
            <Link
              key={opt.key}
              href={buildUrl({ range: opt.key, page: "1" })}
              className={`px-3 py-1 text-sm rounded-md transition-colors font-medium ${
                range === opt.key
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {opt.label}
            </Link>
          ))}
        </div>
      </div>

      <AnalyticsTabs active="admin" />

      {/* Instance size & spot selectors */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Instance Configuration</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-2">Fargate Instance Size</p>
            <div className="flex flex-wrap gap-2">
              {INSTANCE_SIZES.map((sz) => (
                <Link
                  key={sz.key}
                  href={buildUrl({ size: sz.key, page: "1" })}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium border transition-colors ${
                    instanceSize.key === sz.key
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
                  }`}
                >
                  <span className="font-semibold">{sz.label}</span>
                  <span className="ml-1.5 text-xs opacity-75">{sz.description}</span>
                </Link>
              ))}
            </div>
          </div>

          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-2">Pricing Mode</p>
            <div className="flex gap-2">
              <Link
                href={buildUrl({ spot: "0", page: "1" })}
                className={`px-3 py-1.5 rounded-md text-sm font-medium border transition-colors ${
                  !spot
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
                }`}
              >
                On-Demand
              </Link>
              <Link
                href={buildUrl({ spot: "1", page: "1" })}
                className={`px-3 py-1.5 rounded-md text-sm font-medium border transition-colors ${
                  spot
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
                }`}
              >
                Fargate Spot
                <span className="ml-1.5 text-xs opacity-75">~70% savings</span>
              </Link>
            </div>
          </div>

          {/* Pricing info box */}
          <div className="rounded-md bg-muted/40 border border-border p-3 text-xs text-muted-foreground space-y-1">
            <p>
              <span className="font-medium text-foreground">Selected:</span>{" "}
              {instanceSize.description} ({spot ? "Fargate Spot" : "On-Demand"})
            </p>
            <p>
              <span className="font-medium text-foreground">Rate:</span>{" "}
              ${hourlyRate.toFixed(5)}/hr &nbsp;·&nbsp;
              ${(hourlyRate / 60).toFixed(6)}/min &nbsp;·&nbsp;
              ${(hourlyRate / 3600).toFixed(7)}/sec
            </p>
            <p className="opacity-70">
              Prices are AWS Batch Fargate (us-east-1, 2024). vCPU: $
              {spot ? SPOT_VCPU_PRICE_PER_HR : VCPU_PRICE_PER_HR}/vCPU-hr · Memory: $
              {spot ? SPOT_MEM_PRICE_PER_GB_HR : MEM_PRICE_PER_GB_HR}/GB-hr.
              Costs are computed from actual task duration (start → last log line).
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {statCard("Tasks Analyzed", String(tasksWithDuration), `of ${totalTasks} finished tasks`)}
        {statCard(
          "Total Compute Time",
          avgDurationMs !== null ? formatDuration(totalDurationMs) : "—",
          tasksWithDuration > 0 ? `avg ${formatDuration(avgDurationMs!)} / task` : undefined
        )}
        {statCard(
          "Total Est. Batch Cost",
          totalEstCost > 0 ? `$${totalEstCost.toFixed(4)}` : "—",
          `${instanceSize.description} · ${spot ? "Spot" : "On-Demand"}`
        )}
        {statCard(
          "Avg Cost / Task",
          avgCostPerTask !== null ? `$${avgCostPerTask.toFixed(5)}` : "—",
          avgCostPerTask !== null ? `at $${hourlyRate.toFixed(5)}/hr` : undefined
        )}
      </div>

      {/* Per-task cost table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Cost Per Task</CardTitle>
        </CardHeader>
        <CardContent className="pt-0 px-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-6 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">Task</th>
                  <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">Status</th>
                  <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">Duration</th>
                  <th className="text-right px-6 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Est. Batch Cost
                  </th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((t) => {
                  const dur = taskDurations.get(t.id);
                  const cost = dur !== undefined
                    ? taskCost(dur, instanceSize.vcpu, instanceSize.memGb, spot)
                    : null;
                  return (
                    <tr key={t.id} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
                      <td className="px-6 py-2.5">
                        <Link href={`/tasks/${t.id}`} className="hover:underline font-medium text-foreground line-clamp-1">
                          {t.title}
                        </Link>
                        <p className="text-xs text-muted-foreground">{new Date(t.createdAt).toLocaleDateString()}</p>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full capitalize ${
                            t.status === "completed"
                              ? "bg-green-500/15 text-green-400"
                              : "bg-red-500/15 text-red-400"
                          }`}
                        >
                          {t.status}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground tabular-nums">
                        {dur !== undefined ? formatDuration(dur) : <span className="text-muted-foreground/40">—</span>}
                      </td>
                      <td className="px-6 py-2.5 text-right tabular-nums font-medium">
                        {cost !== null ? (
                          <span>${cost.toFixed(5)}</span>
                        ) : (
                          <span className="text-muted-foreground/40">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {tasks.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-6 py-8 text-center text-sm text-muted-foreground">
                      No finished tasks in the selected range.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalTasks > 0 && (
            <div className="flex items-center justify-between px-6 pt-3">
              <p className="text-xs text-muted-foreground">
                {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, totalTasks)} of {totalTasks}
              </p>
              <div className="flex items-center gap-1">
                {page > 1 ? (
                  <Link
                    href={buildUrl({ page: String(page - 1) })}
                    className="px-3 py-1 text-sm rounded-md font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  >
                    ← Prev
                  </Link>
                ) : (
                  <span className="px-3 py-1 text-sm rounded-md font-medium text-muted-foreground/40 cursor-not-allowed">← Prev</span>
                )}
                <span className="px-2 text-xs text-muted-foreground tabular-nums">
                  Page {page} of {totalPages}
                </span>
                {page < totalPages ? (
                  <Link
                    href={buildUrl({ page: String(page + 1) })}
                    className="px-3 py-1 text-sm rounded-md font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  >
                    Next →
                  </Link>
                ) : (
                  <span className="px-3 py-1 text-sm rounded-md font-medium text-muted-foreground/40 cursor-not-allowed">Next →</span>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
