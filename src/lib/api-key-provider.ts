// Which provider the LLM gateway (/api/llm/v1/*) runs an API key's requests on. Pure and
// client-safe (Settings → API imports it), unlike src/lib/api-keys.ts which needs `crypto`.

/**
 * Chosen like a task's provider: `useSmartProvider` = smart pick, `aiProviderId` = one pinned
 * connection, neither = the default chain (smart pick if globally on → default → any enabled).
 */
export interface ApiKeyProviderChoice {
  aiProviderId: string | null;
  useSmartProvider: boolean;
}

/** The `provider` value meaning "smart pick" in the api-keys API (same as MCP's update_task). */
export const SMART_PROVIDER_VALUE = "smart";

/**
 * Parses the `provider` field of `POST`/`PATCH /api/api-keys`: `""`/`null`/absent = default,
 * `"smart"` = smart pick, anything else = a provider id (existence is the caller's check).
 * Returns null for a value of the wrong type.
 */
export function parseApiKeyProvider(value: unknown): ApiKeyProviderChoice | null {
  if (value === undefined || value === null) return { aiProviderId: null, useSmartProvider: false };
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v) return { aiProviderId: null, useSmartProvider: false };
  if (v === SMART_PROVIDER_VALUE) return { aiProviderId: null, useSmartProvider: true };
  return { aiProviderId: v, useSmartProvider: false };
}

/** Inverse of parseApiKeyProvider(): the single `provider` value the UI's picker shows. */
export function apiKeyProviderValue(choice: ApiKeyProviderChoice): string {
  if (choice.useSmartProvider) return SMART_PROVIDER_VALUE;
  return choice.aiProviderId ?? "";
}
