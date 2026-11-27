import { spawn } from "child_process";
import { readFile } from "fs/promises";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { syncCredentialsToDisk } from "@/lib/providers/cli-credentials";
import {
  codexAuthLooksValid,
  extractCodexExpiresAt,
  probeCodexLiveness,
  readCodexRateLimits,
  readCodexAuth,
  resolveCodexHome,
} from "@/lib/providers/codex-exec";

export interface OAuthUsageWindow {
  utilization: number;
  resets_at: string;
}

// "Extra usage" / usage credits: pay-as-you-go capacity that keeps a subscription working
// *after* its plan windows hit 100%. Present on the OAuth usage payload for accounts that
// have ever seen the feature; every field except `is_enabled` can be null.
export interface OAuthExtraUsage {
  is_enabled?: boolean | null;
  monthly_limit?: number | null;
  used_credits?: number | null;
  utilization?: number | null;   // percent of the credit budget spent
  currency?: string | null;
  decimal_places?: number | null;
  disabled_reason?: string | null;
  user_disabled?: boolean | null;
  spend_limit_reached?: boolean | null;
  credits_ever_enabled?: boolean | null;
}

export interface OAuthUsageMetrics {
  five_hour: OAuthUsageWindow;
  seven_day: OAuthUsageWindow;
  extra_usage?: OAuthExtraUsage | null;
}

export interface ProviderHealthStatus {
  providerId: string;
  providerName: string;
  providerType: "cli" | "api" | "openai" | "claude-pki" | "codex-cli";
  // Whether the provider is currently enabled for task use. Disabled providers can still be
  // health-checked (e.g. to keep a CLI's OAuth token fresh) — the UI flags them as disabled
  // rather than excluding them, so their stats stay visible.
  isEnabled?: boolean;
  authStatus: "ok" | "missing" | "error";
  authError?: string;
  livenessStatus: "ok" | "error" | "skipped";
  livenessError?: string;
  livenessWarning?: string;  // non-fatal hint shown on hover (e.g. possible token exhaustion)
  livenessSkipReason?: string;  // why liveness wasn't run (e.g. usage limit reached)
  usageExhausted?: boolean;  // subscription usage window is spent — not a real failure
  healthy: boolean;
  checkedAt: string;
  usageMetrics?: OAuthUsageMetrics;
  usageRateLimited?: boolean;
}

export interface HealthCheckCache {
  results: ProviderHealthStatus[];
  checkedAt: string;
}

interface DBProvider {
  id: string;
  name: string;
  type: string;
  isEnabled: boolean;
  configDir: string | null;
  credentialsJson: string | null;
  apiKey: string | null;
  baseUrl: string | null;
  model: string | null;
  pkiCertData?: Uint8Array | null;
  pkiCertPassphrase?: string | null;
  proxyUrl?: string | null;
}

const HEALTH_CHECK_TIMEOUT_MS = 30000;

const DEFAULT_HEALTH_MODELS: Record<string, string> = {
  api: "claude-haiku-4-5-20251001",
  openai: "gpt-4o-mini",
  "claude-pki": "claude-haiku-4-5-20251001",
};

function resolveConfigDir(configDir: string | null): string {
  return configDir?.trim() || join(homedir(), ".claude");
}

async function ensureCredentialsOnDisk(provider: DBProvider, opts?: CliCheckOptions): Promise<void> {
  if (!provider.credentialsJson) return;
  try {
    // Ownership-aware: a config dir holding another connection's login is overwritten, while
    // a token this provider's own CLI rotated since our last write is preserved (clobbering
    // it with a stale DB copy burns the rotated refresh token). See cli-credentials.ts.
    syncCredentialsToDisk({
      providerId: provider.id,
      dir: resolveConfigDir(provider.configDir),
      fileName: ".credentials.json",
      credentialsJson: provider.credentialsJson,
      expiresAtOf: extractExpiresAt,
      otherProviderCredentials: opts?.otherProviderCredentials,
    });
  } catch {
    // Non-fatal — CLI will still try to use whatever is on disk
  }
}

async function cliAuthCheck(provider: DBProvider): Promise<{ ok: boolean; error?: string }> {
  if (provider.credentialsJson) return { ok: true };

  const dir = resolveConfigDir(provider.configDir);
  const file = join(dir, ".credentials.json");
  try {
    await readFile(file);
    return { ok: true };
  } catch {
    return { ok: false, error: "No credentials found. Paste credentials in Settings → AI Providers." };
  }
}

// Patterns that indicate a subscription usage/rate limit rather than a hard error
const USAGE_LIMIT_PATTERNS = [
  /usage limit/i,
  /rate limit/i,
  /quota exceeded/i,
  /out of tokens/i,
  /plan limit/i,
  /subscription.*limit/i,
  /limit.*reached/i,
  /exceeded.*limit/i,
  /too many requests/i,
  /claude\.ai.*unavailable/i,
  /rate_limit/i,
  /insufficient_quota/i,
  /credit balance/i,
  /\b429\b/,
];

