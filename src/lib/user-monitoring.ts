// User monitoring (ObiStack website behaviour analytics: page views, clicks, web
// vitals, front-end errors from this UI). Opt-in from Settings → Observability:
// nothing is sent unless it's switched on *and* an analytics key is saved.
// Pure — the root layout reads the Setting rows and passes them through here.

export const USER_MONITORING_KEYS = {
  enabled: "user_monitoring_enabled",
  apiKey: "user_monitoring_api_key",
  host: "user_monitoring_host",
} as const;

export const DEFAULT_USER_MONITORING_HOST = "https://ingest.obistack.com";

export interface UserMonitoringConfig {
  apiKey: string;
  host: string;
}

/** The config to start the browser client with, or null when monitoring is off or incomplete. */
export function resolveUserMonitoring(settings: Record<string, string | undefined>): UserMonitoringConfig | null {
  if (settings[USER_MONITORING_KEYS.enabled] !== "true") return null;
  const apiKey = settings[USER_MONITORING_KEYS.apiKey]?.trim();
  if (!apiKey) return null;
  const host = settings[USER_MONITORING_KEYS.host]?.trim() || DEFAULT_USER_MONITORING_HOST;
  return { apiKey, host };
}

/** A plain-language problem with an analytics key, or null when it looks usable. */
export function validateUserMonitoringKey(raw: string): string | null {
  const key = raw.trim();
  if (!key) return "Enter your ObiStack analytics key";
  if (!key.startsWith("lsk_")) return "ObiStack analytics keys start with lsk_";
  if (/\s/.test(key)) return "The key can't contain spaces";
  return null;
}

/** A problem with a custom ingest host, or null when it's blank (default) or a valid http(s) URL. */
export function validateUserMonitoringHost(raw: string): string | null {
  const host = raw.trim();
  if (!host) return null;
  try {
    const url = new URL(host);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "The host must be an http(s) URL";
    return null;
  } catch {
    return "The host must be a full URL, e.g. https://ingest.obistack.com";
  }
}
