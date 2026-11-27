/**
 * Runtime half of the provider auth-failure telemetry (pure half: src/lib/provider-auth-telemetry.ts).
 * Emits a `ctm.provider.auth_failure` log event and bumps `ctm.provider.auth_failures`. Both are
 * no-ops when telemetry is off, and never throw.
 */
import type { Span } from "@opentelemetry/api";
import { emitLog, getMeter } from "./otel";
import {
  PROVIDER_AUTH_FAILURE_EVENT,
  providerAuthFailureAttributes,
  providerAuthFailureBody,
  type ProviderAuthFailure,
} from "./provider-auth-telemetry";

export function recordProviderAuthFailure(f: ProviderAuthFailure, span?: Span): void {
  try {
    emitLog(providerAuthFailureBody(f), "error", providerAuthFailureAttributes(f), span, PROVIDER_AUTH_FAILURE_EVENT);
    getMeter()
      .createCounter("ctm.provider.auth_failures", { description: "AI provider credentials found expired or invalid" })
      .add(1, {
        "ctm.provider.name": f.provider.name,
        "ctm.provider.type": f.provider.type,
        "ctm.provider.auth.source": f.source,
      });
  } catch {
    /* telemetry must never affect the caller */
  }
}
