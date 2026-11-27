"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { LocalDateTime } from "@/components/LocalDateTime";
import { estimateCostForCli, findPricing, formatCost, formatTokens } from "@/lib/token-cost";

interface TokenData {
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCost: number | null;
  status: string;
  provider: string;
  model: string | null;
}

interface LiveTokenUsageProps extends TokenData {
  taskId: string;
  costBudget?: number | null;
  tokenBudget?: number | null;
  /** ISO timestamp from the "Starting task:" log — used to drive the live elapsed-time counter. */
  startedAt?: string | null;
  retryCount?: number;
  /** "Review PR" self-review re-run count — shown as "Revision requested", not "Retry". */
  reviewIterationCount?: number;
  nextRetryAt?: string | null;
}

const subscribeToNothing = () => () => {};
function subscribeToSecondTicks(onTick: () => void) {
  const id = setInterval(onTick, 1000);
  return () => clearInterval(id);
}
const currentSecond = () => Math.floor(Date.now() / 1000);

/** Returns elapsed seconds since startedAt, or null when inactive. */
function useElapsedSeconds(startedAt: string | null | undefined, active: boolean): number | null {
  const origin = active && startedAt ? new Date(startedAt).getTime() : NaN;
  const ticking = !isNaN(origin);
  // A one-second clock, only subscribed while there's something to count.
  // null during SSR/hydration so server and client markup agree.
  const nowSecond = useSyncExternalStore(
    ticking ? subscribeToSecondTicks : subscribeToNothing,
    currentSecond,
    () => null,
  );
  if (!ticking || nowSecond === null) return null;
  return Math.floor(nowSecond - origin / 1000);
}

