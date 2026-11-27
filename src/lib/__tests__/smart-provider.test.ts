/**
 * Unit tests for the smart provider picker — specifically the rule that a disabled AI
 * connection must never be selected to run a task, no matter how well it would otherwise
 * score (e.g. soonest-expiring CLI credentials, or being the only configured provider).
 *
 * Run with:
 *   npm test
 *   # or directly:
 *   npx tsx --test src/lib/__tests__/smart-provider.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { pickSmartProvider, getProvider, rankProvidersForSmartMode, type UsageLookup } from "../smart-provider.js";
import type { OAuthUsageMetrics } from "../health-check.js";

// Never reach the real usage API (or ~/.claude) from tests: by default no figures are known.
const noUsage: UsageLookup = async () => null;

function usageRenewingAt(sevenDayResetsAt: number, utilization = 10, fiveHourResetsAt = Date.now() + 3_600_000): OAuthUsageMetrics {
  return {
    five_hour: { utilization, resets_at: new Date(fiveHourResetsAt).toISOString() },
    seven_day: { utilization, resets_at: new Date(sevenDayResetsAt).toISOString() },
  };
}

function usageById(map: Record<string, OAuthUsageMetrics | null>): UsageLookup {
  return async (p) => map[p.id] ?? null;
}

type FakeProvider = {
  id: string;
  name: string;
  type: string;
  isEnabled: boolean;
  isDefault?: boolean;
  excludeFromSmartPicker?: boolean;
  throttledUntil?: Date | null;
  credentialsJson?: string | null;
  configDir?: string | null;
  createdAt?: Date;
};

/** Minimal prisma stub exposing only what pickSmartProvider touches. */
function makePrismaStub(providers: FakeProvider[]) {
  return {
    aIProvider: {
      // Mirrors `findMany({ where: { isEnabled: true }, orderBy: { createdAt: "asc" } })` —
      // the where/orderBy args aren't inspected since this stub only ever gets called that
      // one way, but we still apply the isEnabled filter so a regression that drops the
      // real query's filter is caught by callers of this stub, not hidden here.
      findMany: async ({ where }: { where?: { isEnabled?: boolean } }) => {
        let result = providers.slice();
        if (where?.isEnabled !== undefined) {
          result = result.filter((p) => p.isEnabled === where.isEnabled);
        }
        result.sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
        return result;
      },
    },
  };
}

type FindFirstWhere = {
  id?: { not?: string };
  isEnabled?: boolean;
  isDefault?: boolean;
  type?: string;
  throttledUntil?: { not?: null; lte?: Date } | null;
  OR?: { throttledUntil?: null | { lte?: Date } }[];
};

/**
 * Prisma stub covering the queries getProvider issues: the findMany pickSmartProvider uses,
 * plus findUnique/findFirst and the smart_provider_picker setting lookup.
 */
function makeGetProviderStub(providers: FakeProvider[], settings: Record<string, string> = {}) {
  const matches = (p: FakeProvider, where: FindFirstWhere = {}): boolean => {
    if (where.id?.not !== undefined && p.id === where.id.not) return false;
    if (where.isEnabled !== undefined && p.isEnabled !== where.isEnabled) return false;
    if (where.isDefault !== undefined && Boolean(p.isDefault) !== where.isDefault) return false;
    if (where.type !== undefined && p.type !== where.type) return false;
    if (where.throttledUntil && "not" in where.throttledUntil && where.throttledUntil.not === null) {
      if (!p.throttledUntil) return false;
    }
    if (where.OR) {
      const ok = where.OR.some((clause) => {
        if (clause.throttledUntil === null) return !p.throttledUntil;
        if (clause.throttledUntil?.lte) {
          return !!p.throttledUntil && p.throttledUntil.getTime() <= clause.throttledUntil.lte.getTime();
        }
        return false;
      });
      if (!ok) return false;
    }
    return true;
  };

  return {
    ...makePrismaStub(providers),
    aIProvider: {
      ...makePrismaStub(providers).aIProvider,
      findUnique: async ({ where }: { where: { id: string } }) =>
        providers.find((p) => p.id === where.id) ?? null,
      findFirst: async ({ where, orderBy }: { where?: FindFirstWhere; orderBy?: Record<string, "asc" | "desc"> } = {}) => {
        const result = providers.filter((p) => matches(p, where));
        if (orderBy?.throttledUntil === "asc") {
          result.sort((a, b) => (a.throttledUntil?.getTime() ?? 0) - (b.throttledUntil?.getTime() ?? 0));
        } else {
          result.sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
        }
        return result[0] ?? null;
      },
    },
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        where.key in settings ? { key: where.key, value: settings[where.key] } : null,
    },
  };
}