// Patterns that indicate an authentication/credential failure (expired token, 401, etc.)
const AUTH_ERROR_PATTERNS = [
  /failed to authenticate/i,
  /authentication failed/i,
  /invalid.*credential/i,
  /credentials.*expired/i,
  /session.*expired/i,
  /token.*expired/i,
  /invalid_grant/i,
  /\b401\b/,
  /unauthorized/i,
  /please log in/i,
  /not logged in/i,
  /login required/i,
];

export function detectUsageLimit(text: string): string | null {
  for (const pattern of USAGE_LIMIT_PATTERNS) {
    if (pattern.test(text)) {
      const line = text.split("\n").find((l) => pattern.test(l));
      return line?.trim() ?? text.slice(0, 200).trim();
    }
  }
  return null;
}

function detectAuthError(text: string): boolean {
  return AUTH_ERROR_PATTERNS.some((p) => p.test(text));
}

// True when the OAuth usage metrics we fetched directly from the Anthropic API
// confirm the subscription's usage window is actually exhausted (>=100%).
export function isWindowSpent(w?: OAuthUsageWindow, limitPercent: number = 100): boolean {
  if (!w || typeof w.utilization !== "number" || w.utilization < limitPercent) return false;
  // A window whose reset time has already passed is stale (cached) data — the quota has
  // replenished since, so don't treat it as exhausted.
  const resetsAt = new Date(w.resets_at).getTime();
  return Number.isNaN(resetsAt) || resetsAt > Date.now();
}

/**
 * What the Claude CLI itself believes about usage credits for a given config dir.
 *
 * The OAuth usage API's `extra_usage` block describes the *account*, but the CLI keeps its own
 * gate: it caches the `anthropic-ratelimit-unified-overage-disabled-reason` response header in
 * `<CLAUDE_CONFIG_DIR>/.claude.json` as `cachedExtraUsageDisabledReason`, and refuses to spend
 * credits whenever that reason is set — however healthy the account-level flags look. When the
 * two disagree the CLI wins, because the CLI is the process that runs our tasks: it exits with
 * "You've hit your session limit" and the task dies at the plan limit with credits untouched.
 *
 *  - "usable"  — reason explicitly null: the CLI will keep going on credits past the plan window
 *  - "blocked" — a reason is set ("org_level_disabled", "overage_not_provisioned",
 *                "out_of_credits", "org_spend_cap_reached", …): the CLI will not spend credits
 *  - "unknown" — no config file or no cached reason yet: the CLI has no opinion to apply
 */
export type CliExtraUsageState = "usable" | "blocked" | "unknown";

export interface CliExtraUsage {
  state: CliExtraUsageState;
  /** The CLI's raw disable reason, for explaining *why* credits aren't being spent. */
  reason?: string;
}

// With CLAUDE_CONFIG_DIR set the CLI keeps its config inside that dir; on the default
// (~/.claude) it sits beside it at ~/.claude.json.
function cliConfigFile(configDir?: string | null): string {
  const dir = configDir?.trim();
  return dir ? join(dir, ".claude.json") : join(homedir(), ".claude.json");
}

export function readCliExtraUsage(configDir?: string | null): CliExtraUsage {
  try {
    const parsed = JSON.parse(readFileSync(cliConfigFile(configDir), "utf8")) as {
      cachedExtraUsageDisabledReason?: string | null;
    };
    const reason = parsed?.cachedExtraUsageDisabledReason;
    if (reason === null) return { state: "usable" };
    if (typeof reason === "string" && reason.trim()) return { state: "blocked", reason };
    return { state: "unknown" };
  } catch {
    return { state: "unknown" };
  }
}

// True when the account has usage credits ("extra usage") turned on with budget left. A plan
// window at 100% does NOT stop such an account — requests keep going, billed to the credits —
// so treating 100% as "out of tokens" would hold tasks the subscription can actually run.
// `utilization` here is the percentage of the *credit* budget spent, not the plan window.
export function hasExtraUsageHeadroom(metrics?: OAuthUsageMetrics, cli: CliExtraUsageState = "unknown"): boolean {
  // The CLI's gate is authoritative — see readCliExtraUsage(). Account-level credits that the
  // CLI won't spend buy us nothing but a doomed run and a burnt retry.
  if (cli === "blocked") return false;
  const extra = metrics?.extra_usage;
  if (!extra) return false;
  if (extra.is_enabled !== true) return false;
  if (extra.user_disabled === true) return false;
  if (extra.disabled_reason) return false;
  if (extra.spend_limit_reached === true) return false;
  if (typeof extra.utilization === "number" && extra.utilization >= 100) return false;
  return true;
}

