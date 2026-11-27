import Link from "next/link";
import { Fragment, type ReactNode } from "react";

// Renders the inline-markdown subset used by src/lib/docs-content/* (`code`, **bold**,
// [text](href)) so the same strings can feed both the /docs pages and the MCP get_docs tool.

const TOKEN = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\))/g;

export function renderInline(text: string): ReactNode {
  return text.split(TOKEN).map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
      return <code key={i} className="text-xs bg-muted px-1 py-0.5 rounded">{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 3) {
      return <strong key={i} className="text-foreground">{part.slice(2, -2)}</strong>;
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) {
      const [, label, href] = link;
      return href.startsWith("/")
        ? <Link key={i} href={href} className="text-primary hover:underline">{label}</Link>
        : <a key={i} href={href} target="_blank" rel="noreferrer" className="text-primary hover:underline">{label}</a>;
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

export function Prose({ text, className = "text-sm text-muted-foreground max-w-2xl" }: { text: string; className?: string }) {
  return <p className={className}>{renderInline(text)}</p>;
}

export function ProseList({ items }: { items: string[] }) {
  return (
    <ul className="text-sm text-muted-foreground list-disc pl-5 flex flex-col gap-1.5 max-w-2xl">
      {items.map((item) => <li key={item}>{renderInline(item)}</li>)}
    </ul>
  );
}

/** A simple bordered table whose cells are inline markdown. The first column is emphasised. */
export function ProseTable({ head, rows }: { head?: string[]; rows: string[][] }) {
  return (
    <div className="rounded-md border border-border overflow-x-auto">
      <table className="w-full text-sm">
        {head && (
          <thead className="bg-muted/40">
            <tr>
              {head.map((h) => (
                <th key={h} className="text-left px-3 py-2 font-medium text-xs uppercase tracking-wide text-muted-foreground">{h}</th>
              ))}
            </tr>
          </thead>
        )}
        <tbody className="divide-y divide-border">
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((c, j) => (
                <td key={j} className={`align-top px-3 py-2 ${j === 0 ? "font-medium sm:whitespace-nowrap" : "text-muted-foreground"}`}>
                  {renderInline(c)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
