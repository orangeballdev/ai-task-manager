/**
 * "Token spend by source" for /analytics: tokens and estimated cost spent by task runs
 * (the `Task` row totals the worker writes) versus requests through the OpenAI /
 * Anthropic-compatible LLM gateway (`LlmGatewayUsage` rows). Pure — the page does the
 * queries and hands the rows in — so it's unit-tested in __tests__/token-spend.test.ts.
 *
 * Tokens are input + output on both sides; gateway cache reads/writes are reported
 * separately because task totals don't carry them, so mixing them in would skew the split.
 */

export type SpendSource = "tasks" | "gateway";

export interface TaskSpendRow {
  createdAt: Date;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCost: number | null;
}

export interface GatewaySpendRow {
  createdAt: Date;
  apiKeyId: string;
  apiKeyName: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCost: number | null;
  errorType: string | null;
}

export interface SourceTotals {
  source: SpendSource;
  label: string;
  /** Tasks run / gateway requests made. */
  count: number;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  cost: number;
  /** Share of all tokens in range, 0–1 (0 when nothing was spent). */
  share: number;
}

export interface DailySpendRow {
  /** Sortable YYYY-MM-DD (local time). */
  day: string;
  /** MM/DD, matching the page's other daily charts. */
  date: string;
  tasks: number;
  gateway: number;
  tasksCost: number;
  gatewayCost: number;
}

export interface ApiKeySpendRow {
  apiKeyId: string;
  name: string;
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  tokens: number;
  cost: number;
}

export interface TokenSpendBreakdown {
  sources: [SourceTotals, SourceTotals];
  totalTokens: number;
  totalCost: number;
  gatewayCacheReadTokens: number;
  gatewayCacheCreationTokens: number;
  daily: DailySpendRow[];
  byApiKey: ApiKeySpendRow[];
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function dayKey(d: Date): { day: string; date: string } {
  const date = `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  return { day: `${d.getFullYear()}-${date.replace("/", "-")}`, date };
}

export function buildTokenSpendBreakdown(tasks: TaskSpendRow[], gateway: GatewaySpendRow[]): TokenSpendBreakdown {
  const tasksTotals: SourceTotals = { source: "tasks", label: "Task runs", count: 0, inputTokens: 0, outputTokens: 0, tokens: 0, cost: 0, share: 0 };
  const gatewayTotals: SourceTotals = { source: "gateway", label: "LLM gateway", count: 0, inputTokens: 0, outputTokens: 0, tokens: 0, cost: 0, share: 0 };
  const daily = new Map<string, DailySpendRow>();
  const keys = new Map<string, ApiKeySpendRow>();
  let cacheRead = 0;
  let cacheCreation = 0;

  const dayRow = (d: Date): DailySpendRow => {
    const { day, date } = dayKey(new Date(d));
    let row = daily.get(day);
    if (!row) {
      row = { day, date, tasks: 0, gateway: 0, tasksCost: 0, gatewayCost: 0 };
      daily.set(day, row);
    }
    return row;
  };

  for (const t of tasks) {
    const input = t.inputTokens ?? 0;
    const output = t.outputTokens ?? 0;
    const cost = t.estimatedCost ?? 0;
    tasksTotals.count += 1;
    tasksTotals.inputTokens += input;
    tasksTotals.outputTokens += output;
    tasksTotals.cost += cost;
    const row = dayRow(t.createdAt);
    row.tasks += input + output;
    row.tasksCost += cost;
  }

  for (const g of gateway) {
    const cost = g.estimatedCost ?? 0;
    const tokens = g.inputTokens + g.outputTokens;
    gatewayTotals.count += 1;
    gatewayTotals.inputTokens += g.inputTokens;
    gatewayTotals.outputTokens += g.outputTokens;
    gatewayTotals.cost += cost;
    cacheRead += g.cacheReadTokens;
    cacheCreation += g.cacheCreationTokens;
    const row = dayRow(g.createdAt);
    row.gateway += tokens;
    row.gatewayCost += cost;

    let k = keys.get(g.apiKeyId);
    if (!k) {
      k = { apiKeyId: g.apiKeyId, name: g.apiKeyName, requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, tokens: 0, cost: 0 };
      keys.set(g.apiKeyId, k);
    }
    k.name = g.apiKeyName; // newest snapshot wins when rows arrive oldest-first
    k.requests += 1;
    if (g.errorType) k.errors += 1;
    k.inputTokens += g.inputTokens;
    k.outputTokens += g.outputTokens;
    k.cacheReadTokens += g.cacheReadTokens;
    k.cacheCreationTokens += g.cacheCreationTokens;
    k.tokens += tokens;
    k.cost += cost;
  }

  tasksTotals.tokens = tasksTotals.inputTokens + tasksTotals.outputTokens;
  gatewayTotals.tokens = gatewayTotals.inputTokens + gatewayTotals.outputTokens;
  const totalTokens = tasksTotals.tokens + gatewayTotals.tokens;
  if (totalTokens > 0) {
    tasksTotals.share = tasksTotals.tokens / totalTokens;
    gatewayTotals.share = gatewayTotals.tokens / totalTokens;
  }

  return {
    sources: [tasksTotals, gatewayTotals],
    totalTokens,
    totalCost: tasksTotals.cost + gatewayTotals.cost,
    gatewayCacheReadTokens: cacheRead,
    gatewayCacheCreationTokens: cacheCreation,
    daily: Array.from(daily.values()).sort((a, b) => a.day.localeCompare(b.day)),
    byApiKey: Array.from(keys.values()).sort((a, b) => b.tokens - a.tokens || b.requests - a.requests),
  };
}
