// Helpers for the docs content (src/lib/docs-content/*), which is written once and rendered
// two ways: as the /docs pages, and as markdown for the MCP `get_docs` tool.
//
// Prose strings use a tiny inline-markdown subset that both renderers understand:
// `code`, **bold** and [text](href). The pages render it with <Prose> (components/docs/Prose.tsx);
// for markdown it's already in the right format, apart from site-relative links, which
// absoluteLinks() points at the deployment so they work outside the browser.

export type MdRow = string[];

function cell(value: unknown): string {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function mdTable(head: string[], rows: MdRow[]): string {
  return [
    `| ${head.map(cell).join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
  ].join("\n");
}

export function mdCode(code: string, lang = ""): string {
  return `\`\`\`${lang}\n${code}\n\`\`\``;
}

export function mdList(items: string[]): string {
  return items.map((i) => `- ${i}`).join("\n");
}

/** Rewrites `](/path)` links to `](<origin>/path)`. */
export function absoluteLinks(markdown: string, origin: string): string {
  const base = origin.replace(/\/+$/, "");
  return markdown.replace(/\]\((\/[^)\s]*)\)/g, `](${base}$1)`);
}

/** Joins non-empty blocks with blank lines. */
export function mdDoc(...blocks: (string | false | null | undefined)[]): string {
  return blocks.filter(Boolean).join("\n\n");
}
