"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import { X, RefreshCw, Stethoscope } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ProviderHealthStatus, HealthCheckCache, OAuthUsageWindow, OAuthExtraUsage } from "@/lib/health-check";

interface HealthSettings {
  enabled: boolean;
  intervalMinutes: number;
  model: string;
  cache: HealthCheckCache | null;
}

const TYPE_LABELS: Record<string, string> = {
  cli: "Claude CLI",
  api: "Anthropic API",
  openai: "OpenAI / Compatible",
};

function StatusDot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${ok ? "text-green-400" : "text-red-400"}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${ok ? "bg-green-400" : "bg-red-400"}`} />
      {label}
    </span>
  );
}

// Usage credits ("extra usage") keep a subscription working past 100% of its plan windows,
// so a spent window with credits left isn't "out of tokens" — say so rather than leaving the
// red 100% bar as the only signal.
function ExtraUsageLine({ extra }: { extra: OAuthExtraUsage }) {
  if (extra.is_enabled !== true) return null;

  const exponent = extra.decimal_places ?? 2;
  const money = (minor?: number | null) =>
    typeof minor === "number"
      ? new Intl.NumberFormat(undefined, {
          style: "currency",
          currency: extra.currency || "USD",
          minimumFractionDigits: exponent,
        }).format(minor / 10 ** exponent)
      : null;

  const used = money(extra.used_credits);
  const limit = money(extra.monthly_limit);
  const spent = extra.spend_limit_reached === true;

  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="text-muted-foreground font-medium">Usage credits</span>
      <span className={`tabular-nums ${spent ? "text-red-400" : "text-green-400"}`}>
        {spent
          ? "spend limit reached"
          : used && limit
            ? `${used} of ${limit} used — covers plan limits`
            : "enabled — covers plan limits"}
      </span>
    </div>
  );
}

function UsageBar({ label, window: w }: { label: string; window: OAuthUsageWindow }) {
  const pct = Math.min(100, Math.max(0, w.utilization));
  const barColor =
    pct >= 90 ? "bg-red-500" :
    pct >= 60 ? "bg-yellow-500" :
    "bg-green-500";
  const textColor =
    pct >= 90 ? "text-red-400" :
    pct >= 60 ? "text-yellow-400" :
    "text-green-400";

  const resetsAt = new Date(w.resets_at);
  const now = new Date();
  const diffMs = resetsAt.getTime() - now.getTime();
  let resetLabel: string;
  if (diffMs <= 0) {
    resetLabel = "resetting soon";
  } else if (diffMs < 60 * 60 * 1000) {
    const mins = Math.ceil(diffMs / 60000);
    resetLabel = `resets in ${mins}m`;
  } else if (diffMs < 24 * 60 * 60 * 1000) {
    const hrs = Math.round(diffMs / 3600000 * 10) / 10;
    resetLabel = `resets in ${hrs}h`;
  } else {
    resetLabel = `resets ${resetsAt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} ${resetsAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground font-medium">{label}</span>
        <span className={`font-semibold tabular-nums ${textColor}`}>{pct.toFixed(1)}%</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground">{resetLabel}</p>
    </div>
  );
}