function credentialsExpiringAt(expiresAt: number): string {
  return JSON.stringify({ claudeAiOauth: { expiresAt } });
}

describe("pickSmartProvider", () => {
  it("never picks a disabled provider, even when it's the only one configured", async () => {
    const prisma = makePrismaStub([
      { id: "disabled-1", name: "Disabled", type: "cli", isEnabled: false },
    ]);

    const picked = await pickSmartProvider(prisma, new Date(), { usageLookup: noUsage });
    assert.equal(picked, null);
  });

  it("skips a disabled provider in favor of an enabled one, even if the disabled one would score better", async () => {
    const now = Date.now();
    const prisma = makePrismaStub([
      // Disabled CLI provider with credentials expiring very soon — would win on score
      // alone if isEnabled weren't checked.
      {
        id: "disabled-soon",
        name: "Disabled (expires soon)",
        type: "cli",
        isEnabled: false,
        credentialsJson: credentialsExpiringAt(now + 1000),
        createdAt: new Date(0),
      },
      {
        id: "enabled-later",
        name: "Enabled (expires later)",
        type: "cli",
        isEnabled: true,
        credentialsJson: credentialsExpiringAt(now + 100_000),
        createdAt: new Date(1),
      },
    ]);

    const picked = await pickSmartProvider(prisma, new Date(), { usageLookup: noUsage });
    assert.equal(picked, "enabled-later");
  });

  it("picks the enabled CLI provider whose credentials expire soonest", async () => {
    const now = Date.now();
    const prisma = makePrismaStub([
      {
        id: "expires-later",
        name: "Expires later",
        type: "cli",
        isEnabled: true,
        credentialsJson: credentialsExpiringAt(now + 100_000),
        createdAt: new Date(0),
      },
      {
        id: "expires-soonest",
        name: "Expires soonest",
        type: "cli",
        isEnabled: true,
        credentialsJson: credentialsExpiringAt(now + 1_000),
        createdAt: new Date(1),
      },
    ]);

    const picked = await pickSmartProvider(prisma, new Date(), { usageLookup: noUsage });
    assert.equal(picked, "expires-soonest");
  });

  it("skips throttled providers even when enabled", async () => {
    const now = Date.now();
    const prisma = makePrismaStub([
      {
        id: "throttled",
        name: "Throttled",
        type: "api",
        isEnabled: true,
        throttledUntil: new Date(now + 60_000),
        createdAt: new Date(0),
      },
      {
        id: "available",
        name: "Available",
        type: "api",
        isEnabled: true,
        throttledUntil: null,
        createdAt: new Date(1),
      },
    ]);

    const picked = await pickSmartProvider(prisma, new Date(), { usageLookup: noUsage });
    assert.equal(picked, "available");
  });

  it("skips a provider marked excludeFromSmartPicker even when it would otherwise score best", async () => {
    const now = Date.now();
    const prisma = makePrismaStub([
      // Would win on score alone (expires soonest) if the exclude flag weren't checked.
      {
        id: "excluded-soon",
        name: "Excluded (expires soon)",
        type: "cli",
        isEnabled: true,
        excludeFromSmartPicker: true,
        credentialsJson: credentialsExpiringAt(now + 1_000),
        createdAt: new Date(0),
      },
      {
        id: "included-later",
        name: "Included (expires later)",
        type: "cli",
        isEnabled: true,
        credentialsJson: credentialsExpiringAt(now + 100_000),
        createdAt: new Date(1),
      },
    ]);

    const picked = await pickSmartProvider(prisma, new Date(), { usageLookup: noUsage });
    assert.equal(picked, "included-later");
  });

  it("returns null when the only enabled provider is excluded from smart picking", async () => {
    const prisma = makePrismaStub([
      { id: "excluded", name: "Excluded", type: "cli", isEnabled: true, excludeFromSmartPicker: true },
    ]);

    const picked = await pickSmartProvider(prisma, new Date(), { usageLookup: noUsage });
    assert.equal(picked, null);
  });

  it("returns null when every enabled provider is throttled", async () => {
    const now = Date.now();
    const prisma = makePrismaStub([
      { id: "throttled-api", name: "Throttled", type: "api", isEnabled: true, throttledUntil: new Date(now + 60_000), createdAt: new Date(0) },
      { id: "throttled-cli", name: "Throttled CLI", type: "cli", isEnabled: true, throttledUntil: new Date(now + 60_000), createdAt: new Date(1) },
    ]);

    const picked = await pickSmartProvider(prisma, new Date(), { usageLookup: noUsage });
    assert.equal(picked, null);
  });

  it("still picks a CLI provider whose stored access token has expired (the CLI refreshes it)", async () => {
    // Regression: an expired access token used to drop the account entirely, so two Claude
    // accounts with stale stored tokens left the smart picker empty and the default ran.
    const now = Date.now();
    const prisma = makePrismaStub([
      { id: "api", name: "API", type: "api", isEnabled: true, createdAt: new Date(0) },
      { id: "expired-cli", name: "Expired CLI", type: "cli", isEnabled: true, credentialsJson: credentialsExpiringAt(now - 1_000), createdAt: new Date(1) },
    ]);

    const picked = await pickSmartProvider(prisma, new Date(), { usageLookup: noUsage });
    assert.equal(picked, "expired-cli");
  });

  it("prefers the Claude account whose weekly usage renews soonest, regardless of token expiry", async () => {
    const now = Date.now();
    const day = 86_400_000;
    const prisma = makePrismaStub([
      // Created first and its access token expires sooner — the old ordering would pick it.
      { id: "default-acct", name: "Default", type: "cli", isEnabled: true, isDefault: true, credentialsJson: credentialsExpiringAt(now + 1_000), createdAt: new Date(0) },
      { id: "renews-soon", name: "Renews soon", type: "cli", isEnabled: true, credentialsJson: credentialsExpiringAt(now - 1_000), createdAt: new Date(1) },
    ]);

    const picked = await pickSmartProvider(prisma, new Date(now), {
      usageLookup: usageById({
        "default-acct": usageRenewingAt(now + 5 * day),
        "renews-soon": usageRenewingAt(now + 1 * day),
      }),
    });
    assert.equal(picked, "renews-soon");
  });

  it("skips an account whose usage is spent in favour of one that still has capacity", async () => {
    const now = Date.now();
    const day = 86_400_000;
    const prisma = makePrismaStub([
      { id: "spent", name: "Spent", type: "cli", isEnabled: true, configDir: "/nonexistent-test-dir", createdAt: new Date(0) },
      { id: "fresh", name: "Fresh", type: "cli", isEnabled: true, configDir: "/nonexistent-test-dir", createdAt: new Date(1) },
    ]);

    const picked = await pickSmartProvider(prisma, new Date(now), {
      usageLookup: usageById({
        spent: usageRenewingAt(now + 1 * day, 100),
        fresh: usageRenewingAt(now + 6 * day, 20),
      }),
    });
    assert.equal(picked, "fresh");
  });

  it("ranks accounts with known usage ahead of ones whose usage couldn't be read", async () => {
    const now = Date.now();
    const prisma = makePrismaStub([
      { id: "unknown", name: "Unknown", type: "cli", isEnabled: true, credentialsJson: credentialsExpiringAt(now + 1_000), createdAt: new Date(0) },
      { id: "known", name: "Known", type: "cli", isEnabled: true, createdAt: new Date(1) },
    ]);

    const picked = await pickSmartProvider(prisma, new Date(now), {
      usageLookup: usageById({ known: usageRenewingAt(now + 6 * 86_400_000) }),
    });
    assert.equal(picked, "known");
  });
});