/**
 * Normalise a provider's `maxUsagePercent` (the share of each plan window the task manager may
 * use) to an integer in 1–100. Anything missing or nonsensical means "no cap" (100).
 */
export function normalizeMaxUsagePercent(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n)) return 100;
  return Math.min(100, Math.max(1, Math.round(n)));
}

/**
 * True when a plan window has reached the provider's usage cap (`maxUsagePercent` below 100):
 * the user asked us to leave the rest of the window for their own use, so the provider is
 * off-limits to tasks until that window resets. Usage credits don't change this — the cap is
 * about plan capacity the user wants to keep, not about whether a request would succeed.
 */
export function isOverUsageCap(metrics?: OAuthUsageMetrics | null, maxUsagePercent: number = 100): boolean {
  const cap = normalizeMaxUsagePercent(maxUsagePercent);
  if (!metrics || cap >= 100) return false;
  return isWindowSpent(metrics.five_hour, cap) || isWindowSpent(metrics.seven_day, cap);
}

export function isUsageExhausted(
  metrics?: OAuthUsageMetrics,
  cli: CliExtraUsageState = "unknown",
  maxUsagePercent: number = 100,
): boolean {
  if (!metrics) return false;
  if (isOverUsageCap(metrics, maxUsagePercent)) return true;
  if (!isWindowSpent(metrics.five_hour) && !isWindowSpent(metrics.seven_day)) return false;
  // Plan window is spent — but usage credits may still be covering this account.
  return !hasExtraUsageHeadroom(metrics, cli);
}

// When the usage window is spent, this is when it'll replenish — the earliest reset time
// among whichever window(s) are actually exhausted. Used to proactively throttle a provider
// (set AIProvider.throttledUntil) before a task ever tries to use it, rather than waiting
// for a task to fail first.
//
// With a usage cap (`maxUsagePercent` < 100) a window counts as spent once it reaches the cap.
// When a capped window resets the provider is usable again, so if *both* windows are over the
// cap the later reset is the one that matters.
export function usageResetTime(metrics?: OAuthUsageMetrics, maxUsagePercent: number = 100): Date | null {
  if (!metrics) return null;
  const cap = normalizeMaxUsagePercent(maxUsagePercent);
  if (cap < 100 && isOverUsageCap(metrics, cap)) {
    const capped: Date[] = [];
    if (isWindowSpent(metrics.five_hour, cap)) capped.push(new Date(metrics.five_hour.resets_at));
    if (isWindowSpent(metrics.seven_day, cap)) capped.push(new Date(metrics.seven_day.resets_at));
    const valid = capped.filter((d) => !Number.isNaN(d.getTime()));
    if (valid.length > 0) return valid.reduce((latest, d) => (d > latest ? d : latest));
  }
  const resets: Date[] = [];
  if (isWindowSpent(metrics.five_hour)) resets.push(new Date(metrics.five_hour.resets_at));
  if (isWindowSpent(metrics.seven_day)) resets.push(new Date(metrics.seven_day.resets_at));
  if (resets.length === 0) return null;
  return resets.reduce((soonest, d) => (d < soonest ? d : soonest));
}

// Human-readable explanation of why we didn't bother running a liveness check.
// The liveness check itself costs tokens, so when the subscription has none left
// it would always "fail" — which is misleading, not informative.
export function describeUsageExhaustion(metrics?: OAuthUsageMetrics, cli?: CliExtraUsage, maxUsagePercent: number = 100): string {
  const cap = normalizeMaxUsagePercent(maxUsagePercent);
  if (metrics && isOverUsageCap(metrics, cap) && !isWindowSpent(metrics.five_hour) && !isWindowSpent(metrics.seven_day)) {
    return `Usage cap reached: the ${isWindowSpent(metrics.five_hour, cap) ? "5-hour" : "7-day"} window is at or above the ${cap}% limit set for this provider. Tasks won't use it until the window resets.`;
  }
  const base = metrics
    ? `Usage limit reached: the ${isWindowSpent(metrics.five_hour) ? "5-hour" : "7-day"} window is fully used. Liveness check skipped until it resets.`
    : "Usage limit reached: liveness check skipped until usage resets.";
  // The confusing case worth naming explicitly: the account shows usage credits enabled, but
  // the CLI has them gated, so it stops at the plan limit and never touches the credits.
  if (cli?.state === "blocked" && metrics?.extra_usage?.is_enabled === true) {
    return `${base} Usage credits are enabled on the account, but the Claude CLI reports them unavailable (${cli.reason}) and will not spend them.`;
  }
  return base;
}

