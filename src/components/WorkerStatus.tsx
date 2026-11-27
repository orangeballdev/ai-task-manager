"use client";
import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";

interface WorkerHealth {
  alive: boolean;
  lastSeen: string | null;
}

function timeAgo(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

export function WorkerStatus() {
  const [health, setHealth] = useState<WorkerHealth | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const res = await fetch("/api/settings/worker-health");
        if (!res.ok) return;
        const data = await res.json() as WorkerHealth;
        if (!cancelled) setHealth(data);
      } catch { /* ignore */ }
    }

    void check();
    const interval = setInterval(() => void check(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Don't render anything until we've had a first response, or if the worker is alive
  if (!health || health.alive) return null;

  return (
    <div className="flex items-center gap-2 rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-4 py-2.5 text-sm text-yellow-400 mb-4">
      <AlertTriangle className="size-4 shrink-0" />
      <span className="font-medium">Worker offline</span>
      <span className="text-yellow-400/70">
        : tasks will not run until the worker process is started.
        {health.lastSeen && ` Last seen ${timeAgo(health.lastSeen)}.`}
        {!health.lastSeen && " It may never have been started."}
      </span>
    </div>
  );
}