it("getProvider's smart pick beats the default when another account renews sooner", async () => {
  const now = Date.now();
  const prisma = makeGetProviderStub(
    [
      { id: "default-acct", name: "Default", type: "cli", isEnabled: true, isDefault: true, createdAt: new Date(0) },
      { id: "renews-soon", name: "Renews soon", type: "cli", isEnabled: true, createdAt: new Date(1) },
    ],
    { smart_provider_picker: "true" },
  );

  const { provider, source } = await getProvider(
    {
      now: new Date(now),
      usageLookup: usageById({
        "default-acct": usageRenewingAt(now + 5 * 86_400_000),
        "renews-soon": usageRenewingAt(now + 86_400_000),
      }),
    },
    prisma,
  );
  assert.equal(provider?.id, "renews-soon");
  assert.equal(source, "smart");
});

describe("getProvider", () => {
  const soon = () => new Date(Date.now() + 60_000);

  it("uses an explicitly chosen provider even when smart picking is enabled", async () => {
    const prisma = makeGetProviderStub(
      [
        { id: "chosen", name: "Chosen", type: "cli", isEnabled: true, createdAt: new Date(1) },
        { id: "smarter", name: "Smarter", type: "cli", isEnabled: true, isDefault: true, createdAt: new Date(0) },
      ],
      { smart_provider_picker: "true" },
    );

    const { provider } = await getProvider({ usageLookup: noUsage, explicitProviderId: "chosen" }, prisma);
    assert.equal(provider?.id, "chosen");
  });

  it("falls through to another provider when the explicit one is disabled", async () => {
    const prisma = makeGetProviderStub([
      { id: "disabled", name: "Disabled", type: "cli", isEnabled: false },
      { id: "enabled-default", name: "Default", type: "cli", isEnabled: true, isDefault: true, createdAt: new Date(0) },
    ]);

    const { provider } = await getProvider({ usageLookup: noUsage, explicitProviderId: "disabled" }, prisma);
    assert.equal(provider?.id, "enabled-default");
  });

  it("switches away from a throttled explicit provider by default", async () => {
    const prisma = makeGetProviderStub([
      { id: "throttled", name: "Throttled", type: "cli", isEnabled: true, throttledUntil: soon(), createdAt: new Date(0) },
      { id: "available", name: "Available", type: "cli", isEnabled: true, createdAt: new Date(1) },
    ]);

    const { provider, throttledFallback } = await getProvider({ usageLookup: noUsage, explicitProviderId: "throttled" }, prisma);
    assert.equal(provider?.id, "available");
    assert.equal(throttledFallback, null);
  });

  it("waits on a throttled explicit provider when autoSwitch is off", async () => {
    const prisma = makeGetProviderStub([
      { id: "throttled", name: "Throttled", type: "cli", isEnabled: true, throttledUntil: soon(), createdAt: new Date(0) },
      { id: "available", name: "Available", type: "cli", isEnabled: true, createdAt: new Date(1) },
    ]);

    const { provider, throttledFallback } = await getProvider(
      { explicitProviderId: "throttled", autoSwitch: false, usageLookup: noUsage },
      prisma,
    );
    assert.equal(provider, null);
    assert.equal(throttledFallback?.id, "throttled");
  });

  it("falls back to any enabled provider when the default is disabled", async () => {
    const prisma = makeGetProviderStub([
      { id: "disabled-default", name: "Disabled default", type: "cli", isEnabled: false, isDefault: true },
      { id: "enabled-other", name: "Other", type: "cli", isEnabled: true, createdAt: new Date(0) },
    ]);

    const { provider } = await getProvider({ usageLookup: noUsage }, prisma);
    assert.equal(provider?.id, "enabled-other");
  });

  it("skips a provider excluded from smart picking in favor of the next-best pick", async () => {
    const prisma = makeGetProviderStub(
      [
        { id: "excluded", name: "Excluded", type: "cli", isEnabled: true, excludeFromSmartPicker: true, createdAt: new Date(0) },
        { id: "eligible", name: "Eligible", type: "cli", isEnabled: true, createdAt: new Date(1) },
      ],
      { smart_provider_picker: "true" },
    );

    const { provider, source } = await getProvider({ usageLookup: noUsage }, prisma);
    assert.equal(provider?.id, "eligible");
    assert.equal(source, "smart");
  });

  it("still uses a smart-picker-excluded provider explicitly or as the default", async () => {
    const prisma = makeGetProviderStub(
      [{ id: "excluded-default", name: "Excluded default", type: "cli", isEnabled: true, isDefault: true, excludeFromSmartPicker: true, createdAt: new Date(0) }],
      { smart_provider_picker: "true" },
    );

    // Excluding a provider from the smart picker doesn't disable it — it's still the default.
    const viaSmart = await getProvider({ usageLookup: noUsage }, prisma);
    assert.equal(viaSmart.provider?.id, "excluded-default");
    assert.equal(viaSmart.source, "default");

    // And it's still selectable explicitly.
    const viaExplicit = await getProvider({ usageLookup: noUsage, explicitProviderId: "excluded-default" }, prisma);
    assert.equal(viaExplicit.provider?.id, "excluded-default");
    assert.equal(viaExplicit.source, "explicit");
  });

  it("reports the soonest-resetting provider when everything is throttled", async () => {
    const prisma = makeGetProviderStub(
      [
        { id: "later", name: "Later", type: "cli", isEnabled: true, throttledUntil: new Date(Date.now() + 600_000), createdAt: new Date(0) },
        { id: "sooner", name: "Sooner", type: "cli", isEnabled: true, throttledUntil: new Date(Date.now() + 60_000), createdAt: new Date(1) },
      ],
      { smart_provider_picker: "true" },
    );

    const { provider, throttledFallback } = await getProvider({ usageLookup: noUsage, useSmartProvider: true }, prisma);
    assert.equal(provider, null);
    assert.equal(throttledFallback?.id, "sooner");
  });

  it("returns nothing at all when no provider is configured", async () => {
    const prisma = makeGetProviderStub([]);

    const { provider, throttledFallback } = await getProvider({ usageLookup: noUsage }, prisma);
    assert.equal(provider, null);
    assert.equal(throttledFallback, null);
  });

  it("restricts to the requested provider type, ignoring a disabled one of that type", async () => {
    const prisma = makeGetProviderStub([
      { id: "cli-default", name: "CLI", type: "cli", isEnabled: true, isDefault: true, createdAt: new Date(0) },
      { id: "api-disabled", name: "API disabled", type: "api", isEnabled: false, createdAt: new Date(1) },
      { id: "api-live", name: "API live", type: "api", isEnabled: true, createdAt: new Date(2) },
    ]);

    // Without a type filter the enabled default (a CLI provider) wins.
    assert.equal((await getProvider({ usageLookup: noUsage }, prisma)).provider?.id, "cli-default");
    // With one, only enabled providers of that type are eligible.
    assert.equal((await getProvider({ usageLookup: noUsage, type: "api" }, prisma)).provider?.id, "api-live");
  });
});

