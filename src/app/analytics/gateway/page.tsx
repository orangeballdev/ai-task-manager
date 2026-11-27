import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { GatewayPauseControl } from "@/components/GatewayPauseControl";
import { prisma } from "@/lib/db";
import { buildGatewayAnalytics, gatewayRowCost, type GatewayUsageRow } from "@/lib/gateway-analytics";
import { AnalyticsTabs } from "../AnalyticsTabs";
import { GatewayCostChart, GatewayTokensChart } from "./GatewayCharts";

// "API Proxy" analytics tab: when the OpenAI / Anthropic-compatible LLM gateway (/api/llm/v1)
// spends tokens, how many, and the estimated cost — plus the switch to disable it for a while.
// Aggregation is the pure buildGatewayAnalytics() (src/lib/gateway-analytics.ts).
export const dynamic = "force-dynamic";

type RangeKey = "24h" | "7d" | "30d" | "90d" | "all";

const RANGE_OPTIONS: { key: RangeKey; label: string; ms: number | null }[] = [
  { key: "24h", label: "24h", ms: 24 * 3_600_000 },
  { key: "7d", label: "7d", ms: 7 * 86_400_000 },
  { key: "30d", label: "30d", ms: 30 * 86_400_000 },
  { key: "90d", label: "90d", ms: 90 * 86_400_000 },
  { key: "all", label: "All", ms: null },
];

const PAGE_SIZE = 20;

