/**
 * Outbound HTTP auto-instrumentation — CLIENT spans (with server.address) for
 * calls this process makes to other services, which is what a backend's
 * service map draws its edges from.
 *
 * Import this module FIRST in a process entry point (before anything that
 * loads an HTTP client). `fetch` is covered by the undici instrumentation, which
 * hooks diagnostics channels and so works whenever it's enabled. The `http`
 * instrumentation (axios in Slack's SDK, the AWS SDK) patches the module at
 * require time, so modules that grabbed `http` earlier would be missed.
 *
 * Both are enabled unconditionally and stay installed. They go through the
 * global tracer, which is the settings-driven delegating provider in otel.ts,
 * so with export off they produce only no-op spans. Requests to the OTLP
 * collector itself are skipped: the metric exporter and the test button don't
 * suppress tracing, and tracing them would make exports produce more spans.
 * With several destinations, requests to any of them are skipped.
 */
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { currentOtelConfig } from "./otel-config";

const globalForPreload = globalThis as unknown as { __ctmOtelPreloaded?: boolean };

function collectorHosts(): string[] {
  const hosts: string[] = [];
  for (const { endpoint } of currentOtelConfig()?.destinations ?? []) {
    try { hosts.push(new URL(endpoint).host); } catch { /* not a URL — nothing to skip */ }
  }
  return hosts;
}

function isCollector(host: string | undefined | null): boolean {
  return !!host && collectorHosts().includes(host);
}

export function enableOutboundInstrumentation(): void {
  if (globalForPreload.__ctmOtelPreloaded) return;
  globalForPreload.__ctmOtelPreloaded = true;

  new UndiciInstrumentation({
    ignoreRequestHook: (request) => {
      try { return isCollector(new URL(request.origin).host); } catch { return false; }
    },
  }).enable();

  new HttpInstrumentation({
    // Incoming requests are Next.js's job (it already emits SERVER spans); this is outbound only.
    ignoreIncomingRequestHook: () => true,
    ignoreOutgoingRequestHook: (options) => {
      const host = options.host ?? options.hostname;
      const port = options.port ? `:${options.port}` : "";
      return isCollector(host ? `${host}${port}` : null) || isCollector(host);
    },
  }).enable();
}

enableOutboundInstrumentation();
