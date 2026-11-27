import React from "react";

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

/**
 * A lightweight markdown renderer that handles:
 * - # ## ### headings
 * - **bold** and *italic* text
 * - `inline code`
 * - ``` code blocks ```
 * - - and * bullet lists
 * - 1. numbered lists
 * - > blockquotes
 * - --- horizontal rules
 * - [text](url) links
 * - Proper newlines and paragraphs
 */
export function MarkdownRenderer({ content, className = "" }: MarkdownRendererProps) {
  const lines = content.split("\n");
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.trimStart().startsWith("```")) {
      const lang = line.trimStart().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      elements.push(
        <div key={elements.length} className="mb-4">
          {lang && (
            <div className="text-xs text-muted-foreground bg-muted/60 px-3 py-1 rounded-t-md border border-border border-b-0 font-mono">
              {lang}
            </div>
          )}
          <pre className={`bg-muted/40 border border-border ${lang ? "rounded-b-md rounded-tr-md" : "rounded-md"} p-3 overflow-x-auto text-sm font-mono text-foreground leading-relaxed`}>
            <code>{codeLines.join("\n")}</code>
          </pre>
        </div>
      );
      continue;
    }

    // Heading 1
    if (line.startsWith("# ")) {
      elements.push(
        <h1 key={elements.length} className="text-2xl font-bold mt-6 mb-3 text-foreground leading-tight border-b border-border pb-2">
          {renderInline(line.slice(2))}
        </h1>
      );
      i++;
      continue;
    }

    // Heading 2
    if (line.startsWith("## ")) {
      elements.push(
        <h2 key={elements.length} className="text-xl font-semibold mt-5 mb-2 text-foreground leading-tight">
          {renderInline(line.slice(3))}
        </h2>
      );
      i++;
      continue;
    }

    // Heading 3
    if (line.startsWith("### ")) {
      elements.push(
        <h3 key={elements.length} className="text-lg font-semibold mt-4 mb-2 text-foreground leading-tight">
          {renderInline(line.slice(4))}
        </h3>
      );
      i++;
      continue;
    }

    // Heading 4
    if (line.startsWith("#### ")) {
      elements.push(
        <h4 key={elements.length} className="text-base font-semibold mt-3 mb-1.5 text-foreground">
          {renderInline(line.slice(5))}
        </h4>
      );
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      elements.push(<hr key={elements.length} className="mb-4 mt-2 border-border" />);
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith("> ")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith("> ")) {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      elements.push(
        <blockquote key={elements.length} className="border-l-4 border-primary/40 pl-4 mb-4 text-muted-foreground italic">
          {quoteLines.map((ql, qi) => (
            <p key={qi} className={qi > 0 ? "mt-2" : ""}>
              {renderInline(ql)}
            </p>
          ))}
        </blockquote>
      );
      continue;
    }

    // Unordered list
    if (/^(\s*)([-*+])\s/.test(line)) {
      const listItems: Array<{ indent: number; text: string }> = [];
      while (i < lines.length && /^(\s*)([-*+])\s/.test(lines[i])) {
        const match = lines[i].match(/^(\s*)([-*+])\s(.*)$/);
        if (match) {
          listItems.push({ indent: match[1].length, text: match[3] });
        }
        i++;
      }
      elements.push(
        <ul key={elements.length} className="mb-4 space-y-1.5">
          {listItems.map((item, idx) => (
            <li
              key={idx}
              className="flex items-start gap-2 text-card-foreground"
              style={{ paddingLeft: `${item.indent * 0.75}rem` }}
            >
              <span className="text-muted-foreground mt-1 shrink-0">•</span>
              <span className="leading-7">{renderInline(item.text)}</span>
            </li>
          ))}
        </ul>
      );
      continue;
    }

    // Ordered list
    if (/^\d+\.\s/.test(line)) {
      const listItems: string[] = [];
      let startNum = 1;
      const firstMatch = line.match(/^(\d+)\.\s/);
      if (firstMatch) startNum = parseInt(firstMatch[1], 10);
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        const match = lines[i].match(/^\d+\.\s(.*)/);
        if (match) listItems.push(match[1]);
        i++;
      }
      elements.push(
        <ol key={elements.length} className="mb-4 space-y-1.5 list-none">
          {listItems.map((item, idx) => (
            <li key={idx} className="flex items-start gap-2 text-card-foreground">
              <span className="text-muted-foreground shrink-0 tabular-nums font-mono text-sm mt-1 min-w-[1.25rem] text-right">
                {startNum + idx}.
              </span>
              <span className="leading-7">{renderInline(item)}</span>
            </li>
          ))}
        </ol>
      );
      continue;
    }

    // Empty line — skip all consecutive blanks; paragraph margins handle the gap
    if (line.trim() === "") {
      while (i < lines.length && lines[i].trim() === "") {
        i++;
      }
      continue;
    }

    // Regular paragraph - collect consecutive non-special lines
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("#") &&
      !lines[i].startsWith("> ") &&
      !/^(\s*)([-*+])\s/.test(lines[i]) &&
      !/^\d+\.\s/.test(lines[i]) &&
      !lines[i].trimStart().startsWith("```") &&
      !/^(-{3,}|\*{3,}|_{3,})$/.test(lines[i].trim())
    ) {
      paraLines.push(lines[i]);
      i++;
    }

    if (paraLines.length > 0) {
      elements.push(
        <p key={elements.length} className="text-card-foreground leading-7 mb-4">
          {paraLines.map((pl, pi) => (
            <React.Fragment key={pi}>
              {pi > 0 && <br />}
              {renderInline(pl)}
            </React.Fragment>
          ))}
        </p>
      );
    }
  }

  return (
    <div className={`prose-like ${className}`}>
      {elements}
    </div>
  );
}

