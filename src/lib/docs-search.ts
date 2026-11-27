// Full-text search over the /docs pages (the ⌘K search box in the docs sidebar).
//
// The index is built from the same markdown the MCP `get_docs` tool serves (DOCS_TOPICS), so
// anything documented on a page is searchable without a second copy of the text. Each topic is
// split at its headings into sections; a section links to its page plus the in-page anchor of
// the `##` section it sits under (DocsTopic.anchors), so a hit scrolls to the right place.
//
// Pure — no DB or DOM — so it runs on the server (building the index in the docs layout) and in
// the browser (scoring the query), and is unit-tested in src/lib/__tests__/docs-search.test.ts.

export interface DocsSearchEntry {
  /** Topic title, e.g. "MCP server". */
  page: string;
  /** Site path of the page, e.g. "/docs/mcp". */
  path: string;
  /** In-page anchor (without `#`), or null to link to the top of the page. */
  anchor: string | null;
  /** Section heading, e.g. "get_task — Get a task (read)". */
  title: string;
  /** Ancestor headings, outermost first (excluding the page title). */
  breadcrumbs: string[];
  /** Plain text of the section body. */
  text: string;
}

export interface DocsSearchSource {
  title: string;
  path: string;
  markdown: string;
  /** `##` heading → in-page anchor id. Content before the first `##` uses `anchors[""]`. */
  anchors?: Record<string, string>;
  /**
   * Optional `###`/`####` heading (markdown or plain text) → anchor id, for sub-sections that
   * have their own id on the page. Headings without one inherit their parent section's anchor.
   */
  subAnchors?: Record<string, string>;
}

export interface DocsSearchResult {
  entry: DocsSearchEntry;
  href: string;
  score: number;
  /** Short excerpt of the body around the first match ("" when only the title matched). */
  snippet: string;
}

/** Strips the inline-markdown subset used by the docs (`code`, **bold**, [text](href), tables). */
export function plainText(markdown: string): string {
  return markdown
    .replace(/^```[^\n]*$/gm, "")
    .replace(/^\|(?:\s*-+\s*\|)+\s*$/gm, "")
    .replace(/\[([^\]]+)\]\([^)\s]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\\\|/g, "\u0000")
    .replace(/\|/g, " ")
    .replace(/\u0000/g, "|")
    .replace(/^\s*-\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

const HEADING = /^(#{1,4})\s+(.+)$/;

/** Splits each topic's markdown into one entry per heading (levels 2–4; level 1 is the page). */
export function buildDocsSearchIndex(sources: DocsSearchSource[]): DocsSearchEntry[] {
  const entries: DocsSearchEntry[] = [];
  for (const src of sources) {
    const anchors = src.anchors ?? {};
    const subAnchors = new Map(Object.entries(src.subAnchors ?? {}).map(([k, v]) => [plainText(k), v]));
    // Headings currently open and their anchors, by level (index 0 = level 2).
    const stack: string[] = [];
    const anchorStack: (string | null)[] = [];
    let anchor: string | null = anchors[""] ?? null;
    let title = src.title;
    let crumbs: string[] = [];
    let body: string[] = [];
    let inFence = false;

    const flush = () => {
      const text = plainText(body.join("\n"));
      if (text || title !== src.title) {
        entries.push({ page: src.title, path: src.path, anchor, title, breadcrumbs: crumbs, text });
      }
      body = [];
    };

    for (const line of src.markdown.split("\n")) {
      if (line.startsWith("```")) inFence = !inFence;
      const m = inFence ? null : HEADING.exec(line);
      if (!m) {
        body.push(line);
        continue;
      }
      const level = m[1].length;
      const heading = plainText(m[2]);
      if (level === 1) continue; // page title
      flush();
      stack.length = level - 2;
      anchorStack.length = level - 2;
      crumbs = stack.filter(Boolean);
      stack[level - 2] = heading;
      // Nearest open ancestor with an anchor (a skipped heading level leaves a hole).
      const inherited = anchorStack.findLast((a) => a != null) ?? anchors[""] ?? null;
      anchor = level === 2 ? anchors[heading] ?? inherited : subAnchors.get(heading) ?? inherited;
      anchorStack[level - 2] = anchor;
      title = heading;
    }
    flush();
  }
  return entries;
}

export function docsHref(entry: Pick<DocsSearchEntry, "path" | "anchor">): string {
  return entry.anchor ? `${entry.path}#${entry.anchor}` : entry.path;
}

function terms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).map((t) => t.trim()).filter(Boolean);
}

function snippetAround(text: string, term: string, radius = 70): string {
  const i = text.toLowerCase().indexOf(term);
  if (i < 0) return "";
  const start = Math.max(0, i - radius);
  const end = Math.min(text.length, i + term.length + radius * 1.5);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

/**
 * Ranks entries against a query. Every term must appear somewhere in the entry (title,
 * breadcrumbs, page name or body); matches in the title count most, then breadcrumbs, then the
 * body. Ties keep document order, so earlier (more introductory) sections come first.
 */
export function searchDocs(index: DocsSearchEntry[], query: string, limit = 12): DocsSearchResult[] {
  const qs = terms(query);
  if (qs.length === 0) return [];
  const phrase = qs.join(" ");

  const scored: DocsSearchResult[] = [];
  index.forEach((entry, order) => {
    const title = entry.title.toLowerCase();
    const crumbs = [entry.page, ...entry.breadcrumbs].join(" ").toLowerCase();
    const text = entry.text.toLowerCase();
    let score = 0;
    for (const q of qs) {
      let s = 0;
      if (title.includes(q)) s += title.startsWith(q) || title.includes(` ${q}`) ? 12 : 8;
      if (crumbs.includes(q)) s += 3;
      if (text.includes(q)) s += 2 + Math.min(3, text.split(q).length - 2);
      if (s === 0) return; // every term must match
      score += s;
    }
    if (qs.length > 1) {
      if (title.includes(phrase)) score += 10;
      else if (text.includes(phrase)) score += 5;
    }
    if (title === phrase) score += 10;
    const firstBodyTerm = qs.find((q) => text.includes(q));
    scored.push({
      entry,
      href: docsHref(entry),
      score: score - order * 1e-6,
      snippet: firstBodyTerm ? snippetAround(entry.text, text.includes(phrase) ? phrase : firstBodyTerm) : "",
    });
  });

  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