/**
 * True when the account advertises usable credits but the CLI has them gated.
 *
 * The CLI only refreshes `cachedExtraUsageDisabledReason` from a response header, i.e. by making
 * a request — so once we start skipping work on the strength of that cached reason, it can never
 * update itself and a since-fixed block would stay stuck forever. Callers use this to know the
 * cached verdict is worth re-testing with a real (tiny) request rather than trusted outright.
 */
export function creditGateMayBeStale(metrics?: OAuthUsageMetrics, cli?: CliExtraUsage): boolean {
  return cli?.state === "blocked" && hasExtraUsageHeadroom(metrics, "unknown");
}

/**
 * Run the one-token liveness prompt against a config dir. Exported so the throttle re-check can
 * settle an account-says-yes/CLI-says-no disagreement the only way that's authoritative: by
 * asking the CLI to do something. Succeeding also refreshes the CLI's own cached credit gate.
 */
export async function probeCliLiveness(configDir: string | null): Promise<{ ok: boolean; limitMessage?: string }> {
  const result = await spawnCliCheck(resolveConfigDir(configDir));
  return { ok: result.success, limitMessage: result.limitMessage };
}

function spawnCliCheck(configDir: string): Promise<{ success: boolean; error?: string; limitMessage?: string; isAuthError?: boolean }> {
  return new Promise((resolve) => {
    let resolved = false;

    const child = spawn(
      "claude",
      ["-p", "Say OK", "--output-format", "text", "--dangerously-skip-permissions", "--max-turns", "1"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: configDir,
          PATH: [process.env.PATH ?? "", process.env.CLAUDE_PATH].filter(Boolean).join(":"),
        },
      },
    );

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill("SIGTERM");
      resolve({ success: false, error: "Liveness check timed out after 30s" });
    }, HEALTH_CHECK_TIMEOUT_MS);

    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("close", (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) {
        resolve({ success: true });
      } else {
        const combined = `${stdout}\n${stderr}`.trim();
        const limitMessage = detectUsageLimit(combined);
        const isAuthError = !limitMessage && detectAuthError(combined);
        resolve({
          success: false,
          error: isAuthError
            ? "Credentials have expired, re-paste in Settings → AI Providers."
            : limitMessage ?? `CLI exited with code ${code ?? "null"}`,
          limitMessage: limitMessage ?? undefined,
          isAuthError: isAuthError || undefined,
        });
      }
    });

    child.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      const msg = (err as NodeJS.ErrnoException).code === "ENOENT"
        ? "Claude CLI not found. Install from https://claude.ai/download"
        : `Failed to start CLI: ${err.message}`;
      resolve({ success: false, error: msg });
    });
  });
}

export function extractOAuthAccessToken(credentialsJson: string): string | null {
  try {
    const parsed = JSON.parse(credentialsJson) as { claudeAiOauth?: { accessTokenFallback?: string; accessToken?: string } };
    return parsed?.claudeAiOauth?.accessTokenFallback ?? parsed?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

export function extractExpiresAt(credentialsJson: string): number {
  try {
    const parsed = JSON.parse(credentialsJson) as { claudeAiOauth?: { expiresAt?: number } };
    return parsed?.claudeAiOauth?.expiresAt ?? 0;
  } catch {
    return 0;
  }
}

async function readCredentialsJson(provider: DBProvider): Promise<string | null> {
  if (provider.credentialsJson) return provider.credentialsJson;
  const dir = resolveConfigDir(provider.configDir);
  try {
    return await readFile(join(dir, ".credentials.json"), "utf8");
  } catch {
    return null;
  }
}

export async function fetchOAuthUsage(accessToken: string): Promise<{ metrics: OAuthUsageMetrics; rateLimited: false } | { metrics: null; rateLimited: boolean }> {
  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 429) return { metrics: null, rateLimited: true };
    if (!res.ok) return { metrics: null, rateLimited: false };
    return { metrics: await res.json() as OAuthUsageMetrics, rateLimited: false };
  } catch {
    return { metrics: null, rateLimited: false };
  }
}

export interface CliCheckOptions {
  // True when a task is actively running on this provider right now. The liveness probe
  // below spawns a *second*, independent `claude` process that shares the same on-disk
  // credentials file (same CLAUDE_CONFIG_DIR) as the running task. If both processes need
  // to refresh the OAuth token around the same time, only one refresh can win — the other
  // gets a genuine "invalid_grant"/401 from Anthropic because the refresh token was already
  // rotated out from under it. That's a real auth error from the CLI's perspective, but it's
  // an artifact of the race, not evidence the credentials are actually bad (the running task
  // proves they aren't). So skip the probe entirely while a task holds this provider.
  busy?: boolean;
  /**
   * Stored credentials of the *other* providers, so a shared config dir whose contents are
   * recognisably someone else's login is overwritten rather than borrowed. See
   * `decideCredentialWrite`.
   */
  otherProviderCredentials?: (string | null | undefined)[];
}

