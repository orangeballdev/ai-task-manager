/**
 * Ownership-aware credential sync for the subscription CLI providers (`cli`, `codex-cli`).
 *
 * Both CLIs authenticate from a file in a config directory — `~/.claude/.credentials.json`
 * and `$CODEX_HOME/auth.json` — not from anything we pass on the command line. So every run
 * is preceded by "push the DB copy to disk" and followed by "pull whatever the CLI rotated
 * back into the DB". Two connections that leave `configDir` blank share one directory, and
 * that is where this used to go wrong:
 *
 *  - the push was skipped whenever the on-disk file had a *later* expiry than the DB copy
 *    (a guard against clobbering a token the CLI had just rotated). Across two connections
 *    that reads as "connection B keeps connection A's login", so B's task runs on A's
 *    account — including when A is the connection the user just switched off.
 *  - the pull then wrote those same credentials onto B's row, making the swap permanent.
 *
 * The fix is to record *which provider a config dir currently holds the login for* in a
 * marker file next to the credentials, and to key both directions off it. A dir owned by
 * someone else is always overwritten (identity beats freshness); a dir owned by us keeps the
 * old expiry guard (that rotation really is ours); a dir with no marker — an install that
 * predates this file — falls back to the legacy expiry guard unless the bytes on disk are
 * recognisably another connection's stored login.
 *
 * The decision itself is pure (`decideCredentialWrite`) so it can be unit-tested without a
 * filesystem; `syncCredentialsToDisk` is the thin fs wrapper the worker and health checks use.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

/** Marker file recording which AIProvider id last pushed credentials into a config dir. */
export const CREDENTIAL_OWNER_FILE = ".task-manager-provider";

export interface CredentialWriteDecision {
  /** Whether the DB copy should be written over what's on disk. */
  write: boolean;
  /** Why — surfaced in logs so a surprising skip is explainable. */
  reason: string;
}

export interface DecideCredentialWriteInput {
  /** The provider about to run. */
  providerId: string;
  /** Its stored credentials (the DB copy). */
  dbCredentials?: string | null;
  /** What's currently in the config dir, if anything. */
  diskCredentials?: string | null;
  /** Contents of the owner marker in that dir, if present. */
  owner?: string | null;
  /**
   * Stored credentials of every *other* provider. Used only as a fallback identity check for
   * dirs with no owner marker: bytes that exactly match another connection's login are
   * definitely not a rotation of ours.
   */
  otherProviderCredentials?: (string | null | undefined)[];
  /** Expiry parser for this credential shape (Claude's `expiresAt`, Codex's JWT `exp`). */
  expiresAtOf: (credentialsJson: string) => number;
}

/**
 * Decide whether to push the DB copy of a provider's credentials over the config dir's
 * current contents. See the module comment for why identity beats freshness.
 */
export function decideCredentialWrite(input: DecideCredentialWriteInput): CredentialWriteDecision {
  const db = input.dbCredentials?.trim();
  if (!db) return { write: false, reason: "no stored credentials for this provider" };

  const disk = input.diskCredentials?.trim();
  if (!disk) return { write: true, reason: "no credentials on disk" };

  const owner = input.owner?.trim() || null;

  if (owner && owner !== input.providerId) {
    return { write: true, reason: "config dir currently holds another connection's login" };
  }

  if (!owner) {
    const foreign = (input.otherProviderCredentials ?? []).some(
      (other) => !!other?.trim() && other.trim() === disk,
    );
    if (foreign) {
      return { write: true, reason: "credentials on disk belong to another connection" };
    }
  }

  // Same provider (or an unattributable dir that isn't recognisably someone else's): keep a
  // token the CLI rotated after our last write, since overwriting it with the stale DB copy
  // burns the rotated refresh token and kills the session for good.
  if (expiresSafely(input.expiresAtOf, disk) > expiresSafely(input.expiresAtOf, db)) {
    return { write: false, reason: "on-disk credentials are newer than the stored copy" };
  }

  return { write: true, reason: "stored copy is current" };
}

function expiresSafely(expiresAtOf: (json: string) => number, json: string): number {
  try {
    return expiresAtOf(json) || 0;
  } catch {
    return 0;
  }
}

/** Read the owner marker from a config dir, or null when it has none. */
export function readCredentialOwner(dir: string): string | null {
  try {
    const value = readFileSync(join(dir, CREDENTIAL_OWNER_FILE), "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

/** Record that `providerId`'s login is what now sits in `dir`. Best-effort — never throws. */
export function claimCredentialOwner(dir: string, providerId: string): void {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, CREDENTIAL_OWNER_FILE), providerId, { encoding: "utf8", mode: 0o600 });
  } catch {
    /* non-fatal: the marker is an optimisation, not a correctness requirement for this run */
  }
}

/**
 * Whether credentials found in `dir` may be synced *back* onto this provider's row.
 *
 * Only when the dir is ours (we just claimed it) or entirely unattributed. Pulling from a dir
 * another connection owns is how one account's login ends up copied onto every provider row.
 */
export function canAdoptDiskCredentials(dir: string, providerId: string): boolean {
  const owner = readCredentialOwner(dir);
  return !owner || owner === providerId;
}

export interface SyncCredentialsInput {
  providerId: string;
  /** Directory the CLI authenticates from (already resolved to an absolute path). */
  dir: string;
  /** Credential file name inside it — `.credentials.json` or `auth.json`. */
  fileName: string;
  credentialsJson?: string | null;
  expiresAtOf: (credentialsJson: string) => number;
  otherProviderCredentials?: (string | null | undefined)[];
}

/**
 * Push a provider's stored credentials into its config dir when it's right to do so, and
 * claim ownership of the dir when we do. Returns the decision so callers can log a skip.
 */
export function syncCredentialsToDisk(input: SyncCredentialsInput): CredentialWriteDecision {
  const file = join(input.dir, input.fileName);

  let diskCredentials: string | null = null;
  try {
    diskCredentials = readFileSync(file, "utf8");
  } catch {
    diskCredentials = null;
  }

  const owner = readCredentialOwner(input.dir);
  const decision = decideCredentialWrite({
    providerId: input.providerId,
    dbCredentials: input.credentialsJson,
    diskCredentials,
    owner,
    otherProviderCredentials: input.otherProviderCredentials,
    expiresAtOf: input.expiresAtOf,
  });

  if (decision.write) {
    if (!existsSync(input.dir)) mkdirSync(input.dir, { recursive: true });
    writeFileSync(file, input.credentialsJson as string, { encoding: "utf8", mode: 0o600 });
    // The dir now demonstrably holds this provider's login.
    claimCredentialOwner(input.dir, input.providerId);
  }

  // A skipped write is deliberately *not* a claim: on an unattributed dir we can't prove the
  // fresher file is our own rotation, and claiming it would license syncing someone else's
  // token back onto this provider's row.

  return decision;
}
