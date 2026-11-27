"use client";

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from "recharts";
import type { ApiKeySpendRow, DailySpendRow, SourceTotals } from "@/lib/token-spend";

interface DailyRow {
  date: string;
  tokens: number;
  cost: number;
  tasks: number;
}

interface ProviderRow {
  name: string;
  tokens: number;
  cost: number;
  tasks: number;
}

function fmt(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

const CHART_COLORS = { tokens: "#E8865A", cost: "#60a5fa" };

export function DailyTokensChart({ data }: { data: DailyRow[] }) {
  if (!data.length) return <p className="text-sm text-muted-foreground py-8 text-center">No data yet.</p>;
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
        <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#888" }} tickLine={false} axisLine={false} />
        <YAxis tickFormatter={fmt} tick={{ fontSize: 11, fill: "#888" }} tickLine={false} axisLine={false} width={40} />
        <Tooltip
          contentStyle={{ background: "#1a1a1a", border: "1px solid #333", borderRadius: 8, fontSize: 12 }}
          formatter={(v) => [fmt(Number(v ?? 0)), "Tokens"]}
        />
        <Bar dataKey="tokens" fill={CHART_COLORS.tokens} radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function DailyCostChart({ data }: { data: DailyRow[] }) {
  const hasCost = data.some((d) => d.cost > 0);
  if (!hasCost) return <p className="text-sm text-muted-foreground py-8 text-center">No cost data (CLI provider tasks have no cost tracking).</p>;
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
        <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#888" }} tickLine={false} axisLine={false} />
        <YAxis tickFormatter={(v) => `$${v.toFixed(3)}`} tick={{ fontSize: 11, fill: "#888" }} tickLine={false} axisLine={false} width={52} />
        <Tooltip
          contentStyle={{ background: "#1a1a1a", border: "1px solid #333", borderRadius: 8, fontSize: 12 }}
          formatter={(v) => [`$${Number(v ?? 0).toFixed(5)}`, "Est. cost"]}
        />
        <Bar dataKey="cost" fill={CHART_COLORS.cost} radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function ProviderBreakdownChart({ data }: { data: ProviderRow[] }) {
  if (!data.length) return <p className="text-sm text-muted-foreground py-8 text-center">No data yet.</p>;
  return (
    <ResponsiveContainer width="100%" height={Math.max(100, data.length * 48)}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" horizontal={false} />
        <XAxis type="number" tickFormatter={fmt} tick={{ fontSize: 11, fill: "#888" }} tickLine={false} axisLine={false} />
        <YAxis type="category" dataKey="name" tick={{ fontSize: 12, fill: "#ccc" }} tickLine={false} axisLine={false} width={90} />
        <Tooltip
          contentStyle={{ background: "#1a1a1a", border: "1px solid #333", borderRadius: 8, fontSize: 12 }}
          formatter={(v) => [fmt(Number(v ?? 0)), "Tokens"]}
        />
        <Bar dataKey="tokens" fill={CHART_COLORS.tokens} radius={[0, 3, 3, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export interface LabelBreakdownRow {
  label: string;
  total: number;
  completed: number;
  failed: number;
  cost: number;
}

export function LabelBreakdownTable({ data }: { data: LabelBreakdownRow[] }) {
  if (!data.length) return <p className="text-sm text-muted-foreground py-8 text-center">No labelled tasks in the selected range.</p>;
  const hasCost = data.some((r) => r.cost > 0);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">Label</th>
            <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">Tasks</th>
            <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">Completed</th>
            <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">Failed / Other</th>
            {hasCost && <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">Est. Cost</th>}
            <th className="px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide w-32">Success Rate</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => {
            const rate = row.total > 0 ? row.completed / row.total : 0;
            const pct = (rate * 100).toFixed(0);
            const barColor = rate >= 0.8 ? "bg-green-500" : rate >= 0.5 ? "bg-yellow-500" : "bg-red-500";
            return (
              <tr key={row.label} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
                <td className="px-4 py-2.5 font-medium text-foreground">
                  <span className="inline-flex items-center gap-1.5 text-sm bg-primary/10 text-primary/80 px-2.5 py-0.5 rounded-full border border-primary/20">
                    {row.label}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{row.total}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-green-400">{row.completed}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-red-400">{row.failed}</td>
                {hasCost && (
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                    {row.cost > 0 ? `$${row.cost.toFixed(4)}` : "—"}
                  </td>
                )}
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs tabular-nums text-muted-foreground w-8 text-right shrink-0">{pct}%</span>
                    <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface ProviderSuccessRow {
  name: string;
  completed: number;
  failed: number;
  total: number;
}

export function ProviderSuccessTable({ data }: { data: ProviderSuccessRow[] }) {
  if (!data.length) return <p className="text-sm text-muted-foreground py-8 text-center">No data yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">Provider</th>
            <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">Tasks Run</th>
            <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">Completed</th>
            <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">Failed / Other</th>
            <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">Success Rate</th>
            <th className="px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide w-32">Rate</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => {
            const rate = row.total > 0 ? row.completed / row.total : 0;
            const pct = (rate * 100).toFixed(0);
            const barColor = rate >= 0.8 ? "bg-green-500" : rate >= 0.5 ? "bg-yellow-500" : "bg-red-500";
            return (
              <tr key={row.name} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
                <td className="px-4 py-2.5 font-medium text-foreground">{row.name}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{row.total}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-green-400">{row.completed}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-red-400">{row.failed}</td>
                <td className="px-4 py-2.5 text-right tabular-nums font-medium">{pct}%</td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-1.5">
                    <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Token spend by source (task runs vs LLM gateway) ─────────────────────────

export const SOURCE_COLORS = { tasks: "#E8865A", gateway: "#a78bfa" } as const;

function fmtCost(n: number) {
  if (n <= 0) return "—";
  if (n < 0.01) return `$${n.toFixed(5)}`;
  if (n < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/** One horizontal bar split by each source's share of tokens, with a legend underneath. */
export function SourceSplitBar({ sources }: { sources: SourceTotals[] }) {
  const total = sources.reduce((s, r) => s + r.tokens, 0);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-3 w-full rounded-full overflow-hidden bg-muted" role="img" aria-label="Token share by source">
        {total > 0 && sources.map((s) => (
          s.tokens > 0 && (
            <div
              key={s.source}
              style={{ width: `${(s.share * 100).toFixed(2)}%`, background: SOURCE_COLORS[s.source] }}
              title={`${s.label}: ${(s.share * 100).toFixed(1)}%`}
            />
          )
        ))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {sources.map((s) => (
          <div key={s.source} className="rounded-lg border border-border p-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground uppercase tracking-wide">
              <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: SOURCE_COLORS[s.source] }} />
              {s.label}
              <span className="ml-auto tabular-nums normal-case">{total > 0 ? `${(s.share * 100).toFixed(1)}%` : "—"}</span>
            </div>
            <p className="text-xl font-bold mt-1 tabular-nums">{fmt(s.tokens)} <span className="text-sm font-normal text-muted-foreground">tokens</span></p>
            <p className="text-xs text-muted-foreground mt-0.5 tabular-nums">
              {fmt(s.inputTokens)} in · {fmt(s.outputTokens)} out · {s.count} {s.source === "tasks" ? (s.count === 1 ? "task" : "tasks") : (s.count === 1 ? "request" : "requests")} · {fmtCost(s.cost)}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DailySpendBySourceChart({ data }: { data: DailySpendRow[] }) {
  if (!data.some((d) => d.tasks > 0 || d.gateway > 0)) {
    return <p className="text-sm text-muted-foreground py-8 text-center">No token usage in the selected range.</p>;
  }
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
        <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#888" }} tickLine={false} axisLine={false} />
        <YAxis tickFormatter={fmt} tick={{ fontSize: 11, fill: "#888" }} tickLine={false} axisLine={false} width={40} />
        <Tooltip
          contentStyle={{ background: "#1a1a1a", border: "1px solid #333", borderRadius: 8, fontSize: 12 }}
          formatter={(v, name) => [fmt(Number(v ?? 0)), name]}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="tasks" name="Task runs" stackId="src" fill={SOURCE_COLORS.tasks} />
        <Bar dataKey="gateway" name="LLM gateway" stackId="src" fill={SOURCE_COLORS.gateway} radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function ApiKeySpendTable({ data }: { data: ApiKeySpendRow[] }) {
  if (!data.length) {
    return <p className="text-sm text-muted-foreground py-6 text-center">No LLM gateway requests in the selected range.</p>;
  }
  const hasCache = data.some((r) => r.cacheReadTokens > 0 || r.cacheCreationTokens > 0);
  const th = "text-right px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide";
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">API Key</th>
            <th className={th}>Requests</th>
            <th className={th}>Errors</th>
            <th className={th}>Input</th>
            <th className={th}>Output</th>
            {hasCache && <th className={th}>Cache read / write</th>}
            <th className={th}>Est. Cost</th>
          </tr>
        </thead>
        <tbody>
          {data.map((r) => (
            <tr key={r.apiKeyId} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
              <td className="px-4 py-2.5 font-medium text-foreground">{r.name}</td>
              <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{r.requests}</td>
              <td className={`px-4 py-2.5 text-right tabular-nums ${r.errors > 0 ? "text-red-400" : "text-muted-foreground"}`}>{r.errors}</td>
              <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{fmt(r.inputTokens)}</td>
              <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{fmt(r.outputTokens)}</td>
              {hasCache && (
                <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{fmt(r.cacheReadTokens)} / {fmt(r.cacheCreationTokens)}</td>
              )}
              <td className="px-4 py-2.5 text-right tabular-nums">{fmtCost(r.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
