/**
 * Knowledge management utilities.
 *
 * Knowledge entries are scoped per git remote URL/name (e.g. "github.com/acme/widgets")
 * or to the special scope "general" which acts as a catch-all. Entries have a `type`
 * (task_history or design_spec), markdown content, and freeform tags.
 *
 * Agents may call `queryKnowledge(scope, query?)` at task start to retrieve relevant
 * entries. The scope is typically inferred from the current working directory's git
 * remote via `inferScopeFromCwd()`.
 */

import { execSync } from "child_process";
import { prisma } from "./db";
import { GENERAL_SCOPE, normalizeScope } from "./git-urls";

export type KnowledgeType = "task_history" | "design_spec";

export const KNOWLEDGE_TYPES: KnowledgeType[] = ["task_history", "design_spec"];
// Scope helpers live in the dependency-free git-urls module so pure logic (e.g.
// per-repo concurrency limits) can normalize repo URLs without importing the
// Prisma client. Re-exported here because "scope" is a knowledge-library
// concept and this has always been its import path.
export { GENERAL_SCOPE, normalizeScope } from "./git-urls";

/**
 * Master setting key that enables/disables the entire knowledge feature —
 * the Knowledge library UI, its API routes, and automatic knowledge capture
 * after task completion. Defaults to enabled (opt-out); only an explicit
 * "false" turns it off.
 */
export const KNOWLEDGE_ENABLED_KEY = "knowledge_enabled";

// Prisma-like client so callers can pass either the shared client or a
// worker/test-injected one without a type dependency on the generated client.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SettingClient = { setting: { findUnique: (args: any) => Promise<{ value: string } | null> } };

/**
 * Whether the knowledge functionality is enabled. Defaults to `true` when the
 * setting is unset or the lookup fails, so existing installs keep working.
 */
export async function isKnowledgeEnabled(
  client: SettingClient = prisma as unknown as SettingClient,
): Promise<boolean> {
  try {
    const row = await client.setting.findUnique({ where: { key: KNOWLEDGE_ENABLED_KEY } });
    return row?.value !== "false";
  } catch {
    return true;
  }
}

export interface KnowledgeEntry {
  id: string;
  scope: string;
  type: KnowledgeType;
  title: string;
  content: string;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

interface RawKnowledgeEntry {
  id: string;
  scope: string;
  type: string;
  title: string;
  content: string;
  tags: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function parseTags(tags: string | null | undefined): string[] {
  if (!tags) return [];
  try {
    const parsed = JSON.parse(tags);
    if (Array.isArray(parsed)) return parsed.map(String);
    return [];
  } catch {
    return [];
  }
}

export function serializeTags(tags: string[] | undefined | null): string | null {
  if (!tags || tags.length === 0) return null;
  return JSON.stringify(tags.map((t) => String(t).trim()).filter(Boolean));
}

export function toKnowledgeEntry(row: RawKnowledgeEntry): KnowledgeEntry {
  return {
    id: row.id,
    scope: row.scope,
    type: (row.type as KnowledgeType) ?? "task_history",
    title: row.title,
    content: row.content ?? "",
    tags: parseTags(row.tags),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Infer the knowledge scope for the current working directory by reading its
 * git remote URL. Falls back to "general" if `cwd` is not in a git repo or has
 * no `origin` remote.
 */
export function inferScopeFromCwd(cwd: string = process.cwd()): string {
  try {
    const out = execSync("git -C " + JSON.stringify(cwd) + " remote get-url origin", {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    });
    const url = out.trim();
    if (!url) return GENERAL_SCOPE;
    return normalizeScope(url);
  } catch {
    return GENERAL_SCOPE;
  }
}

export interface QueryKnowledgeOptions {
  /** Restrict by entry type. */
  type?: KnowledgeType;
  /** Max number of entries to return. Defaults to 50. */
  limit?: number;
  /**
   * If true, include "general" entries alongside the scoped ones when scope is
   * not "general". Defaults to true.
   */
  includeGeneral?: boolean;
}

/**
 * Retrieve knowledge entries for a given scope, optionally filtered by a
 * keyword search across title and content (case-insensitive SQL LIKE).
 *
 * When the scope is not "general", entries with the literal "general" scope
 * are also returned (unless `includeGeneral: false` is passed) so agents get
 * both repo-specific and global notes by default.
 *
 * @example
 *   const entries = await queryKnowledge("github.com/acme/widgets", "auth flow");
 */
export async function queryKnowledge(
  scope: string,
  query?: string,
  options: QueryKnowledgeOptions = {},
): Promise<KnowledgeEntry[]> {
  const { type, limit = 50, includeGeneral = true } = options;
  const normalized = normalizeScope(scope);

  const scopeFilter =
    includeGeneral && normalized !== GENERAL_SCOPE
      ? { scope: { in: [normalized, GENERAL_SCOPE] } }
      : { scope: normalized };

  const q = query?.trim();
  const where: Record<string, unknown> = { ...scopeFilter };
  if (type) where.type = type;
  if (q) {
    where.OR = [
      { title: { contains: q } },
      { content: { contains: q } },
      { tags: { contains: q } },
    ];
  }

  const rows = (await prisma.knowledgeEntry.findMany({
    where,
    orderBy: [{ updatedAt: "desc" }],
    take: Math.max(1, Math.min(500, limit)),
  })) as RawKnowledgeEntry[];

  return rows.map(toKnowledgeEntry);
}

/**
 * Compact, agent-friendly text rendering of a list of entries — suitable for
 * pasting into a prompt.
 */
export function renderKnowledgeForPrompt(entries: KnowledgeEntry[]): string {
  if (entries.length === 0) return "";
  const sections = entries.map((e) => {
    const meta = [`scope: ${e.scope}`, `type: ${e.type}`];
    if (e.tags.length) meta.push(`tags: ${e.tags.join(", ")}`);
    return `### ${e.title}\n(${meta.join(" · ")})\n\n${e.content}`.trim();
  });
  return sections.join("\n\n---\n\n");
}
