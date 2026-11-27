"use client";

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { GatewayBucket } from "@/lib/gateway-analytics";

const COLORS = { input: "#a78bfa", output: "#E8865A", cost: "#60a5fa" };

function fmt(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtCost(n: number) {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(5)}`;
  if (n < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

const tooltipStyle = { background: "#1a1a1a", border: "1px solid #333", borderRadius: 8, fontSize: 12 };

/** Stacked input/output tokens per bucket; the tooltip adds requests, errors and cost. */
export function GatewayTokensChart({ data, emptyText }: { data: GatewayBucket[]; emptyText: string }) {
  if (!data.some((d) => d.requests > 0)) {
    return <p className="text-sm text-muted-foreground py-8 text-center">{emptyText}</p>;
  }
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
        <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#888" }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
        <YAxis tickFormatter={fmt} tick={{ fontSize: 11, fill: "#888" }} tickLine={false} axisLine={false} width={40} />
        <Tooltip
          contentStyle={tooltipStyle}
          content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null;
            const b = payload[0].payload as GatewayBucket;
            return (
              <div style={tooltipStyle} className="px-3 py-2 flex flex-col gap-0.5">
                <span className="font-medium">{label}</span>
                <span>{b.requests} request{b.requests === 1 ? "" : "s"}{b.errors > 0 ? ` · ${b.errors} failed` : ""}</span>
                <span style={{ color: COLORS.input }}>{fmt(b.inputTokens)} input tokens</span>
                <span style={{ color: COLORS.output }}>{fmt(b.outputTokens)} output tokens</span>
                <span style={{ color: COLORS.cost }}>{fmtCost(b.cost)} est. cost</span>
              </div>
            );
          }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="inputTokens" name="Input" stackId="t" fill={COLORS.input} />
        <Bar dataKey="outputTokens" name="Output" stackId="t" fill={COLORS.output} radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function GatewayCostChart({ data, emptyText }: { data: GatewayBucket[]; emptyText: string }) {
  if (!data.some((d) => d.cost > 0)) {
    return <p className="text-sm text-muted-foreground py-8 text-center">{emptyText}</p>;
  }
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
        <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#888" }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
        <YAxis tickFormatter={(v) => `$${Number(v).toFixed(3)}`} tick={{ fontSize: 11, fill: "#888" }} tickLine={false} axisLine={false} width={52} />
        <Tooltip contentStyle={tooltipStyle} formatter={(v) => [fmtCost(Number(v ?? 0)), "Est. cost"]} />
        <Bar dataKey="cost" fill={COLORS.cost} radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
