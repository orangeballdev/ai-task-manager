// Public API key generation/hashing for the /api/v1/* routes (see src/lib/api-auth.ts).
//
// Keys look like `tm_live_<48 hex chars>`. Only the SHA-256 hash is ever persisted
// (ApiKey.keyHash) — the plaintext key exists only in the HTTP response at creation
// time, in Settings -> API. `keyPrefix` is a short, non-secret slice (prefix + last 4)
// kept alongside the hash purely so the Settings UI can show "which key is this" in a
// list without being able to reconstruct the secret from it.
import { randomBytes, createHash } from "crypto";

export const API_KEY_PREFIX = "tm_live_";

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key.trim()).digest("hex");
}

/** Short, non-secret identifier shown in the UI, e.g. "tm_live_ab12…ff90". */
export function previewApiKey(key: string): string {
  const body = key.slice(API_KEY_PREFIX.length);
  return `${API_KEY_PREFIX}${body.slice(0, 4)}…${body.slice(-4)}`;
}

/** Generates a brand-new API key. Returns the plaintext key (show once) plus what gets stored. */
export function generateApiKey(): { key: string; keyHash: string; keyPrefix: string } {
  const key = `${API_KEY_PREFIX}${randomBytes(24).toString("hex")}`;
  return { key, keyHash: hashApiKey(key), keyPrefix: previewApiKey(key) };
}