function ProviderRow({ status }: { status: ProviderHealthStatus }) {
  const typeLabel = TYPE_LABELS[status.providerType] ?? status.providerType;
  const authOk = status.authStatus === "ok";
  const livenessOk = status.livenessStatus === "ok";
  const disabled = status.isEnabled === false;

  return (
    <div className={`flex flex-col gap-2 rounded-lg border border-border bg-muted/20 px-3 py-3 ${disabled ? "opacity-80" : ""}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium truncate">{status.providerName}</span>
          <span className="text-xs px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground shrink-0">{typeLabel}</span>
          {disabled && (
            <span className="text-xs px-1.5 py-0.5 rounded-full bg-zinc-700 text-zinc-300 shrink-0">Disabled</span>
          )}
        </div>
        <span
          className={`text-xs font-semibold shrink-0 ${
            status.healthy ? "text-green-400" : status.usageExhausted ? "text-yellow-400" : "text-red-400"
          }`}
        >
          {status.healthy ? "✓ Healthy" : status.usageExhausted ? "◌ Out of tokens" : "✗ Unhealthy"}
        </span>
      </div>

      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex flex-col gap-0.5">
          <StatusDot ok={authOk} label={authOk ? "Auth OK" : "Auth failed"} />
          {status.authError && (
            <p className="text-xs text-muted-foreground ml-2.5 leading-snug">{status.authError}</p>
          )}
        </div>

        {status.livenessStatus !== "skipped" && (
          <div className="flex flex-col gap-0.5">
            <span
              title={status.livenessWarning}
              className={`inline-flex items-center gap-1 text-xs font-medium cursor-default ${livenessOk ? "text-green-400" : "text-red-400"}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${livenessOk ? "bg-green-400" : "bg-red-400"}`} />
              {livenessOk ? "Liveness OK" : "Liveness failed"}
              {status.livenessWarning && (
                <span className="text-yellow-400 ml-0.5" title={status.livenessWarning}>⚠</span>
              )}
            </span>
            {status.livenessError && (
              <p className="text-xs text-muted-foreground ml-2.5 leading-snug">{status.livenessError}</p>
            )}
            {status.livenessWarning && (
              <p className="text-xs text-yellow-400/80 ml-2.5 leading-snug">{status.livenessWarning}</p>
            )}
          </div>
        )}

        {status.livenessStatus === "skipped" && (
          <span className={`text-xs ${status.usageExhausted ? "text-yellow-400/90" : "text-muted-foreground"}`}>
            {status.livenessSkipReason ?? "Liveness check skipped"}
          </span>
        )}
      </div>

      {(status.usageMetrics || status.usageRateLimited) && (
        <div className="flex flex-col gap-2 pt-1 border-t border-border/50">
          <p className="text-xs font-medium text-muted-foreground">Usage</p>
          {status.usageRateLimited && (
            <p className="text-xs text-yellow-400/80">Usage data couldn&apos;t be updated, rate limited. Showing last known values.</p>
          )}
          {status.usageMetrics && (
            <>
              <UsageBar label="5-hour window" window={status.usageMetrics.five_hour} />
              <UsageBar label="7-day window" window={status.usageMetrics.seven_day} />
              {status.usageMetrics.extra_usage && <ExtraUsageLine extra={status.usageMetrics.extra_usage} />}
            </>
          )}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Checked {new Date(status.checkedAt).toLocaleString()}
      </p>
    </div>
  );
}

export function HealthIndicator() {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<HealthSettings | null>(null);
  const [checking, setChecking] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const runCheck = useCallback(async () => {
    setChecking(true);
    try {
      const res = await fetch("/api/providers/health", { method: "POST" });
      if (res.ok) {
        const cache = await res.json() as HealthCheckCache;
        setSettings((prev) => prev ? { ...prev, cache } : null);
      }
    } catch {
      // Ignore
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/providers/health")
      .then((res) => (res.ok ? (res.json() as Promise<HealthSettings>) : null))
      .then((data) => {
        if (!cancelled && data) setSettings(data);
      })
      .catch(() => {
        // Silently ignore — health indicator is non-critical
      });
    return () => { cancelled = true; };
  }, []);

  // Set up background polling at the configured interval
  useEffect(() => {
    if (!settings?.enabled) return;
    if (intervalRef.current) clearInterval(intervalRef.current);

    const intervalMs = (settings.intervalMinutes || 60) * 60 * 1000;
    intervalRef.current = setInterval(() => {
      void runCheck();
    }, intervalMs);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [settings?.enabled, settings?.intervalMinutes, runCheck]);

  if (!settings) return null;
  if (!settings.enabled) return null;

  const results = settings.cache?.results ?? [];
  const hasResults = results.length > 0;
  // Disabled providers are shown for visibility/stats but shouldn't drive the summary
  // indicator into "unhealthy" — the user turned them off on purpose.
  const unhealthy = results.filter((r) => r.isEnabled !== false && !r.healthy);
  const allHealthy = hasResults && unhealthy.length === 0;
  // Being out of tokens isn't a fault — it resolves itself when the usage window resets,
  // so warn in amber rather than raising a red alarm.
  const onlyOutOfTokens = unhealthy.length > 0 && unhealthy.every((r) => r.usageExhausted);

  let indicator: React.ReactNode;
  if (!hasResults) {
    indicator = <Stethoscope size={13} className="text-muted-foreground" />;
  } else if (allHealthy) {
    indicator = <Stethoscope size={13} className="text-green-400" />;
  } else if (onlyOutOfTokens) {
    indicator = <Stethoscope size={13} className="text-yellow-400" />;
  } else {
    indicator = <Stethoscope size={13} className="text-red-400" />;
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center justify-center w-6 h-6 rounded-full border border-muted-foreground/40 hover:border-foreground transition-colors"
        aria-label="Provider health status"
        title={
          !hasResults
            ? "Health status unknown, click to check"
            : allHealthy
              ? "All providers healthy"
              : onlyOutOfTokens
                ? "Usage limit reached, waiting for quota to reset"
                : "Some providers unhealthy"
        }
      >
        {indicator}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <div
            className="relative bg-card border border-border rounded-xl shadow-2xl w-full max-w-lg mx-4 p-6 max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4 shrink-0">
              <h2 className="text-base font-semibold">Provider Health</h2>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={runCheck}
                  disabled={checking}
                  className="h-7 px-2 text-xs gap-1"
                >
                  <RefreshCw size={12} className={checking ? "animate-spin" : ""} />
                  {checking ? "Checking…" : "Check now"}
                </Button>
                <button
                  onClick={() => setOpen(false)}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                  aria-label="Close"
                >
                  <X size={16} />
                </button>
              </div>
            </div>

            <div className="overflow-y-auto flex-1 flex flex-col gap-3">
              {results.length === 0 ? (
                <div className="text-center py-8 text-sm text-muted-foreground">
                  {checking ? (
                    <p>Running health checks…</p>
                  ) : (
                    <>
                      <p className="mb-2">No results yet.</p>
                      <Button size="sm" onClick={runCheck}>Run health check</Button>
                    </>
                  )}
                </div>
              ) : (
                results.map((r) => <ProviderRow key={r.providerId} status={r} />)
              )}
            </div>

            {settings.cache?.checkedAt && results.length > 0 && (
              <p className="text-xs text-muted-foreground mt-3 shrink-0">
                Last checked: {new Date(settings.cache.checkedAt).toLocaleString()}
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
