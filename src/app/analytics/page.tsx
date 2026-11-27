import { AnalyticsExportButton } from "@/components/AnalyticsExportButton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { prisma } from "@/lib/db";
import Link from "next/link";
import { AnalyticsTabs } from "./AnalyticsTabs";
import { buildTokenSpendBreakdown, type GatewaySpendRow, type TaskSpendRow } from "@/lib/token-spend";
import { ApiKeySpendTable, DailySpendBySourceChart, DailyCostChart, DailyTokensChart, LabelBreakdownTable, ProviderBreakdownChart, ProviderSuccessTable, SourceSplitBar, type LabelBreakdownRow } from "./AnalyticsCharts";

function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) return `${hrs}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}

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

export const dynamic = "force-dynamic";

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

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

interface TaskRow {
  status: string;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCost: number | null;
  provider: string;
  aiProviderId: string | null;
  labels: string | null;
  createdAt: Date;
  aiProvider: { name: string; type: string } | null;
}

interface RecentTaskRow {
  id: string;
  title: string;
  status: string;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCost: number | null;
  createdAt: Date;
  aiProvider: { name: string } | null;
}

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const resolvedParams = await searchParams;
  const rawRange = resolvedParams.range ?? "30d";
  const range: RangeKey = (["7d", "30d", "90d", "all"] as RangeKey[]).includes(rawRange as RangeKey)
    ? (rawRange as RangeKey)
    : "30d";
  const cutoff = getRangeCutoff(range);

  const RECENT_PAGE_SIZE = 5;
  const parsedPage = parseInt(resolvedParams.page ?? "1", 10);

  const tasks = (await prisma.task.findMany({
    where: {
      isRecurringTemplate: false,
      status: { in: ["completed", "failed", "timedout", "killed"] },
      ...(cutoff ? { createdAt: { gte: cutoff } } : {}),
    },
    select: { status: true, inputTokens: true, outputTokens: true, estimatedCost: true, provider: true, aiProviderId: true, labels: true, createdAt: true, aiProvider: { select: { name: true, type: true } } },
    orderBy: { createdAt: "asc" },
  })) as TaskRow[];

  const totalCompleted = tasks.filter((t: TaskRow) => t.status === "completed").length;
  const totalFailed = tasks.filter((t: TaskRow) => t.status !== "completed").length;
  const totalInputTokens = tasks.reduce((s: number, t: TaskRow) => s + (t.inputTokens ?? 0), 0);
  const totalOutputTokens = tasks.reduce((s: number, t: TaskRow) => s + (t.outputTokens ?? 0), 0);
  const totalCost = tasks.reduce((s: number, t: TaskRow) => s + (t.estimatedCost ?? 0), 0);

  // Build daily aggregates — tasks are already pre-filtered to the selected range
  const recent = tasks;

  const dailyMap = new Map<string, { tokens: number; cost: number; tasks: number }>();
  for (const t of recent) {
    const d = new Date(t.createdAt);
    const key = `${(d.getMonth() + 1).toString().padStart(2, "0")}/${d.getDate().toString().padStart(2, "0")}`;
    const row = dailyMap.get(key) ?? { tokens: 0, cost: 0, tasks: 0 };
    row.tokens += (t.inputTokens ?? 0) + (t.outputTokens ?? 0);
    row.cost += t.estimatedCost ?? 0;
    row.tasks += 1;
    dailyMap.set(key, row);
  }
  const dailyData = Array.from(dailyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, ...v }));

  // Provider breakdown (token usage)
  const providerMap = new Map<string, { tokens: number; cost: number; tasks: number }>();
  for (const t of tasks) {
    const name = t.aiProvider?.name ?? t.provider ?? "Unknown";
    const row = providerMap.get(name) ?? { tokens: 0, cost: 0, tasks: 0 };
    row.tokens += (t.inputTokens ?? 0) + (t.outputTokens ?? 0);
    row.cost += t.estimatedCost ?? 0;
    row.tasks += 1;
    providerMap.set(name, row);
  }
  const providerData = Array.from(providerMap.entries())
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.tokens - a.tokens);

  // Provider success/failure breakdown
  const providerSuccessMap = new Map<string, { completed: number; failed: number; total: number }>();
  for (const t of tasks) {
    const name = t.aiProvider?.name ?? t.provider ?? "Unknown";
    const row = providerSuccessMap.get(name) ?? { completed: 0, failed: 0, total: 0 };
    row.total += 1;
    if (t.status === "completed") row.completed += 1;
    else row.failed += 1;
    providerSuccessMap.set(name, row);
  }
  const providerSuccessData = Array.from(providerSuccessMap.entries())
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.total - a.total);

  // Label breakdown — parse each task's JSON labels array and aggregate stats
  const labelMap = new Map<string, LabelBreakdownRow>();
  for (const t of tasks) {
    if (!t.labels) continue;
    let taskLabels: string[];
    try { taskLabels = JSON.parse(t.labels) as string[]; } catch { continue; }
    if (!Array.isArray(taskLabels)) continue;
    for (const label of taskLabels) {
      const row = labelMap.get(label) ?? { label, total: 0, completed: 0, failed: 0, cost: 0 };
      row.total += 1;
      if (t.status === "completed") row.completed += 1;
      else row.failed += 1;
      row.cost += t.estimatedCost ?? 0;
      labelMap.set(label, row);
    }
  }
  const labelData = Array.from(labelMap.values()).sort((a, b) => b.total - a.total);

  // Token spend by source: task runs vs the OpenAI/Anthropic-compatible LLM gateway.
  // Every non-template task that reported tokens counts here (not only the finished statuses
  // above — a no_changes or paused run still spent them), so this is the full spend picture.
  const spendTasks = (await prisma.task.findMany({
    where: {
      isRecurringTemplate: false,
      OR: [{ inputTokens: { not: null } }, { outputTokens: { not: null } }],
      ...(cutoff ? { createdAt: { gte: cutoff } } : {}),
    },
    select: { createdAt: true, inputTokens: true, outputTokens: true, estimatedCost: true },
  })) as TaskSpendRow[];
  const gatewayUsage = (await prisma.llmGatewayUsage.findMany({
    where: cutoff ? { createdAt: { gte: cutoff } } : {},
    select: {
      createdAt: true, apiKeyId: true, apiKeyName: true, inputTokens: true, outputTokens: true,
      cacheReadTokens: true, cacheCreationTokens: true, estimatedCost: true, errorType: true,
    },
    orderBy: { createdAt: "asc" },
  })) as GatewaySpendRow[];
  const spend = buildTokenSpendBreakdown(spendTasks, gatewayUsage);

  // Recent tasks with cost (respects range filter), paginated 5 per page
  const recentWhere = {
    isRecurringTemplate: false,
    status: { in: ["completed", "failed", "timedout", "killed"] },
    ...(cutoff ? { createdAt: { gte: cutoff } } : {}),
  };
  const recentTotal = await prisma.task.count({ where: recentWhere });
  const recentTotalPages = Math.max(1, Math.ceil(recentTotal / RECENT_PAGE_SIZE));
  const recentPage = Math.min(Math.max(1, Number.isNaN(parsedPage) ? 1 : parsedPage), recentTotalPages);
  const recentTasks = (await prisma.task.findMany({
    where: recentWhere,
    select: { id: true, title: true, status: true, inputTokens: true, outputTokens: true, estimatedCost: true, createdAt: true, aiProvider: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    skip: (recentPage - 1) * RECENT_PAGE_SIZE,
    take: RECENT_PAGE_SIZE,
  })) as RecentTaskRow[];

  // Compute per-task duration from log timestamps (start log → last log)
  const recentTaskIds = recentTasks.map((t) => t.id);
  const startLogs = (await prisma.taskLog.findMany({
    where: { taskId: { in: recentTaskIds }, level: "system", content: { startsWith: "Starting task:" } },
    select: { taskId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    distinct: ["taskId"],
  })) as { taskId: string; createdAt: Date }[];
  const endLogs = (await prisma.taskLog.findMany({
    where: { taskId: { in: recentTaskIds } },
    select: { taskId: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    distinct: ["taskId"],
  })) as { taskId: string; createdAt: Date }[];

  const startMap = new Map(startLogs.map((l: { taskId: string; createdAt: Date }) => [l.taskId, new Date(l.createdAt).getTime()]));
  const endMap = new Map(endLogs.map((l: { taskId: string; createdAt: Date }) => [l.taskId, new Date(l.createdAt).getTime()]));

  const taskDurations = new Map<string, number>();
  for (const taskId of recentTaskIds) {
    const start = startMap.get(taskId);
    const end = endMap.get(taskId);
    if (start !== undefined && end !== undefined && end > start) {
      taskDurations.set(taskId, end - start);
    }
  }

  // Compute average duration across tasks in the selected range
  const allStartLogs = (await prisma.taskLog.findMany({
    where: {
      level: "system",
      content: { startsWith: "Starting task:" },
      ...(cutoff ? { createdAt: { gte: cutoff } } : {}),
    },
    select: { taskId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    distinct: ["taskId"],
  })) as { taskId: string; createdAt: Date }[];
  const allEndLogs = (await prisma.taskLog.findMany({
    where: { taskId: { in: allStartLogs.map((l: { taskId: string }) => l.taskId) } },
    select: { taskId: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    distinct: ["taskId"],
  })) as { taskId: string; createdAt: Date }[];

  const allStartMap = new Map(allStartLogs.map((l: { taskId: string; createdAt: Date }) => [l.taskId, new Date(l.createdAt).getTime()]));
  const allEndMap = new Map(allEndLogs.map((l: { taskId: string; createdAt: Date }) => [l.taskId, new Date(l.createdAt).getTime()]));
  const durations: number[] = [];
  for (const [tid, start] of allStartMap) {
    const end = allEndMap.get(tid);
    if (end !== undefined && end > start) durations.push(end - start);
  }
  const avgDurationMs = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : null;

  const chartRangeLabel = range === "all" ? "All time" : `${range === "7d" ? "7" : range === "30d" ? "30" : "90"}d`;

  return (
    <div className="max-w-7xl mx-auto flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <Link href="/tasks" className="text-sm text-muted-foreground hover:text-foreground block mb-2">← Tasks</Link>
          <h1 className="text-2xl font-bold">Analytics</h1>
          <p className="text-muted-foreground text-sm mt-1">Token usage and cost across tasks and the LLM gateway.</p>
        </div>
        {/* Controls: CSV export + time range selector */}
        <div className="flex items-center gap-3 mt-6 sm:mt-6 shrink-0 flex-wrap">
          <AnalyticsExportButton range={range} />
          {/* Time range selector */}
        <div className="flex items-center gap-1 bg-muted rounded-lg p-1 shrink-0">
          {RANGE_OPTIONS.map((opt) => (
            <Link
              key={opt.key}
              href={`/analytics?range=${opt.key}`}
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
      </div>

      <AnalyticsTabs active="overview" range={range} />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {statCard("Completed", String(totalCompleted), `${totalFailed} failed/other`)}
        {statCard("Total Tokens", fmtTokens(totalInputTokens + totalOutputTokens), `${fmtTokens(totalInputTokens)} in · ${fmtTokens(totalOutputTokens)} out`)}
        {statCard("Est. Cost", totalCost > 0 ? `$${totalCost.toFixed(4)}` : "—", totalCost > 0 ? "API tasks only" : "CLI tasks have no billing")}
        {statCard("Avg Duration", avgDurationMs !== null ? formatDuration(avgDurationMs) : "—", "per finished task")}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Token Spend by Source ({chartRangeLabel})</CardTitle>
          <p className="text-xs text-muted-foreground">
            Task runs vs. requests through the OpenAI / Anthropic-compatible endpoint (<code>/api/llm/v1</code>).
            {(spend.gatewayCacheReadTokens > 0 || spend.gatewayCacheCreationTokens > 0) && (
              <> Gateway cache tokens ({fmtTokens(spend.gatewayCacheReadTokens)} read · {fmtTokens(spend.gatewayCacheCreationTokens)} written) are not included in the split.</>
            )}
          </p>
        </CardHeader>
        <CardContent className="pt-0 flex flex-col gap-5">
          <SourceSplitBar sources={spend.sources} />
          <DailySpendBySourceChart data={spend.daily} />
          <div className="-mx-6">
            <div className="px-6 pb-1 flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Gateway usage by API key</p>
              <Link href={`/analytics/gateway?range=${range}`} className="text-xs text-primary hover:underline">
                API Proxy details →
              </Link>
            </div>
            <ApiKeySpendTable data={spend.byApiKey} />
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Daily Token Usage ({chartRangeLabel})</CardTitle></CardHeader>
          <CardContent className="pt-0">
            <DailyTokensChart data={dailyData} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Daily Estimated Cost ({chartRangeLabel})</CardTitle></CardHeader>
          <CardContent className="pt-0">
            <DailyCostChart data={dailyData} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Tokens by Provider</CardTitle></CardHeader>
        <CardContent className="pt-0">
          <ProviderBreakdownChart data={providerData} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Success Rate by Provider</CardTitle></CardHeader>
        <CardContent className="pt-0 px-0">
          <ProviderSuccessTable data={providerSuccessData} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Tasks by Label</CardTitle></CardHeader>
        <CardContent className="pt-0 px-0">
          <LabelBreakdownTable data={labelData} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Recent Tasks</CardTitle></CardHeader>
        <CardContent className="pt-0 px-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-6 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">Task</th>
                  <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">Status</th>
                  <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">Duration</th>
                  <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">Input</th>
                  <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">Output</th>
                  <th className="text-right px-6 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">Cost</th>
                </tr>
              </thead>
              <tbody>
                {recentTasks.map((t) => {
                  const dur = taskDurations.get(t.id);
                  return (
                  <tr key={t.id} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
                    <td className="px-6 py-2.5">
                      <Link href={`/tasks/${t.id}`} className="hover:underline font-medium text-foreground line-clamp-1">{t.title}</Link>
                      <p className="text-xs text-muted-foreground">{t.aiProvider?.name ?? "—"} · {new Date(t.createdAt).toLocaleDateString()}</p>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <span className={`text-xs px-2 py-0.5 rounded-full capitalize ${t.status === "completed" ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400"}`}>{t.status}</span>
                    </td>
                    <td className="px-4 py-2.5 text-right text-muted-foreground tabular-nums">{dur !== undefined ? formatDuration(dur) : "—"}</td>
                    <td className="px-4 py-2.5 text-right text-muted-foreground tabular-nums">{t.inputTokens != null ? fmtTokens(t.inputTokens) : "—"}</td>
                    <td className="px-4 py-2.5 text-right text-muted-foreground tabular-nums">{t.outputTokens != null ? fmtTokens(t.outputTokens) : "—"}</td>
                    <td className="px-6 py-2.5 text-right tabular-nums">{t.estimatedCost != null && t.estimatedCost > 0 ? `$${t.estimatedCost.toFixed(5)}` : "—"}</td>
                  </tr>
                  );
                })}
                {recentTasks.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-6 py-8 text-center text-sm text-muted-foreground">No finished tasks yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {recentTotal > 0 && (
            <div className="flex items-center justify-between px-6 pt-3">
              <p className="text-xs text-muted-foreground">
                {(recentPage - 1) * RECENT_PAGE_SIZE + 1}–{Math.min(recentPage * RECENT_PAGE_SIZE, recentTotal)} of {recentTotal}
              </p>
              <div className="flex items-center gap-1">
                {recentPage > 1 ? (
                  <Link
                    href={`/analytics?range=${range}&page=${recentPage - 1}`}
                    className="px-3 py-1 text-sm rounded-md font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  >
                    ← Prev
                  </Link>
                ) : (
                  <span className="px-3 py-1 text-sm rounded-md font-medium text-muted-foreground/40 cursor-not-allowed">← Prev</span>
                )}
                <span className="px-2 text-xs text-muted-foreground tabular-nums">Page {recentPage} of {recentTotalPages}</span>
                {recentPage < recentTotalPages ? (
                  <Link
                    href={`/analytics?range=${range}&page=${recentPage + 1}`}
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
