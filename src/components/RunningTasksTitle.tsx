"use client";

import { useEffect } from "react";

const BASE_TITLE = "AI Task Manager";
const POLL_INTERVAL_MS = 10_000;

/**
 * Invisible client component that polls for running tasks and updates the
 * browser tab title (e.g. "(2 running) AI Task Manager") so users can
 * monitor task execution without keeping the tab in focus.
 *
 * Rendered once in the root layout — produces no visible output.
 */
export function RunningTasksTitle() {
  useEffect(() => {
    let cancelled = false;

    const update = async () => {
      try {
        const res = await fetch("/api/tasks");
        if (!res.ok || cancelled) return;
        const tasks = (await res.json()) as Array<{ status: string }>;
        const running = tasks.filter((t) => t.status === "running").length;
        if (!cancelled) {
          document.title = running > 0 ? `(${running} running) ${BASE_TITLE}` : BASE_TITLE;
        }
      } catch {
        // Non-fatal: don't change the title on error
      }
    };

    void update();
    const id = setInterval(() => void update(), POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(id);
      document.title = BASE_TITLE;
    };
  }, []);

  return null;
}
