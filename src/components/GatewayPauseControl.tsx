"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { GATEWAY_PAUSE_DURATIONS, type GatewayPauseDuration } from "@/lib/llm-gateway/pause";

interface PauseStatus {
  paused: boolean;
  until: string | null;
}

/**
 * "Temporarily disable" switch for the LLM gateway (/api/llm/v1/*). Shown on the API Proxy
 * analytics tab and in Settings → API; backed by /api/gateway-pause.
 */
export function GatewayPauseControl({ compact = false }: { compact?: boolean }) {
  const [status, setStatus] = useState<PauseStatus | null>(null);
  const [duration, setDuration] = useState<GatewayPauseDuration>("1h");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/gateway-pause", { cache: "no-store" });
      if (res.ok) setStatus(await res.json());
    } catch {
      /* leave the last known state */
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/gateway-pause", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: PauseStatus | null) => {
        if (!cancelled && data) setStatus(data);
      })
      .catch(() => {
        /* leave the last known state */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Tick so a timed pause flips back to "active" on screen when it runs out.
  useEffect(() => {
    if (!status?.paused || !status.until) return;
    const id = setInterval(() => {
      setNow(Date.now());
      if (new Date(status.until!).getTime() <= Date.now()) load();
    }, 15_000);
    return () => clearInterval(id);
  }, [status, load]);

  const pause = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/gateway-pause", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ duration }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to disable the gateway");
      setStatus(data);
      setNow(Date.now());
      toast.success("API proxy disabled");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to disable the gateway");
    } finally {
      setBusy(false);
    }
  };

  const resume = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/gateway-pause", { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to re-enable the gateway");
      setStatus(await res.json());
      toast.success("API proxy re-enabled");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to re-enable the gateway");
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return <p className="text-sm text-muted-foreground">Loading API proxy status…</p>;
  }

  const paused = status.paused && (!status.until || new Date(status.until).getTime() > now);

  return (
    <div className={`flex flex-col gap-3 ${compact ? "" : "rounded-lg border border-border p-4"}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full ${
            paused ? "bg-amber-500/15 text-amber-400" : "bg-green-500/15 text-green-400"
          }`}
        >
          <span className={`inline-block size-1.5 rounded-full ${paused ? "bg-amber-400" : "bg-green-400"}`} />
          {paused ? "Disabled" : "Active"}
        </span>
        <span className="text-sm text-muted-foreground">
          {paused
            ? status.until
              ? `Requests are refused (503) until ${new Date(status.until).toLocaleString()} — ${formatRemaining(new Date(status.until).getTime() - now)} left.`
              : "Requests are refused (503) until you re-enable it."
            : "Accepting requests at /api/llm/v1."}
        </span>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {paused ? (
          <Button size="sm" onClick={resume} disabled={busy}>
            Re-enable now
          </Button>
        ) : null}
        <Select value={duration} onValueChange={(v) => setDuration(v as GatewayPauseDuration)}>
          <SelectTrigger className="w-44 h-8 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {GATEWAY_PAUSE_DURATIONS.map((d) => (
              <SelectItem key={d.id} value={d.id}>{d.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" variant={paused ? "outline" : "destructive"} onClick={pause} disabled={busy}>
          {paused ? "Change pause" : "Disable temporarily"}
        </Button>
      </div>
    </div>
  );
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return "0m";
  const mins = Math.ceil(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs}h ${mins % 60}m`;
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}