const USAGE_SELECT = {
  createdAt: true, apiKeyId: true, apiKeyName: true, format: true, providerName: true, providerType: true,
  model: true, inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheCreationTokens: true,
  estimatedCost: true, errorType: true, durationMs: true,
} as const;

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtCost(n: number) {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(5)}`;
  if (n < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtDuration(ms: number) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function fmtAgo(d: Date, now: Date) {
  const s = Math.max(0, Math.round((now.getTime() - d.getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function statCard(label: string, value: string, sub?: string) {
  return (
    <Card key={label}>
      <CardContent className="pt-5 pb-4">
        <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">{label}</p>
        <p className="text-2xl font-bold tabular-nums">{value}</p>
        {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  );
}

const th = "text-right px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide";
const thLeft = "text-left px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide";
const td = "px-4 py-2.5 text-right tabular-nums text-muted-foreground";

export default async function GatewayAnalyticsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const params = await searchParams;
  const range: RangeKey = RANGE_OPTIONS.some((r) => r.key === params.range) ? (params.range as RangeKey) : "7d";
  const now = new Date();
  const rangeMs = RANGE_OPTIONS.find((r) => r.key === range)!.ms;
  const cutoff = rangeMs != null ? new Date(now.getTime() - rangeMs) : null;
  const where = cutoff ? { createdAt: { gte: cutoff } } : {};

  const rows = (await prisma.llmGatewayUsage.findMany({
    where,
    select: USAGE_SELECT,
    orderBy: { createdAt: "asc" },
  })) as GatewayUsageRow[];
  // The 24-hour timeline always shows the last day, whatever range is picked.
  const last24Rows = range === "24h"
    ? rows
    : ((await prisma.llmGatewayUsage.findMany({
        where: { createdAt: { gte: new Date(now.getTime() - 24 * 3_600_000) } },
        select: USAGE_SELECT,
      })) as GatewayUsageRow[]);

  const a = buildGatewayAnalytics(rows, now);
  const last24h = buildGatewayAnalytics(last24Rows, now).last24h;
  const t = a.totals;

  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const parsedPage = parseInt(params.page ?? "1", 10);
  const page = Math.min(Math.max(1, Number.isNaN(parsedPage) ? 1 : parsedPage), totalPages);
  const recent = (await prisma.llmGatewayUsage.findMany({
    where,
    select: { id: true, ...USAGE_SELECT },
    orderBy: { createdAt: "desc" },
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
  })) as (GatewayUsageRow & { id: string })[];

  const rangeLabel = range === "all" ? "all time" : `last ${range}`;
  const hasCache = t.cacheReadTokens > 0 || t.cacheCreationTokens > 0;
  const pageHref = (p: number) => `/analytics/gateway?range=${range}&page=${p}`;

  return (
    <div className="max-w-7xl mx-auto flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <Link href="/tasks" className="text-sm text-muted-foreground hover:text-foreground block mb-2">← Tasks</Link>
          <h1 className="text-2xl font-bold">Analytics</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Token usage and estimated cost of the API proxy — the OpenAI / Anthropic-compatible endpoint at <code>/api/llm/v1</code>.
          </p>
        </div>
        <div className="flex items-center gap-1 bg-muted rounded-lg p-1 shrink-0 mt-6">
          {RANGE_OPTIONS.map((opt) => (
            <Link
              key={opt.key}
              href={`/analytics/gateway?range=${opt.key}`}
              className={`px-3 py-1 text-sm rounded-md transition-colors font-medium ${
                range === opt.key ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {opt.label}
            </Link>
          ))}
        </div>
      </div>

      <AnalyticsTabs active="gateway" range={range === "24h" ? undefined : range} />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">API Proxy Status</CardTitle>
          <p className="text-xs text-muted-foreground">
            Disable the proxy temporarily to stop it spending tokens. While disabled, every request with a valid API key
            gets a <code>503</code> (with <code>Retry-After</code> for timed pauses); it re-enables itself when the time runs out.
          </p>
        </CardHeader>
        <CardContent className="pt-0">
          <GatewayPauseControl />
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {statCard("Requests", String(t.requests), t.errors > 0 ? `${t.errors} failed · ${rangeLabel}` : rangeLabel)}
        {statCard(
          "Tokens",
          fmtTokens(t.tokens),
          `${fmtTokens(t.inputTokens)} in · ${fmtTokens(t.outputTokens)} out${hasCache ? ` · ${fmtTokens(t.cacheReadTokens)} cache read` : ""}`,
        )}
        {statCard(
          "Est. Cost",
          t.estimatedCost > 0 ? fmtCost(t.estimatedCost) : "—",
          t.estimatedCost > 0
            ? `${fmtCost(t.billedCost)} billed · ${fmtCost(t.subscriptionEquivalentCost)} subscription at API prices`
            : t.unpricedRequests > 0 ? `${t.unpricedRequests} request(s) with no known price` : "No priced usage",
        )}
        {statCard(
          "Last Request",
          t.lastAt ? fmtAgo(t.lastAt, now) : "—",
          t.avgDurationMs != null ? `avg ${fmtDuration(t.avgDurationMs)} per request` : "No requests in range",
        )}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Last 24 Hours (hourly)</CardTitle>
          <p className="text-xs text-muted-foreground">When the proxy spent tokens over the past day. Hover a bar for requests and cost.</p>
        </CardHeader>
        <CardContent className="pt-0">
          <GatewayTokensChart data={last24h} emptyText="No API proxy requests in the last 24 hours." />
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Daily Tokens ({rangeLabel})</CardTitle></CardHeader>
          <CardContent className="pt-0">
            <GatewayTokensChart data={a.daily} emptyText="No API proxy requests in the selected range." />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Daily Estimated Cost ({rangeLabel})</CardTitle></CardHeader>
          <CardContent className="pt-0">
            <GatewayCostChart data={a.daily} emptyText="No priced API proxy usage in the selected range." />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Busiest Hours of the Day ({rangeLabel})</CardTitle>
          <p className="text-xs text-muted-foreground">Tokens by hour of day (server time), summed over the range.</p>
        </CardHeader>
        <CardContent className="pt-0">
          <GatewayTokensChart data={a.byHourOfDay} emptyText="No API proxy requests in the selected range." />
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">By Model</CardTitle></CardHeader>
          <CardContent className="pt-0 px-0">
            {a.byModel.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">No requests in the selected range.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className={thLeft}>Model</th>
                      <th className={th}>Requests</th>
                      <th className={th}>Tokens</th>
                      <th className={th}>Est. Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.byModel.map((m) => (
                      <tr key={`${m.model}-${m.providerName}`} className="border-b border-border/50 hover:bg-muted/30">
                        <td className="px-4 py-2.5">
                          <p className="font-medium text-foreground">{m.model}</p>
                          <p className="text-xs text-muted-foreground">{m.providerName}</p>
                        </td>
                        <td className={td}>{m.requests}{m.errors > 0 && <span className="text-red-400"> ({m.errors} failed)</span>}</td>
                        <td className={td}>{fmtTokens(m.tokens)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">
                          {m.cost > 0 ? fmtCost(m.cost) : "—"}
                          {m.atApiPricing && m.cost > 0 && <span className="block text-[10px] text-muted-foreground">at API prices</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">By API Key</CardTitle></CardHeader>
          <CardContent className="pt-0 px-0">
            {a.byApiKey.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">No requests in the selected range.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className={thLeft}>API Key</th>
                      <th className={th}>Requests</th>
                      <th className={th}>Tokens</th>
                      <th className={th}>Est. Cost</th>
                      <th className={th}>Last Used</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.byApiKey.map((k) => (
                      <tr key={k.apiKeyId} className="border-b border-border/50 hover:bg-muted/30">
                        <td className="px-4 py-2.5 font-medium text-foreground">{k.name}</td>
                        <td className={td}>{k.requests}{k.errors > 0 && <span className="text-red-400"> ({k.errors} failed)</span>}</td>
                        <td className={td}>{fmtTokens(k.tokens)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{k.cost > 0 ? fmtCost(k.cost) : "—"}</td>
                        <td className={td} title={k.lastUsedAt.toLocaleString()}>{fmtAgo(k.lastUsedAt, now)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Requests</CardTitle>
          <p className="text-xs text-muted-foreground">Every API proxy request in the range, newest first.</p>
        </CardHeader>
        <CardContent className="pt-0 px-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className={`${thLeft} pl-6`}>Time</th>
                  <th className={thLeft}>API Key</th>
                  <th className={thLeft}>Model · Provider</th>
                  <th className={th}>Input</th>
                  <th className={th}>Output</th>
                  {hasCache && <th className={th}>Cache R / W</th>}
                  <th className={th}>Duration</th>
                  <th className={`${th} pr-6`}>Est. Cost</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => {
                  const c = gatewayRowCost(r);
                  return (
                    <tr key={r.id} className="border-b border-border/50 hover:bg-muted/30">
                      <td className="px-4 pl-6 py-2.5 whitespace-nowrap text-muted-foreground tabular-nums">
                        {r.createdAt.toLocaleString()}
                      </td>
                      <td className="px-4 py-2.5 text-foreground">
                        {r.apiKeyName}
                        <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">{r.format}</span>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="text-foreground">{r.model ?? "unknown"}</span>
                        <span className="block text-xs text-muted-foreground">
                          {r.providerName ?? "—"}
                          {r.errorType && <span className="ml-1 text-red-400">· failed ({r.errorType})</span>}
                        </span>
                      </td>
                      <td className={td}>{fmtTokens(r.inputTokens)}</td>
                      <td className={td}>{fmtTokens(r.outputTokens)}</td>
                      {hasCache && <td className={td}>{fmtTokens(r.cacheReadTokens)} / {fmtTokens(r.cacheCreationTokens)}</td>}
                      <td className={td}>{fmtDuration(r.durationMs)}</td>
                      <td className="px-4 pr-6 py-2.5 text-right tabular-nums">
                        {c.estimated != null && c.estimated > 0 ? fmtCost(c.estimated) : "—"}
                        {c.atApiPricing && c.estimated != null && c.estimated > 0 && (
                          <span className="block text-[10px] text-muted-foreground">at API prices</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {recent.length === 0 && (
                  <tr>
                    <td colSpan={hasCache ? 8 : 7} className="px-6 py-8 text-center text-sm text-muted-foreground">
                      No API proxy requests in the selected range.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {total > PAGE_SIZE && (
            <div className="flex items-center justify-between px-6 pt-3">
              <p className="text-xs text-muted-foreground">
                {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}
              </p>
              <div className="flex items-center gap-1">
                {page > 1 ? (
                  <Link href={pageHref(page - 1)} className="px-3 py-1 text-sm rounded-md font-medium text-muted-foreground hover:text-foreground hover:bg-muted">← Prev</Link>
                ) : (
                  <span className="px-3 py-1 text-sm rounded-md font-medium text-muted-foreground/40">← Prev</span>
                )}
                <span className="px-2 text-xs text-muted-foreground tabular-nums">Page {page} of {totalPages}</span>
                {page < totalPages ? (
                  <Link href={pageHref(page + 1)} className="px-3 py-1 text-sm rounded-md font-medium text-muted-foreground hover:text-foreground hover:bg-muted">Next →</Link>
                ) : (
                  <span className="px-3 py-1 text-sm rounded-md font-medium text-muted-foreground/40">Next →</span>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