/**
 * A disabled connection must not be *used*. The health page still lists it (its stats are
 * worth seeing, and the usage figures come from an HTTP call against the stored token, which
 * costs nothing), but the parts of the check that actually spend the subscription or touch
 * the shared config dir — writing credentials to disk and spawning the liveness prompt —
 * are skipped. Without this, switching a provider off still burned its tokens on every
 * health-check cycle and could leave its login sitting in a config dir another connection
 * authenticates from.
 */
export const DISABLED_SKIP_REASON =
  "Liveness check skipped: this connection is disabled. Usage figures are still shown, but no prompt is sent and its credentials aren't written to disk — enable it to check it live.";

async function checkCliProvider(provider: DBProvider, opts?: CliCheckOptions): Promise<ProviderHealthStatus> {
  const checkedAt = new Date().toISOString();
  const auth = await cliAuthCheck(provider);

  // Fetch OAuth usage metrics regardless of liveness outcome (best-effort, non-fatal)
  const credentialsJson = await readCredentialsJson(provider);
  let usageMetrics: OAuthUsageMetrics | undefined;
  let usageRateLimited: boolean | undefined;
  if (credentialsJson) {
    const token = extractOAuthAccessToken(credentialsJson);
    if (token) {
      const result = await fetchOAuthUsage(token);
      if (result.metrics) usageMetrics = result.metrics;
      if (result.rateLimited) usageRateLimited = true;
    }
  }

  if (!auth.ok) {
    return {
      providerId: provider.id,
      providerName: provider.name,
      providerType: "cli",
      authStatus: "missing",
      authError: auth.error,
      livenessStatus: "skipped",
      healthy: false,
      checkedAt,
      usageMetrics,
      usageRateLimited,
    };
  }

  // The liveness check sends a real (small) prompt, which itself costs tokens. If the
  // OAuth usage API tells us the subscription is already spent, the check can only fail
  // — so don't run it at all, and don't report a failure the user can't act on.
  // …unless the account and the CLI disagree about usage credits, in which case running it is
  // the only way to find out who's right — and the only thing that refreshes the CLI's cached
  // verdict. See creditGateMayBeStale().
  const cliExtraUsage = readCliExtraUsage(provider.configDir);
  if (isUsageExhausted(usageMetrics, cliExtraUsage.state) && !creditGateMayBeStale(usageMetrics, cliExtraUsage)) {
    return {
      providerId: provider.id,
      providerName: provider.name,
      providerType: "cli",
      authStatus: "ok",
      livenessStatus: "skipped",
      livenessSkipReason: describeUsageExhaustion(usageMetrics, cliExtraUsage),
      usageExhausted: true,
      healthy: false,
      checkedAt,
      usageMetrics,
      usageRateLimited,
    };
  }

  if (opts?.busy) {
    return {
      providerId: provider.id,
      providerName: provider.name,
      providerType: "cli",
      authStatus: "ok",
      livenessStatus: "skipped",
      livenessSkipReason: "Liveness check skipped: a task is currently running on this provider. Probing now would race the task's own token refresh and could report a false auth failure — it'll be checked again once the task finishes.",
      healthy: true,
      checkedAt,
      usageMetrics,
      usageRateLimited,
    };
  }

  // Disabled means "don't use this connection" — including here. See DISABLED_SKIP_REASON.
  if (!provider.isEnabled) {
    return {
      providerId: provider.id,
      providerName: provider.name,
      providerType: "cli",
      authStatus: "ok",
      livenessStatus: "skipped",
      livenessSkipReason: DISABLED_SKIP_REASON,
      healthy: true,
      checkedAt,
      isEnabled: false,
      usageMetrics,
      usageRateLimited,
    };
  }

  await ensureCredentialsOnDisk(provider, opts);
  const configDir = resolveConfigDir(provider.configDir);
  const liveness = await spawnCliCheck(configDir);

  // The CLI itself reported a usage/rate limit (e.g. we had no usage metrics to check
  // up-front, or the window tipped over between the two calls). Same story: this isn't
  // a liveness failure, it's an empty tank.
  if (!liveness.success && !liveness.isAuthError && liveness.limitMessage) {
    return {
      providerId: provider.id,
      providerName: provider.name,
      providerType: "cli",
      authStatus: "ok",
      livenessStatus: "skipped",
      livenessSkipReason: liveness.limitMessage,
      usageExhausted: true,
      healthy: false,
      checkedAt,
      usageMetrics,
      usageRateLimited,
    };
  }

  let livenessWarning: string | undefined;
  if (!liveness.success && !liveness.isAuthError) {
    if (usageMetrics) {
      // We have real usage data and it does NOT show exhaustion — so the failure
      // is unrelated to token/usage limits. Don't mislead the user.
      livenessWarning = "Liveness check failed, but usage looks normal. This may be a transient or unrelated CLI error.";
    } else {
      // No usage data available to confirm or rule out token exhaustion — fall
      // back to the best-effort hint.
      livenessWarning = "You may have run out of tokens on your Claude subscription";
    }
  }

  return {
    providerId: provider.id,
    providerName: provider.name,
    providerType: "cli",
    authStatus: liveness.isAuthError ? "error" : "ok",
    authError: liveness.isAuthError ? liveness.error : undefined,
    livenessStatus: liveness.success ? "ok" : "error",
    livenessError: liveness.success ? undefined : (liveness.isAuthError ? undefined : liveness.error),
    livenessWarning,
    healthy: liveness.success,
    checkedAt,
    usageMetrics,
    usageRateLimited,
  };
}

