/**
 * The "API Proxy" analytics tab (/analytics/gateway): when the OpenAI / Anthropic-compatible
 * LLM gateway (`/api/llm/v1`) spends tokens, how many, and what they would cost. Pure — the
 * page queries `LlmGatewayUsage` and hands the rows in — so it's unit-tested in
 * __tests__/gateway-analytics.test.ts.
 *
 * Two cost figures are kept apart on purpose:
 * - **billed** is the row's stored `estimatedCost`: what a metered provider (Claude API key,
 *   OpenAI) charged, priced when the request was recorded.
 * - **estimated** is billed plus, for subscription CLIs (`cli`, `codex-cli`, which store no
 *   cost), the same tokens priced at API rates — "what this would have cost on an API key",
 *   the same estimate the task page shows for subscription runs. A subscription request with
 *   a model we have no price for adds nothing and is counted in `unpricedRequests`.
 *
 * Buckets use the server's local time, like the rest of /analytics.
 */
import { estimateCostForCli } from "@/lib/token-cost";

export interface GatewayUsageRow {
  createdAt: Date;
  apiKeyId: string;
  apiKeyName: string;
  format: string;
  providerName: string | null;
  providerType: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCost: number | null;
  errorType: string | null;
  durationMs: number;
}

export interface RowCost {
  /** Stored cost from a metered provider, 0 when none. */
  billed: number;
  /** Billed, or the API-price estimate for a subscription request; null when unpriced. */
  estimated: number | null;
  /** True when `estimated` is an API-price estimate of subscription usage. */
  atApiPricing: boolean;
}

export interface GatewayTotals {
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  /** input + output (cache tokens are reported separately). */
  tokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  billedCost: number;
  estimatedCost: number;
  /** The part of `estimatedCost` that is subscription usage priced at API rates. */
  subscriptionEquivalentCost: number;
  /** Requests that used tokens but have no known price. */
  unpricedRequests: number;
  avgDurationMs: number | null;
  firstAt: Date | null;
  lastAt: Date | null;
}

export interface GatewayBucket {
  /** Sortable key: YYYY-MM-DD, YYYY-MM-DDTHH, or the hour "00"–"23". */
  key: string;
  /** Axis label. */
  label: string;
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  cost: number;
}

export interface GatewayModelRow {
  model: string;
  providerName: string;
  providerType: string | null;
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  cost: number;
  atApiPricing: boolean;
}

export interface GatewayKeyRow {
  apiKeyId: string;
  name: string;
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  cost: number;
  lastUsedAt: Date;
}

export interface GatewayAnalytics {
  totals: GatewayTotals;
  /** One bucket per day that had requests, oldest first. */
  daily: GatewayBucket[];
  /** Always 24 hourly buckets covering the 24 hours up to `now`, oldest first. */
  last24h: GatewayBucket[];
  /** Always 24 buckets, hour of day 00–23 — which times of day the gateway is busy. */
  byHourOfDay: GatewayBucket[];
  byModel: GatewayModelRow[];
  byApiKey: GatewayKeyRow[];
}

const SUBSCRIPTION_TYPES = new Set(["cli", "codex-cli"]);

const pad = (n: number) => n.toString().padStart(2, "0");

export function gatewayRowCost(row: Pick<GatewayUsageRow, "estimatedCost" | "providerType" | "model" | "inputTokens" | "outputTokens">): RowCost {
  if (row.estimatedCost != null) {
    return { billed: row.estimatedCost, estimated: row.estimatedCost, atApiPricing: false };
  }
  if (row.providerType && SUBSCRIPTION_TYPES.has(row.providerType)) {
    const estimate = estimateCostForCli(row.model, row.inputTokens, row.outputTokens);
    if (estimate != null) return { billed: 0, estimated: estimate, atApiPricing: true };
  }
  return { billed: 0, estimated: null, atApiPricing: false };
}

function emptyBucket(key: string, label: string): GatewayBucket {
  return { key, label, requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, tokens: 0, cost: 0 };
}

function addTo(b: GatewayBucket, r: GatewayUsageRow, cost: number) {
  b.requests += 1;
  if (r.errorType) b.errors += 1;
  b.inputTokens += r.inputTokens;
  b.outputTokens += r.outputTokens;
  b.tokens += r.inputTokens + r.outputTokens;
  b.cost += cost;
}

function hourStart(d: Date): Date {
  const h = new Date(d);
  h.setMinutes(0, 0, 0);
  return h;
}