describe("rankProvidersForSmartMode", () => {
  const NOW = new Date("2026-01-01T00:00:00Z");
  const DAY = 24 * 60 * 60 * 1000;
  const inDays = (n: number) => new Date(NOW.getTime() + n * DAY);
  const provider = (id: string, remainingPercent: number | null, renewsAt: Date | null) => ({
    id,
    isEnabled: true,
    remainingPercent,
    renewsAt,
  });
  const topId = (providers: Parameters<typeof rankProvidersForSmartMode>[0]) =>
    rankProvidersForSmartMode(providers, NOW)[0]?.id;

  it("picks the provider renewing soonest over one with slightly more left", () => {
    assert.equal(topId([provider("B", 45, inDays(5)), provider("A", 50, inDays(2))]), "A");
  });

  it("picks the provider renewing soonest even when it has far less left", () => {
    assert.equal(topId([provider("B", 90, inDays(5)), provider("A", 5, inDays(2))]), "A");
  });

  it("skips a provider with 0% remaining", () => {
    assert.equal(topId([provider("A", 0, inDays(1)), provider("B", 40, inDays(3))]), "B");
  });

  it("breaks a renewal-time tie by the higher remaining percentage", () => {
    assert.equal(topId([provider("A", 30, inDays(2)), provider("B", 60, inDays(2))]), "B");
  });

  it("ranks a provider without a renewal date after one that has one", () => {
    assert.equal(topId([provider("A", 90, null), provider("B", 10, inDays(6))]), "B");
  });

  it("drops disabled, throttled and unavailable providers", () => {
    const ranked = rankProvidersForSmartMode(
      [
        { ...provider("disabled", 50, inDays(1)), isEnabled: false },
        { ...provider("throttled", 50, inDays(1)), throttledUntil: inDays(1) },
        { ...provider("spent", 50, inDays(1)), available: false },
        provider("ok", 50, inDays(4)),
      ],
      NOW,
    );
    assert.deepEqual(ranked.map((p) => p.id), ["ok"]);
  });

  it("treats a renewal date in the past as no renewal date", () => {
    assert.equal(topId([provider("stale", 50, inDays(-1)), provider("fresh", 50, inDays(3))]), "fresh");
  });
});

it("pickSmartProvider breaks a renewal tie by remaining percentage", async () => {
  const renews = Date.now() + 2 * 24 * 60 * 60 * 1000;
  const client = makePrismaStub([
    { id: "low", name: "low", type: "cli", isEnabled: true, createdAt: new Date(1) },
    { id: "high", name: "high", type: "cli", isEnabled: true, createdAt: new Date(2) },
  ]);
  const picked = await pickSmartProvider(client, new Date(), {
    usageLookup: usageById({ low: usageRenewingAt(renews, 70), high: usageRenewingAt(renews, 40) }),
  });
  assert.equal(picked, "high");
});
