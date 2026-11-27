import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { SETTINGS_INDEX, searchSettings } from "../../app/settings/settings-index";
import { SETTINGS_GROUPS, SETTINGS_PAGES, findSettingsPage } from "../../app/settings/settings-sections";

const SETTINGS_DIR = path.join(__dirname, "..", "..", "app", "settings");

test("every settings page appears once in the sidebar", () => {
  const hrefs = SETTINGS_PAGES.map((p) => p.href);
  assert.equal(new Set(hrefs).size, hrefs.length, "duplicate sidebar entry");
  for (const group of SETTINGS_GROUPS) assert.ok(group.pages.length > 0, `${group.label} is empty`);
  for (const href of hrefs) {
    const page = path.join(SETTINGS_DIR, href.replace("/settings/", ""), "page.tsx");
    assert.ok(existsSync(page), `${href} has no page.tsx`);
  }
});

test("every real settings route is reachable from the sidebar", () => {
  // Directories whose page only redirects to a consolidated page are exempt.
  const routes = readdirSync(SETTINGS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
    .filter((d) => existsSync(path.join(SETTINGS_DIR, d.name, "page.tsx")))
    .filter((d) => !/\bredirect\(/.test(readFileSync(path.join(SETTINGS_DIR, d.name, "page.tsx"), "utf8")))
    .map((d) => `/settings/${d.name}`);
  for (const route of routes) {
    assert.ok(findSettingsPage(route), `${route} is missing from SETTINGS_GROUPS`);
  }
});

test("search index entries point at a sidebar page and use its label as the section", () => {
  for (const entry of SETTINGS_INDEX) {
    const page = findSettingsPage(entry.href);
    assert.ok(page, `${entry.title}: ${entry.href} is not a settings page`);
    assert.equal(entry.section, page.label, `${entry.title}: section should be "${page.label}"`);
  }
});

// Pages whose anchor ids come from a registry rather than a literal.
const EXTRA_SOURCES: Record<string, string[]> = {
  "/settings/tools": [path.join(__dirname, "..", "agent-tools.ts")],
};

test("search index anchors exist on their page", () => {
  const sources = new Map<string, string>();
  const shared = readdirSync(path.join(SETTINGS_DIR, "_components"))
    .map((f) => readFileSync(path.join(SETTINGS_DIR, "_components", f), "utf8"))
    .join("\n");
  for (const entry of SETTINGS_INDEX) {
    if (!entry.anchor) continue;
    const dir = path.join(SETTINGS_DIR, entry.href.replace("/settings/", ""));
    if (!sources.has(dir)) {
      const files = readdirSync(dir).filter((f) => f.endsWith(".tsx"));
      const extra = (EXTRA_SOURCES[entry.href] ?? []).map((f) => readFileSync(f, "utf8"));
      sources.set(dir, [...files.map((f) => readFileSync(path.join(dir, f), "utf8")), ...extra, shared].join("\n"));
    }
    const src = sources.get(dir)!;
    assert.ok(
      src.includes(`"${entry.anchor}"`),
      `${entry.title}: anchor #${entry.anchor} not found under ${entry.href}`,
    );
  }
});

test("findSettingsPage matches exact and nested routes only", () => {
  assert.equal(findSettingsPage("/settings/mcp")?.label, "MCP Access");
  assert.equal(findSettingsPage("/settings/mcp-servers")?.label, "MCP Servers");
  assert.equal(findSettingsPage("/settings/integrations/slack")?.href, "/settings/integrations");
  assert.equal(findSettingsPage("/settings/layout"), undefined);
});

test("settings moved into General are still searchable", () => {
  assert.equal(searchSettings("app host")[0]?.href, "/settings/general");
  assert.equal(searchSettings("grid")[0]?.anchor, "card-arrangement");
  assert.ok(searchSettings("appearance").length >= 3);
});