export function buildGatewayAnalytics(rows: GatewayUsageRow[], now: Date = new Date()): GatewayAnalytics {
  const totals: GatewayTotals = {
    requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, tokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    billedCost: 0, estimatedCost: 0, subscriptionEquivalentCost: 0, unpricedRequests: 0,
    avgDurationMs: null, firstAt: null, lastAt: null,
  };
  let durationSum = 0;

  const daily = new Map<string, GatewayBucket>();
  const byHourOfDay = Array.from({ length: 24 }, (_, h) => emptyBucket(pad(h), `${pad(h)}:00`));

  // Last 24h: hourly buckets ending with the current (partial) hour.
  const currentHour = hourStart(now).getTime();
  const firstHour = currentHour - 23 * 3_600_000;
  const last24h = Array.from({ length: 24 }, (_, i) => {
    const d = new Date(firstHour + i * 3_600_000);
    return emptyBucket(
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}`,
      `${pad(d.getHours())}:00`,
    );
  });

  const models = new Map<string, GatewayModelRow>();
  const keys = new Map<string, GatewayKeyRow>();

  for (const r of rows) {
    const created = new Date(r.createdAt);
    const c = gatewayRowCost(r);
    const cost = c.estimated ?? 0;

    totals.requests += 1;
    if (r.errorType) totals.errors += 1;
    totals.inputTokens += r.inputTokens;
    totals.outputTokens += r.outputTokens;
    totals.cacheReadTokens += r.cacheReadTokens;
    totals.cacheCreationTokens += r.cacheCreationTokens;
    totals.billedCost += c.billed;
    totals.estimatedCost += cost;
    if (c.atApiPricing) totals.subscriptionEquivalentCost += cost;
    if (c.estimated == null && r.inputTokens + r.outputTokens > 0) totals.unpricedRequests += 1;
    durationSum += r.durationMs;
    if (!totals.firstAt || created < totals.firstAt) totals.firstAt = created;
    if (!totals.lastAt || created > totals.lastAt) totals.lastAt = created;

    const dayKey = `${created.getFullYear()}-${pad(created.getMonth() + 1)}-${pad(created.getDate())}`;
    let day = daily.get(dayKey);
    if (!day) {
      day = emptyBucket(dayKey, `${pad(created.getMonth() + 1)}/${pad(created.getDate())}`);
      daily.set(dayKey, day);
    }
    addTo(day, r, cost);
    addTo(byHourOfDay[created.getHours()], r, cost);

    const t = created.getTime();
    if (t >= firstHour && t < currentHour + 3_600_000) {
      addTo(last24h[Math.floor((hourStart(created).getTime() - firstHour) / 3_600_000)], r, cost);
    }

    const model = r.model ?? "unknown";
    const providerName = r.providerName ?? "Unknown provider";
    const modelKey = `${model}\u0000${providerName}`;
    let m = models.get(modelKey);
    if (!m) {
      m = { model, providerName, providerType: r.providerType, requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, tokens: 0, cost: 0, atApiPricing: false };
      models.set(modelKey, m);
    }
    m.requests += 1;
    if (r.errorType) m.errors += 1;
    m.inputTokens += r.inputTokens;
    m.outputTokens += r.outputTokens;
    m.tokens += r.inputTokens + r.outputTokens;
    m.cost += cost;
    if (c.atApiPricing) m.atApiPricing = true;

    let k = keys.get(r.apiKeyId);
    if (!k) {
      k = { apiKeyId: r.apiKeyId, name: r.apiKeyName, requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, tokens: 0, cost: 0, lastUsedAt: created };
      keys.set(r.apiKeyId, k);
    }
    if (created >= k.lastUsedAt) {
      k.lastUsedAt = created;
      k.name = r.apiKeyName; // newest snapshot of the key's name wins
    }
    k.requests += 1;
    if (r.errorType) k.errors += 1;
    k.inputTokens += r.inputTokens;
    k.outputTokens += r.outputTokens;
    k.tokens += r.inputTokens + r.outputTokens;
    k.cost += cost;
  }

  totals.tokens = totals.inputTokens + totals.outputTokens;
  totals.avgDurationMs = totals.requests > 0 ? durationSum / totals.requests : null;

  return {
    totals,
    daily: Array.from(daily.values()).sort((a, b) => a.key.localeCompare(b.key)),
    last24h,
    byHourOfDay,
    byModel: Array.from(models.values()).sort((a, b) => b.tokens - a.tokens || b.requests - a.requests),
    byApiKey: Array.from(keys.values()).sort((a, b) => b.tokens - a.tokens || b.requests - a.requests),
  };
}
