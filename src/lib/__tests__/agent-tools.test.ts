/**
 * Unit tests for per-task agent tool access (src/lib/agent-tools.ts).
 *
 * Run with:
 *   npx tsx --test src/lib/__tests__/agent-tools.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_TOOL_SECRET_KEYS,
  GITHUB_CLI_TOOL_ID,
  applyEnvOverlay,
  buildToolAccessPrompt,
  getAgentTool,
  githubTokenLinks,
  normalizeToolAccess,
  resolveToolAccess,
  serializeToolAccess,
} from "../agent-tools";

describe("normalizeToolAccess", () => {
  it("keeps known tools with boolean-ish values", () => {
    assert.deepEqual(normalizeToolAccess({ [GITHUB_CLI_TOOL_ID]: true }), { [GITHUB_CLI_TOOL_ID]: true });
    assert.deepEqual(normalizeToolAccess({ [GITHUB_CLI_TOOL_ID]: "deny" }), { [GITHUB_CLI_TOOL_ID]: false });
    assert.deepEqual(normalizeToolAccess({ [GITHUB_CLI_TOOL_ID]: "true" }), { [GITHUB_CLI_TOOL_ID]: true });
  });

  it("parses stored JSON strings", () => {
    assert.deepEqual(normalizeToolAccess(`{"${GITHUB_CLI_TOOL_ID}":false}`), { [GITHUB_CLI_TOOL_ID]: false });
  });

  it("drops unknown tools, junk values and bad input", () => {
    assert.deepEqual(normalizeToolAccess({ "aws-cli-not-yet": true, [GITHUB_CLI_TOOL_ID]: "maybe" }), {});
    assert.deepEqual(normalizeToolAccess("not json"), {});
    assert.deepEqual(normalizeToolAccess(null), {});
    assert.deepEqual(normalizeToolAccess([true]), {});
    assert.deepEqual(normalizeToolAccess(""), {});
  });
});

describe("serializeToolAccess", () => {
  it("stores an empty map as null so the task follows defaults", () => {
    assert.equal(serializeToolAccess({}), null);
    assert.equal(serializeToolAccess(undefined), null);
  });
  it("round-trips explicit choices", () => {
    const s = serializeToolAccess({ [GITHUB_CLI_TOOL_ID]: true });
    assert.deepEqual(normalizeToolAccess(s), { [GITHUB_CLI_TOOL_ID]: true });
  });
});

describe("resolveToolAccess", () => {
  const gh = (r: ReturnType<typeof resolveToolAccess>) => r.find((x) => x.tool.id === GITHUB_CLI_TOOL_ID)!;

  it("denies by default when nothing is configured", () => {
    const r = gh(resolveToolAccess(null, null));
    assert.equal(r.granted, false);
    assert.equal(r.source, "default");
  });

  it("follows the global default when the task has no override", () => {
    const r = gh(resolveToolAccess(null, { [GITHUB_CLI_TOOL_ID]: true }));
    assert.equal(r.granted, true);
    assert.equal(r.source, "default");
  });

  it("a task override beats the default in either direction", () => {
    assert.equal(gh(resolveToolAccess({ [GITHUB_CLI_TOOL_ID]: false }, { [GITHUB_CLI_TOOL_ID]: true })).granted, false);
    const allowed = gh(resolveToolAccess({ [GITHUB_CLI_TOOL_ID]: true }, { [GITHUB_CLI_TOOL_ID]: false }));
    assert.equal(allowed.granted, true);
    assert.equal(allowed.source, "task");
  });
});

describe("applyEnvOverlay", () => {
  it("unsets, then sets, then prepends PATH without mutating the base", () => {
    const base: Record<string, string | undefined> = { PATH: "/usr/bin", GH_TOKEN: "host-token", KEEP: "1" };
    const env = applyEnvOverlay(base, { set: { GITHUB_TOKEN: "task-token" }, unset: ["GH_TOKEN", "GITHUB_TOKEN"], prependPath: ["/tmp/shims"] });
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal("GH_TOKEN" in env, false);
    assert.equal(env.GITHUB_TOKEN, "task-token");
    assert.equal(env.KEEP, "1");
    assert.equal(env.PATH, "/tmp/shims:/usr/bin");
    assert.equal(base.GH_TOKEN, "host-token");
  });

  it("returns the base unchanged without an overlay", () => {
    const base = { A: "1" };
    assert.equal(applyEnvOverlay(base, undefined), base);
  });
});

describe("registry", () => {
  it("masks the GitHub CLI token", () => {
    assert.ok(AGENT_TOOL_SECRET_KEYS.includes("github_cli_token"));
  });
  it("strips every GitHub token env var when denied", () => {
    const tool = getAgentTool(GITHUB_CLI_TOOL_ID)!;
    for (const v of ["GH_TOKEN", "GITHUB_TOKEN"]) assert.ok(tool.credentialEnv.includes(v));
  });
});

describe("githubTokenLinks", () => {
  it("pre-fills the fine-grained and classic token pages", () => {
    const { fineGrained, classic } = githubTokenLinks();
    const fg = new URL(fineGrained);
    assert.equal(fg.pathname, "/settings/personal-access-tokens/new");
    assert.equal(fg.searchParams.get("issues"), "write");
    const cl = new URL(classic);
    assert.equal(cl.pathname, "/settings/tokens/new");
    assert.ok(cl.searchParams.get("scopes")?.includes("repo"));
  });
});

describe("buildToolAccessPrompt", () => {
  const tool = getAgentTool(GITHUB_CLI_TOOL_ID)!;
  it("describes granted, unavailable and denied tools", () => {
    assert.match(buildToolAccessPrompt([{ tool, granted: true, available: true }]), /GRANTED/);
    assert.match(buildToolAccessPrompt([{ tool, granted: true, available: false, note: "no token" }]), /NOT usable.*no token/);
    assert.match(buildToolAccessPrompt([{ tool, granted: false, available: false }]), /NOT granted/);
  });
  it("is empty with nothing to report", () => {
    assert.equal(buildToolAccessPrompt([]), "");
  });
});
