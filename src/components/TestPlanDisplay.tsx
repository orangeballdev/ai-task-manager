import { ClipboardList } from "lucide-react";

interface ParsedBlock {
  type: "heading" | "bullet" | "numbered" | "text";
  content: string;
  level?: number;
  number?: number;
}

function parseTestPlan(text: string): ParsedBlock[] {
  const lines = text.split("\n");
  const blocks: ParsedBlock[] = [];
  let numberedCounter = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      numberedCounter = 0;
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      blocks.push({ type: "heading", content: headingMatch[2], level: headingMatch[1].length });
      numberedCounter = 0;
      continue;
    }

    const numberedMatch = trimmed.match(/^(\d+)\.\s+(.+)/);
    if (numberedMatch) {
      numberedCounter++;
      blocks.push({ type: "numbered", content: numberedMatch[2], number: numberedCounter });
      continue;
    }

    const bulletMatch = trimmed.match(/^[-*•]\s+(.+)/);
    if (bulletMatch) {
      numberedCounter = 0;
      blocks.push({ type: "bullet", content: bulletMatch[1] });
      continue;
    }

    numberedCounter = 0;
    blocks.push({ type: "text", content: trimmed });
  }

  return blocks;
}

/** Render inline code spans (backtick-delimited) and **bold** text within text */
function InlineContent({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("`") && part.endsWith("`")) {
          return (
            <code
              key={i}
              className="bg-muted/80 text-foreground/90 px-1 py-0.5 rounded text-[0.8em] font-mono"
            >
              {part.slice(1, -1)}
            </code>
          );
        }
        if (part.startsWith("**") && part.endsWith("**")) {
          return (
            <strong key={i} className="font-semibold">
              {part.slice(2, -2)}
            </strong>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

interface TestPlanDisplayProps {
  testPlan: string;
  /** Compact mode for card views (KanbanBoard) vs full mode for detail pages */
  compact?: boolean;
}

export function TestPlanDisplay({ testPlan, compact = false }: TestPlanDisplayProps) {
  const blocks = parseTestPlan(testPlan);
  if (blocks.length === 0) return null;

  if (compact) {
    return (
      <div>
        <div className="flex items-center gap-1.5 mb-2">
          <ClipboardList className="size-3.5 text-muted-foreground/60 shrink-0" />
          <p className="text-xs text-muted-foreground/70 uppercase tracking-wide font-medium">
            Test Plan
          </p>
        </div>
        <div className="flex flex-col gap-1 max-h-40 overflow-y-auto pr-1">
          {blocks.map((block, i) => {
            if (block.type === "heading") {
              return (
                <p key={i} className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mt-1.5 first:mt-0">
                  <InlineContent text={block.content} />
                </p>
              );
            }
            if (block.type === "bullet" || block.type === "numbered") {
              return (
                <div key={i} className="flex items-start gap-2">
                  {block.type === "numbered" ? (
                    <span className="shrink-0 mt-0.5 size-4 rounded-full bg-muted flex items-center justify-center text-[10px] font-semibold text-muted-foreground">
                      {block.number}
                    </span>
                  ) : (
                    <span className="shrink-0 mt-[5px] size-1.5 rounded-full bg-muted-foreground/40" />
                  )}
                  <span className="text-sm text-card-foreground leading-snug">
                    <InlineContent text={block.content} />
                  </span>
                </div>
              );
            }
            return (
              <p key={i} className="text-sm text-card-foreground">
                <InlineContent text={block.content} />
              </p>
            );
          })}
        </div>
      </div>
    );
  }

  // Full mode for detail page
  return (
    <div className="rounded-lg border border-border bg-card text-card-foreground shadow-sm">
      <div className="flex items-center gap-2 px-6 py-4 border-b border-border">
        <ClipboardList className="size-4 text-muted-foreground shrink-0" />
        <h3 className="text-base font-semibold">Test Plan</h3>
      </div>
      <div className="px-6 py-4 flex flex-col gap-2">
        {blocks.map((block, i) => {
          if (block.type === "heading") {
            return (
              <p
                key={i}
                className={`font-semibold ${block.level === 1 ? "text-sm text-foreground" : "text-xs uppercase tracking-wide text-muted-foreground"} mt-2 first:mt-0`}
              >
                <InlineContent text={block.content} />
              </p>
            );
          }
          if (block.type === "bullet" || block.type === "numbered") {
            return (
              <div key={i} className="flex items-start gap-3">
                {block.type === "numbered" ? (
                  <span className="shrink-0 mt-0.5 size-5 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center text-[11px] font-semibold text-primary/70">
                    {block.number}
                  </span>
                ) : (
                  <span className="shrink-0 mt-[7px] size-2 rounded-full bg-muted-foreground/30 ring-1 ring-muted-foreground/20" />
                )}
                <span className="text-sm text-card-foreground leading-relaxed">
                  <InlineContent text={block.content} />
                </span>
              </div>
            );
          }
          return (
            <p key={i} className="text-sm text-card-foreground leading-relaxed">
              <InlineContent text={block.content} />
            </p>
          );
        })}
      </div>
    </div>
  );
}
