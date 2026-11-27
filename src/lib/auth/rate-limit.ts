// In-memory brute-force guard for the sign-in endpoints. Counts *failed* attempts
// per key (client IP, and IP+email) in a sliding window; once a key reaches its
// limit, further attempts are refused until the oldest failure ages out. A
// successful sign-in clears the IP+email key. Pure apart from the module-level
// store, with an injectable clock — unit-tested.

export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

export const LOGIN_RULES = {
  /** Any account, from one IP. */
  ip: { limit: 30, windowMs: 15 * 60 * 1000 },
  /** One account, from one IP. */
  account: { limit: 8, windowMs: 15 * 60 * 1000 },
  /**
   * One account, from anywhere. X-Forwarded-For can be forged when the app isn't
   * behind a proxy that overwrites it, so the per-IP rules alone can be dodged.
   * Only password sign-in is limited — passkey sign-in keeps working.
   */
  email: { limit: 25, windowMs: 15 * 60 * 1000 },
} satisfies Record<string, RateLimitRule>;

export class FailureLimiter {
  private failures = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  private recent(key: string, rule: RateLimitRule): number[] {
    const cutoff = this.now() - rule.windowMs;
    const list = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }

  /** Milliseconds until the key may try again, or 0 when it isn't blocked. */
  retryAfterMs(key: string, rule: RateLimitRule): number {
    const list = this.recent(key, rule);
    if (list.length < rule.limit) return 0;
    return Math.max(1, list[list.length - rule.limit] + rule.windowMs - this.now());
  }

  recordFailure(key: string, rule: RateLimitRule): void {
    const list = this.recent(key, rule);
    list.push(this.now());
    // Never keep more than needed to decide.
    this.failures.set(key, list.slice(-rule.limit));
    if (this.failures.size > 10_000) this.prune();
  }

  clear(key: string): void {
    this.failures.delete(key);
  }

  private prune(): void {
    const cutoff = this.now() - 60 * 60 * 1000;
    for (const [k, list] of this.failures) {
      if (!list.length || list[list.length - 1] < cutoff) this.failures.delete(k);
    }
  }
}

const globalForLimiter = globalThis as unknown as { __authLimiter?: FailureLimiter };
export const loginLimiter: FailureLimiter = (globalForLimiter.__authLimiter ??= new FailureLimiter());