async function checkApiProvider(provider: DBProvider, healthModel?: string): Promise<ProviderHealthStatus> {
  const checkedAt = new Date().toISOString();

  if (!provider.apiKey) {
    return {
      providerId: provider.id,
      providerName: provider.name,
      providerType: "api",
      authStatus: "missing",
      authError: "No API key configured",
      livenessStatus: "skipped",
      healthy: false,
      checkedAt,
    };
  }

  const model = healthModel || provider.model || DEFAULT_HEALTH_MODELS.api;

  try {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({
      apiKey: provider.apiKey,
      ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}),
    });

    await Promise.race([
      client.messages.create({
        model,
        max_tokens: 10,
        messages: [{ role: "user", content: "Say OK" }],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Liveness check timed out after 30s")), HEALTH_CHECK_TIMEOUT_MS),
      ),
    ]);

    return {
      providerId: provider.id,
      providerName: provider.name,
      providerType: "api",
      authStatus: "ok",
      livenessStatus: "ok",
      healthy: true,
      checkedAt,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isAuth = msg.includes("401") || msg.includes("authentication") || msg.includes("API key");
    const usageLimit = isAuth ? null : detectUsageLimit(msg);
    return {
      providerId: provider.id,
      providerName: provider.name,
      providerType: "api",
      authStatus: isAuth ? "error" : "ok",
      authError: isAuth ? msg : undefined,
      livenessStatus: isAuth || usageLimit ? "skipped" : "error",
      livenessError: isAuth || usageLimit ? undefined : msg,
      livenessSkipReason: usageLimit ?? undefined,
      usageExhausted: usageLimit ? true : undefined,
      healthy: false,
      checkedAt,
    };
  }
}

async function checkOpenAIProvider(provider: DBProvider, healthModel?: string): Promise<ProviderHealthStatus> {
  const checkedAt = new Date().toISOString();

  if (!provider.apiKey) {
    return {
      providerId: provider.id,
      providerName: provider.name,
      providerType: "openai",
      authStatus: "missing",
      authError: "No API key configured",
      livenessStatus: "skipped",
      healthy: false,
      checkedAt,
    };
  }

  const model = healthModel || provider.model || DEFAULT_HEALTH_MODELS.openai;

  try {
    const OpenAI = (await import("openai")).default;
    const client = new OpenAI({
      apiKey: provider.apiKey,
      ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}),
    });

    await Promise.race([
      client.chat.completions.create({
        model,
        max_tokens: 10,
        messages: [{ role: "user", content: "Say OK" }],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Liveness check timed out after 30s")), HEALTH_CHECK_TIMEOUT_MS),
      ),
    ]);

    return {
      providerId: provider.id,
      providerName: provider.name,
      providerType: "openai",
      authStatus: "ok",
      livenessStatus: "ok",
      healthy: true,
      checkedAt,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isAuth = msg.includes("401") || msg.includes("authentication") || msg.includes("API key") || msg.includes("Incorrect API key");
    const usageLimit = isAuth ? null : detectUsageLimit(msg);
    return {
      providerId: provider.id,
      providerName: provider.name,
      providerType: "openai",
      authStatus: isAuth ? "error" : "ok",
      authError: isAuth ? msg : undefined,
      livenessStatus: isAuth || usageLimit ? "skipped" : "error",
      livenessError: isAuth || usageLimit ? undefined : msg,
      livenessSkipReason: usageLimit ?? undefined,
      usageExhausted: usageLimit ? true : undefined,
      healthy: false,
      checkedAt,
    };
  }
}

