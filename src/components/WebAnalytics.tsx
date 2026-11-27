"use client";

import { useEffect } from "react";
import type { UserAnalytics as WebAnalyticsClient } from "@obistack/user-analytics";

let analytics: WebAnalyticsClient | undefined;
let starting = false;

/** The analytics client, for custom events (`getAnalytics()?.capture(...)`). Undefined when user monitoring is off. */
export function getAnalytics(): WebAnalyticsClient | undefined {
  return analytics;
}

/**
 * Invisible client component that starts ObiStack user monitoring (page views,
 * clicks, web vitals, front-end errors) once per page load.
 *
 * Off unless Settings → Observability → "Enable user monitoring in ObiStack" is
 * on with an analytics key; the root layout resolves that (`resolveUserMonitoring()`)
 * and passes nothing when it's off. The SDK is imported lazily, so an install
 * that never turns it on never loads it.
 */
export function WebAnalytics({ apiKey, host }: { apiKey?: string; host?: string }) {
  useEffect(() => {
    if (analytics || starting || !apiKey?.trim() || !host?.trim()) return;
    starting = true;
    import("@obistack/user-analytics")
      .then(({ init }) => {
        analytics = init({ key: apiKey.trim(), host: host.trim() });
      })
      .catch((err) => {
        // init() throws on a malformed key/host. That's a configuration
        // mistake, not a reason to take the whole UI down from the root
        // layout — log it and run without monitoring.
        console.warn(`[user-monitoring] Disabled: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        starting = false;
      });
  }, [apiKey, host]);

  return null;
}
