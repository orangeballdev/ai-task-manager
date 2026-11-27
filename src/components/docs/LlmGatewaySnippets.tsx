"use client";
import { useState } from "react";
import { CodeBlock } from "@/components/docs/CodeBlock";
import { useAppOrigin } from "@/components/docs/McpSetupSnippets";
import { llmGatewaySnippets, llmGatewayUrls } from "@/lib/docs-content/llm-gateway";

/** Tabbed client setup examples, pointed at this deployment. */
export function LlmGatewaySnippets() {
  const origin = useAppOrigin();
  const items = llmGatewaySnippets(origin);
  const [active, setActive] = useState(items[0].id);
  const current = items.find((s) => s.id === active) ?? items[0];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1" role="tablist">
        {items.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={s.id === current.id}
            onClick={() => setActive(s.id)}
            className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
              s.id === current.id
                ? "bg-foreground text-background border-foreground"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>
      <CodeBlock code={current.code} />
    </div>
  );
}

/** One of the two base URLs for this deployment, for the overview cards. */
export function LlmGatewayBaseUrl({ kind }: { kind: "openai" | "anthropic" }) {
  const origin = useAppOrigin();
  return <code className="text-sm break-all">{llmGatewayUrls(origin)[kind]}</code>;
}