async function checkClaudePkiProvider(provider: DBProvider, healthModel?: string): Promise<ProviderHealthStatus> {
  const checkedAt = new Date().toISOString();

  if (!provider.pkiCertData) {
    return {
      providerId: provider.id,
      providerName: provider.name,
      providerType: "claude-pki",
      authStatus: "missing",
      authError: "No .p12 certificate uploaded",
      livenessStatus: "skipped",
      healthy: false,
      checkedAt,
    };
  }

  const model = healthModel || provider.model || DEFAULT_HEALTH_MODELS["claude-pki"];

  try {
    const { ClaudePkiProvider } = await import("./providers/claude-pki");
    const client = new ClaudePkiProvider(
      Buffer.from(provider.pkiCertData),
      provider.pkiCertPassphrase ?? undefined,
      provider.apiKey ?? undefined,
      model,
      provider.baseUrl ?? undefined,
      provider.proxyUrl ?? undefined,
    );
    const anthropicClient = client.buildClient();

    await Promise.race([
      anthropicClient.messages.create({
        model,
        max_tokens: 10,
        messages: [{ role: "user", content: "Say OK" }],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Liveness check timed out after 30s")), HEALTH_CHECK_TIMEOUT_MS),
      ),
    ]);

    return {
      providerId: provider.id,
      providerName: provider.name,
      providerType: "claude-pki",
      authStatus: "ok",
      livenessStatus: "ok",
      healthy: true,
      checkedAt,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isAuth = msg.includes("401") || msg.includes("403") || msg.includes("authentication")
      || msg.includes("certificate") || msg.includes("SSL") || msg.includes("TLS") || msg.includes("unable to verify");
    const usageLimit = isAuth ? null : detectUsageLimit(msg);
    return {
      providerId: provider.id,
      providerName: provider.name,
      providerType: "claude-pki",
      authStatus: isAuth ? "error" : "ok",
      authError: isAuth ? msg : undefined,
      livenessStatus: isAuth || usageLimit ? "skipped" : "error",
      livenessError: isAuth || usageLimit ? undefined : msg,
      livenessSkipReason: usageLimit ?? undefined,
      usageExhausted: usageLimit ? true : undefined,
      healthy: false,
      checkedAt,
    };
  }
}

/**
 * Health check for a Codex CLI connection.
 *
 * Mirrors `checkCliProvider` but against `codex` instead of `claude`. Codex app-server exposes
 * the ChatGPT primary and secondary rate-limit windows, which we translate to the same shape
 * the health UI already uses for Claude.
 */
/**
 * Codex's plan windows, translated into the shape the health UI already uses for Claude.
 * Read from the rate-limit snapshot Codex leaves in its config dir — a local file, so this
 * is free to call even for a connection we've decided not to spend anything on.
 */
export async function codexUsageMetrics(configDir: string | null): Promise<OAuthUsageMetrics | undefined> {
  const rateLimits = await readCodexRateLimits(configDir);
  const windows = [rateLimits?.primary, rateLimits?.secondary]
    .filter((window): window is NonNullable<typeof window> => !!window)
    .sort((a, b) => (a.windowDurationMins ?? 0) - (b.windowDurationMins ?? 0));
  if (windows.length < 2 || !windows[0].resetsAt || !windows[1].resetsAt) return undefined;
  return {
    five_hour: {
      utilization: windows[0].usedPercent,
      resets_at: new Date(windows[0].resetsAt * 1000).toISOString(),
    },
    seven_day: {
      utilization: windows[windows.length - 1].usedPercent,
      resets_at: new Date(windows[windows.length - 1].resetsAt! * 1000).toISOString(),
    },
  };
}

async function checkCodexCliProvider(provider: DBProvider, opts?: CliCheckOptions): Promise<ProviderHealthStatus> {
  const checkedAt = new Date().toISOString();
  const base = {
    providerId: provider.id,
    providerName: provider.name,
    providerType: "codex-cli" as const,
    checkedAt,
  };

  const credentialsJson = readCodexAuth(provider);
  if (!codexAuthLooksValid(credentialsJson)) {
    return {
      ...base,
      authStatus: "missing",
      authError: credentialsJson
        ? "~/.codex/auth.json is present but unreadable. Re-paste it in Settings → AI Providers."
        : "No Codex credentials. Run `codex login`, then paste ~/.codex/auth.json in Settings → AI Providers.",
      livenessStatus: "skipped",
      healthy: false,
    };
  }

  // Same race as the Claude CLI (see `CliCheckOptions.busy`): a running task and this probe
  // share one auth.json, and whichever refreshes second gets a genuine-looking 401 because
  // the refresh token was already rotated. The running task is proof the login works.
  if (opts?.busy) {
    return {
      ...base,
      authStatus: "ok",
      livenessStatus: "skipped",
      livenessSkipReason:
        "Liveness check skipped: a task is currently running on this provider. Probing now would race the task's own token refresh and could report a false auth failure — it'll be checked again once the task finishes.",
      healthy: true,
    };
  }

  // Disabled means "don't use this connection" — no prompt, and nothing written into
  // CODEX_HOME where an enabled connection would authenticate from. Usage still comes
  // through: Codex's rate-limit snapshot is a local file, so reading it costs nothing.
  // See DISABLED_SKIP_REASON.
  if (!provider.isEnabled) {
    return {
      ...base,
      authStatus: "ok",
      livenessStatus: "skipped",
      livenessSkipReason: DISABLED_SKIP_REASON,
      healthy: true,
      isEnabled: false,
      usageMetrics: await codexUsageMetrics(provider.configDir),
    };
  }

  // Put the DB copy on disk first — the probe authenticates from CODEX_HOME, not from us.
  if (provider.credentialsJson) {
    try {
      syncCredentialsToDisk({
        providerId: provider.id,
        dir: resolveCodexHome(provider.configDir),
        fileName: "auth.json",
        credentialsJson: provider.credentialsJson,
        expiresAtOf: extractCodexExpiresAt,
        otherProviderCredentials: opts?.otherProviderCredentials,
      });
    } catch (err) {
      return {
        ...base,
        authStatus: "error",
        authError: `Failed to write Codex auth.json: ${err instanceof Error ? err.message : String(err)}`,
        livenessStatus: "skipped",
        healthy: false,
      };
    }
  }

  const expiresAt = extractCodexExpiresAt(credentialsJson);
  if (expiresAt && expiresAt <= Date.now()) {
    return {
      ...base,
      authStatus: "error",
      authError: "Codex login has expired. Run `codex login` and re-paste ~/.codex/auth.json.",
      livenessStatus: "skipped",
      healthy: false,
    };
  }

  const usageMetrics = await codexUsageMetrics(provider.configDir);

  if (usageMetrics && isUsageExhausted(usageMetrics)) {
    return {
      ...base,
      authStatus: "ok",
      livenessStatus: "skipped",
      livenessSkipReason: describeUsageExhaustion(usageMetrics),
      usageExhausted: true,
      healthy: false,
      usageMetrics,
    };
  }

  const liveness = await probeCodexLiveness(provider.configDir, provider.model ?? undefined);
  if (liveness.ok) {
    return { ...base, authStatus: "ok", livenessStatus: "ok", healthy: true, usageMetrics };
  }

  // A missing binary is an auth-independent install problem — say so plainly rather than
  // blaming the credentials the user just pasted.
  if (liveness.notInstalled) {
    return {
      ...base,
      authStatus: "ok",
      livenessStatus: "error",
      livenessError: liveness.error,
      healthy: false,
      usageMetrics,
    };
  }

  if (liveness.limitMessage) {
    return {
      ...base,
      authStatus: "ok",
      livenessStatus: "skipped",
      livenessSkipReason: liveness.limitMessage,
      usageExhausted: true,
      healthy: false,
      usageMetrics,
    };
  }

  // Codex's WebSocket transport drops often enough that a couple of failed probes (it
  // already retried once internally) says more about the network than about this
  // connection. Report it as "couldn't check", not "your login is broken" — the same shape
  // as the busy case above, so the Hail Mary picker still skips it while it's unverified.
  if (liveness.isTransient) {
    return {
      ...base,
      authStatus: "ok",
      livenessStatus: "skipped",
      livenessSkipReason: `Liveness check couldn't reach Codex (${liveness.error}). This looks like a network problem rather than a problem with the connection — it'll be retried on the next check.`,
      healthy: true,
    };
  }

  return {
    ...base,
    authStatus: liveness.isAuthError ? "error" : "ok",
    authError: liveness.isAuthError ? liveness.error : undefined,
    livenessStatus: liveness.isAuthError ? "skipped" : "error",
    livenessError: liveness.isAuthError ? undefined : liveness.error,
    healthy: false,
    usageMetrics,
  };
}

export async function checkProvider(provider: DBProvider, healthModel?: string, cliOpts?: CliCheckOptions): Promise<ProviderHealthStatus> {
  if (provider.type === "cli") return checkCliProvider(provider, cliOpts);
  if (provider.type === "codex-cli") return checkCodexCliProvider(provider, cliOpts);
  if (provider.type === "api") return checkApiProvider(provider, healthModel);
  if (provider.type === "openai") return checkOpenAIProvider(provider, healthModel);
  if (provider.type === "claude-pki") return checkClaudePkiProvider(provider, healthModel);
  return {
    providerId: provider.id,
    providerName: provider.name,
    providerType: provider.type as "cli",
    authStatus: "error",
    authError: `Unknown provider type: ${provider.type}`,
    livenessStatus: "skipped",
    healthy: false,
    checkedAt: new Date().toISOString(),
  };
}