function formatElapsed(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function LiveTokenUsage({
  taskId,
  inputTokens: initialInput,
  outputTokens: initialOutput,
  estimatedCost: initialCost,
  status: initialStatus,
  provider,
  model,
  costBudget,
  tokenBudget,
  startedAt,
  retryCount,
  reviewIterationCount,
  nextRetryAt,
}: LiveTokenUsageProps) {
  const [inputTokens, setInputTokens] = useState(initialInput);
  const [outputTokens, setOutputTokens] = useState(initialOutput);
  const [estimatedCost, setEstimatedCost] = useState(initialCost);
  const [isRunning, setIsRunning] = useState(initialStatus === "running");
  const elapsedSecs = useElapsedSeconds(startedAt, isRunning);
  const elapsedTime = elapsedSecs !== null ? formatElapsed(elapsedSecs) : null;

  // Tokens/min: only show after ≥ 30 s of data to avoid early noise
  const totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0);
  const tokensPerMin =
    isRunning && elapsedSecs !== null && elapsedSecs >= 30 && totalTokens > 0
      ? Math.round((totalTokens / elapsedSecs) * 60)
      : null;

  // ETA: estimate seconds remaining based on current consumption rate vs remaining budget.
  // Uses token budget if set, otherwise falls back to cost budget if both rate and cost are known.
  const etaSecs: number | null = (() => {
    if (!isRunning || elapsedSecs === null || elapsedSecs < 30) return null;
    const rate = totalTokens / elapsedSecs; // tokens per second
    if (rate <= 0) return null;
    if (tokenBudget != null && tokenBudget > 0 && totalTokens < tokenBudget) {
      return (tokenBudget - totalTokens) / rate;
    }
    const cost = estimatedCost ?? null;
    if (costBudget != null && costBudget > 0 && cost != null && cost > 0 && cost < costBudget) {
      const costRate = cost / elapsedSecs; // cost per second
      return (costBudget - cost) / costRate;
    }
    return null;
  })();

  useEffect(() => {
    if (!isRunning) return;

    const poll = async () => {
      try {
        const res = await fetch(`/api/tasks/${taskId}`);
        if (!res.ok) return;
        const data = await res.json() as TokenData & { id: string };
        if (data.inputTokens != null) setInputTokens(data.inputTokens);
        if (data.outputTokens != null) setOutputTokens(data.outputTokens);
        if (data.estimatedCost != null) setEstimatedCost(data.estimatedCost);
        if (data.status !== "running") setIsRunning(false);
      } catch {
        // ignore poll errors
      }
    };

    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [taskId, isRunning]);

  const hasRetryInfo = (retryCount ?? 0) > 0 || (reviewIterationCount ?? 0) > 0 || !!nextRetryAt;

  if (inputTokens == null && outputTokens == null && !elapsedTime && !hasRetryInfo) return null;

  const cliCost = provider === "cli"
    ? estimateCostForCli(model, inputTokens ?? 0, outputTokens ?? 0)
    : null;
  const cliModelKnown = provider === "cli" && model != null && findPricing(model) != null;

  return (
    <Card>
      <CardContent className="pt-4">
        <p className="text-base font-semibold mb-2 flex items-center gap-2 flex-wrap">
          Metadata
          {isRunning && (
            <span className="inline-flex items-center gap-1 text-sky-400">
              <span className="size-1.5 rounded-full bg-sky-400 animate-pulse" />
              live
            </span>
          )}
          {elapsedTime && (
            <span className="ml-auto font-normal normal-case text-muted-foreground tabular-nums">
              ⏱ {elapsedTime}
            </span>
          )}
          {tokensPerMin !== null && (
            <span className="font-normal normal-case text-muted-foreground tabular-nums" title="Current token throughput">
              · {tokensPerMin.toLocaleString()} tok/min
            </span>
          )}
          {etaSecs !== null && (
            <span
              className="font-normal normal-case text-amber-400 tabular-nums"
              title="Estimated time until budget is reached at current rate"
            >
              · ~{formatElapsed(Math.round(etaSecs))} remaining
            </span>
          )}
        </p>
        <div className="flex flex-wrap gap-4 text-sm">
          {inputTokens != null && (
            <div>
              <span className="text-muted-foreground">Input: </span>
              <span className="font-mono font-medium">{formatTokens(inputTokens)}</span>
            </div>
          )}
          {outputTokens != null && (
            <div>
              <span className="text-muted-foreground">Output: </span>
              <span className="font-mono font-medium">{formatTokens(outputTokens)}</span>
            </div>
          )}
          {inputTokens != null && outputTokens != null && (
            <div>
              <span className="text-muted-foreground">Total: </span>
              <span className="font-mono font-medium">{formatTokens(inputTokens + outputTokens)}</span>
            </div>
          )}
          {estimatedCost != null ? (
            <div className="ml-auto flex flex-col items-end gap-0.5">
              <div>
                <span className="text-muted-foreground">Est. cost: </span>
                <span className="font-mono font-medium text-green-400">{formatCost(estimatedCost)}</span>
                {costBudget != null && (
                  <span className="text-muted-foreground font-mono"> / ${costBudget.toFixed(2)}</span>
                )}
              </div>
              {costBudget != null && estimatedCost != null && (
                <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden" style={{ minWidth: "80px" }}>
                  <div
                    className={`h-full rounded-full transition-all ${estimatedCost / costBudget > 0.8 ? "bg-orange-400" : "bg-green-400"}`}
                    style={{ width: `${Math.min(100, (estimatedCost / costBudget) * 100).toFixed(1)}%` }}
                  />
                </div>
              )}
            </div>
          ) : provider === "cli" ? (
            <div className="ml-auto flex items-baseline gap-1.5">
              {cliCost != null ? (
                <>
                  <span className="font-mono font-medium text-green-400">~{formatCost(cliCost)}</span>
                  <span className="text-xs text-muted-foreground italic">est. based on API pricing</span>
                </>
              ) : cliModelKnown === false && model != null ? (
                <span className="text-xs text-muted-foreground italic">Pricing not available</span>
              ) : null}
            </div>
          ) : null}
        </div>
        {hasRetryInfo && (
          <div className="flex flex-wrap gap-4 text-sm mt-2 pt-2 border-t border-border">
            {(retryCount ?? 0) > 0 && (
              <p className="text-yellow-500">Retry count: {retryCount}</p>
            )}
            {(reviewIterationCount ?? 0) > 0 && (
              <p className="text-sky-400">Revision requested: {reviewIterationCount}</p>
            )}
            {nextRetryAt && (
              <p className="text-muted-foreground">
                Resumes at <LocalDateTime iso={nextRetryAt} />
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
