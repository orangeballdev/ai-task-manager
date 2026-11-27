/**
 * Pure half of the provider auth-failure telemetry (runtime half: src/lib/provider-auth-otel.ts).
 *
 * When an AI provider's credentials stop working — an OAuth login that expired and couldn't
 * be refreshed, a revoked API key, an expired Codex login — we emit one structured
 * `ctm.provider.auth_failure` log event so it can be searched for and alerted on in the logs
 * backend, instead of only living in an email, a task's activity log or the worker's console.
 */
import type { AnyValueMap } from "@opentelemetry/api-logs";
import { genAiProviderName } from "./gen-ai-telemetry";

export const PROVIDER_AUTH_FAILURE_EVENT = "ctm.provider.auth_failure";

/** Where the dead login was noticed. */
export type ProviderAuthFailureSource =
  /** A task run died because the provider couldn't authenticate (the worker hands the task off). */
  | "task_run"
  /** The worker's periodic Claude CLI credential refresh / liveness probe. */
  | "credential_check"
  /** A health check from Settings → AI Providers → Health. */
  | "health_check";

export interface ProviderAuthFailure {
  provider: { id: string; name: string; type: string };
  source: ProviderAuthFailureSource;
  /** The provider's own error text. Redacted and clipped before it's recorded. */
  reason?: string | null;
  taskId?: string | null;
}

const MAX_REASON = 500;
const MASK = "***";

// Only things *shaped* like a credential. The general-purpose `redactSecrets()` also masks
// `key: value` pairs whose key mentions auth/token, which would turn every auth error
// ("Failed to authenticate: OAuth session expired…") into noise.
const CREDENTIAL_PATTERNS: RegExp[] = [
  /\b(?:sk-(?:ant-|proj-)?|gh[pousr]_|github_pat_|tm_live_|tm_mcp_|AIza)[A-Za-z0-9_*.-]{6,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g,
  /(?<=\bBearer\s+)[A-Za-z0-9._~+/=-]{6,}/g,
  /(?<=[?&](?:access_token|refresh_token|token|api_?key|key)=)[^&\s"']+/gi,
];

/** The provider's error, safe to export: credential-looking strings masked, clipped. */
export function sanitizeAuthReason(reason: string | null | undefined): string | undefined {
  const text = (reason ?? "").trim();
  if (!text) return undefined;
  const redacted = CREDENTIAL_PATTERNS.reduce((out, re) => out.replace(re, MASK), text);
  return redacted.length > MAX_REASON ? `${redacted.slice(0, MAX_REASON - 1)}…` : redacted;
}

export function providerAuthFailureAttributes(f: ProviderAuthFailure): AnyValueMap {
  const reason = sanitizeAuthReason(f.reason);
  return {
    "ctm.provider.id": f.provider.id,
    "ctm.provider.name": f.provider.name,
    "ctm.provider.type": f.provider.type,
    "gen_ai.provider.name": genAiProviderName(f.provider.type),
    "ctm.provider.auth.source": f.source,
    "error.type": "authentication",
    ...(reason ? { "ctm.provider.auth.reason": reason } : {}),
    ...(f.taskId ? { "ctm.task.id": f.taskId } : {}),
  };
}

export function providerAuthFailureBody(f: ProviderAuthFailure): string {
  const reason = sanitizeAuthReason(f.reason);
  return `AI provider "${f.provider.name}" (${f.provider.type}) credentials are expired or invalid${reason ? `: ${reason}` : ""}`;
}

/**
 * The auth failure a health-check result reports, or null when it reports none. `authStatus:
 * "error"` also covers a couple of local problems that say nothing about the credentials
 * (an unknown provider type, failing to write Codex's auth.json), which are left out.
 */
export function healthCheckAuthFailure(result: { authStatus: string; authError?: string }): string | null {
  if (result.authStatus !== "error") return null;
  const reason = result.authError?.trim() || "Authentication failed";
  if (/^(Unknown provider type|Failed to write)/i.test(reason)) return null;
  return reason;
}
