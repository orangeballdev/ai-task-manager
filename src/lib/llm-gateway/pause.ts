/**
 * Temporarily disabling the LLM gateway (`/api/llm/v1/*`) — the "Pause" control on the
 * /analytics/gateway tab and Settings → API. Pure; the DB half is pause-store.ts.
 *
 * Stored as one Setting row, `llm_gateway_paused_until`: an ISO timestamp (paused until
 * then, after which the gateway resumes on its own — no job needed, the value just stops
 * being in the future) or `indefinite` (paused until someone resumes it). No row, an
 * unparseable value or a past timestamp all mean "running".
 */

export const GATEWAY_PAUSE_KEY = "llm_gateway_paused_until";
export const GATEWAY_PAUSE_INDEFINITE = "indefinite";

/** Durations offered in the UI and accepted by `PUT /api/gateway-pause`. */
export const GATEWAY_PAUSE_DURATIONS = [
  { id: "15m", label: "15 minutes", ms: 15 * 60_000 },
  { id: "1h", label: "1 hour", ms: 60 * 60_000 },
  { id: "4h", label: "4 hours", ms: 4 * 60 * 60_000 },
  { id: "24h", label: "24 hours", ms: 24 * 60 * 60_000 },
  { id: "7d", label: "7 days", ms: 7 * 24 * 60 * 60_000 },
  { id: GATEWAY_PAUSE_INDEFINITE, label: "Until I resume it", ms: null },
] as const;

export type GatewayPauseDuration = (typeof GATEWAY_PAUSE_DURATIONS)[number]["id"];

export type GatewayPauseState =
  | { paused: false }
  /** `until` null = paused indefinitely. */
  | { paused: true; until: Date | null };

export function parseGatewayPause(value: string | null | undefined, now: Date = new Date()): GatewayPauseState {
  const v = value?.trim();
  if (!v) return { paused: false };
  if (v === GATEWAY_PAUSE_INDEFINITE) return { paused: true, until: null };
  const until = new Date(v);
  if (Number.isNaN(until.getTime()) || until.getTime() <= now.getTime()) return { paused: false };
  return { paused: true, until };
}

/** The Setting value for a pause of `duration` starting at `now`; null for an unknown duration. */
export function gatewayPauseValue(duration: unknown, now: Date = new Date()): string | null {
  const d = GATEWAY_PAUSE_DURATIONS.find((x) => x.id === duration);
  if (!d) return null;
  return d.ms == null ? GATEWAY_PAUSE_INDEFINITE : new Date(now.getTime() + d.ms).toISOString();
}

/** The error message gateway clients see while it's paused. */
export function gatewayPausedMessage(state: GatewayPauseState): string {
  if (!state.paused) return "";
  return state.until
    ? `The LLM gateway is temporarily disabled until ${state.until.toISOString()}. Re-enable it from /analytics/gateway or Settings → API.`
    : "The LLM gateway is temporarily disabled. Re-enable it from /analytics/gateway or Settings → API.";
}

/** Seconds a client should wait before retrying (`Retry-After`); null when indefinite. */
export function gatewayRetryAfterSeconds(state: GatewayPauseState, now: Date = new Date()): number | null {
  if (!state.paused || !state.until) return null;
  return Math.max(1, Math.ceil((state.until.getTime() - now.getTime()) / 1000));
}

/** JSON shape returned by `/api/gateway-pause`. */
export function serializeGatewayPause(state: GatewayPauseState): { paused: boolean; until: string | null } {
  return state.paused ? { paused: true, until: state.until ? state.until.toISOString() : null } : { paused: false, until: null };
}
