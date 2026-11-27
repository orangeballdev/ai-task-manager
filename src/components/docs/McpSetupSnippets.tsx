"use client";
import { useState, useSyncExternalStore } from "react";
import { CodeBlock } from "@/components/docs/CodeBlock";
import { mcpClientSnippets, mcpEndpoint, mcpOAuthClientSnippets } from "@/lib/mcp/client-config";

const SERVER_ORIGIN_PLACEHOLDER = "https://your-app.example.com";
const noopSubscribe = () => () => {};

/** This deployment's origin in the browser; a placeholder while server-rendering. */
export function useAppOrigin(): string {
  return useSyncExternalStore(noopSubscribe, () => window.location.origin, () => SERVER_ORIGIN_PLACEHOLDER);
}

/**
 * Tabbed setup instructions for each MCP client. Pass `token` to fill in a real token
 * (Settings → MCP right after creating one); otherwise a placeholder is shown. `oauth`
 * shows the token-less sign-in setup instead.
 */
export function McpSetupSnippets({ token, compact = false, oauth = false }: { token?: string; compact?: boolean; oauth?: boolean }) {
  const origin = useAppOrigin();
  const snippets = oauth ? mcpOAuthClientSnippets(origin) : mcpClientSnippets(origin, token);
  const [active, setActive] = useState(snippets[0].id);
  const current = snippets.find((s) => s.id === active) ?? snippets[0];

  return (
    <div className="flex flex-col gap-2">
      {!compact && (
        <p className="text-sm text-muted-foreground">
          Server URL: <code className="text-xs bg-muted px-1 py-0.5 rounded">{mcpEndpoint(origin)}</code>
        </p>
      )}
      <div className="flex flex-wrap gap-1" role="tablist">
        {snippets.map((s) => (
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
      <p className="text-xs text-muted-foreground">{current.where}</p>
      <CodeBlock code={current.code} />
    </div>
  );
}