/**
 * Render inline markdown: **bold**, *italic*, `code`, [text](url)
 */
function renderInline(text: string): React.ReactNode {
  if (!text) return null;

  // Split on inline patterns
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Bold+italic: ***text***
    const boldItalicMatch = remaining.match(/^\*\*\*([^*]+)\*\*\*/);
    if (boldItalicMatch) {
      parts.push(
        <strong key={key++} className="font-semibold italic text-foreground">
          {boldItalicMatch[1]}
        </strong>
      );
      remaining = remaining.slice(boldItalicMatch[0].length);
      continue;
    }

    // Bold: **text**
    const boldMatch = remaining.match(/^\*\*([^*]+)\*\*/);
    if (boldMatch) {
      parts.push(
        <strong key={key++} className="font-semibold text-foreground">
          {boldMatch[1]}
        </strong>
      );
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // Italic: *text* or _text_
    const italicMatch = remaining.match(/^(\*|_)([^*_]+)\1/);
    if (italicMatch) {
      parts.push(
        <em key={key++} className="italic">
          {italicMatch[2]}
        </em>
      );
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }

    // Inline code: `code`
    const codeMatch = remaining.match(/^`([^`]+)`/);
    if (codeMatch) {
      parts.push(
        <code key={key++} className="bg-muted/60 text-foreground font-mono text-[0.85em] px-1 py-0.5 rounded border border-border/50">
          {codeMatch[1]}
        </code>
      );
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // Link: [text](url)
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      parts.push(
        <a
          key={key++}
          href={linkMatch[2]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline hover:opacity-80 transition-opacity"
        >
          {linkMatch[1]}
        </a>
      );
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }

    // Regular character — consume until next special character
    const nextSpecial = remaining.search(/\*|_|`|\[/);
    if (nextSpecial === -1) {
      parts.push(remaining);
      remaining = "";
    } else if (nextSpecial === 0) {
      // Single special char that didn't match a pattern — output as-is
      parts.push(remaining[0]);
      remaining = remaining.slice(1);
    } else {
      parts.push(remaining.slice(0, nextSpecial));
      remaining = remaining.slice(nextSpecial);
    }
  }

  return parts.length === 1 && typeof parts[0] === "string" ? parts[0] : <>{parts}</>;
}
