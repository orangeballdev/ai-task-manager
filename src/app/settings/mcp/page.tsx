"use client";
import { copyToClipboard } from "@/lib/clipboard";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { confirm } from "@/components/ui/confirm-dialog";
import { Plug, Trash2, Copy, BookOpen } from "lucide-react";
import { McpSetupSnippets, useAppOrigin } from "@/components/docs/McpSetupSnippets";
import { MCP_ACCESS_LABELS, MCP_ACCESS_LEVELS, type McpAccess } from "@/lib/mcp/tokens";
import { mcpEndpoint } from "@/lib/mcp/client-config";

interface McpToken {
  id: string;
  name: string;
  keyPrefix: string;
  access: McpAccess;
  lastUsedAt: string | null;
  createdAt: string;
  /** Set for connections made through OAuth sign-in rather than a pasted token. */
  oauthClientId: string | null;
  refreshExpiresAt: string | null;
}

function oauthStatus(t: McpToken): string {
  if (!t.refreshExpiresAt) return "Signed in with OAuth";
  const until = new Date(t.refreshExpiresAt);
  return until.getTime() < Date.now()
    ? "Signed in with OAuth · session expired (the client must sign in again)"
    : `Signed in with OAuth · session renews automatically, expires if unused by ${until.toLocaleDateString()}`;
}

const ACCESS_HELP: Record<McpAccess, string> = {
  read: "List, search and inspect tasks, logs, output files and stats. Can't change anything.",
  write: "Everything read-only can, plus create, edit, start, cancel, message and review tasks.",
};

function formatDate(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString();
}

export default function McpSettingsPage() {
  const origin = useAppOrigin();
  const [tokens, setTokens] = useState<McpToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [access, setAccess] = useState<McpAccess>("read");
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<{ name: string; token: string; access: McpAccess } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/mcp-tokens");
      setTokens(await res.json());
    } catch {
      toast.error("Failed to load MCP tokens");
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- load() is async; setState is in a Promise, not synchronously in the effect body
  useEffect(() => { void load(); }, [load]);

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Give the token a name so you can recognize it later");
      return;
    }
    setCreating(true);
    try {
      const res = await fetch("/api/mcp-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed, access }),
      });
      if (!res.ok) throw new Error("Failed");
      const created = await res.json() as McpToken & { token: string };
      setRevealed({ name: created.name, token: created.token, access: created.access });
      setName("");
      await load();
    } catch {
      toast.error("Failed to create MCP token");
    } finally {
      setCreating(false);
    }
  }

  async function handleAccessChange(token: McpToken, next: McpAccess) {
    if (next === token.access) return;
    try {
      const res = await fetch(`/api/mcp-tokens/${token.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access: next }),
      });
      if (!res.ok) throw new Error("Failed");
      setTokens((prev) => prev.map((t) => (t.id === token.id ? { ...t, access: next } : t)));
      toast.success(`"${token.name}" is now ${MCP_ACCESS_LABELS[next].toLowerCase()}`);
    } catch {
      toast.error("Failed to update token");
    }
  }

  async function handleDelete(token: McpToken) {
    const ok = await confirm({
      title: token.oauthClientId ? "Disconnect OAuth client?" : "Revoke MCP token?",
      description: token.oauthClientId
        ? `"${token.name}" will be signed out immediately. It can connect again only after you approve a new sign-in.`
        : `"${token.name}" will stop working immediately. Any MCP client using it will be disconnected.`,
      confirmLabel: "Revoke",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/mcp-tokens/${token.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed");
      setTokens((prev) => prev.filter((t) => t.id !== token.id));
      toast.success("MCP token revoked");
    } catch {
      toast.error("Failed to revoke MCP token");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="pt-6 flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            The MCP server lets AI assistants such as Claude Code, Claude Desktop, Cursor and VS Code work with
            your tasks — ask questions about them, create and edit them, start or cancel runs, and review results.
            Clients that support OAuth (Claude Code, Claude Desktop, Codex, VS Code, Cursor…) only need the server
            URL — they open a browser to sign in and you approve them. Others authenticate with an access token
            created on this page.
          </p>
          <p className="text-sm text-muted-foreground">
            Server URL: <code className="text-xs bg-muted px-1 py-0.5 rounded">{mcpEndpoint(origin)}</code>
          </p>
          <div className="flex flex-col gap-1 pt-2">
            <p className="text-sm font-medium">Connect with OAuth (no token needed)</p>
            <McpSetupSnippets oauth compact />
          </div>
          <Link href="/docs/mcp" className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline w-fit">
            <BookOpen className="size-4" /> Setup guide, tools & example prompts
          </Link>
        </CardContent>
      </Card>

      <Card id="mcp-tokens" className="scroll-mt-24">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Plug className="size-4 text-muted-foreground" /> MCP Access Tokens &amp; Connected Clients
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {revealed && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 flex flex-col gap-3">
              <p className="text-sm font-medium text-foreground">
                Save &quot;{revealed.name}&quot; now — it won&apos;t be shown again
              </p>
              <div className="flex gap-2 items-center">
                <Input readOnly value={revealed.token} className="font-mono text-xs" />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label="Copy token"
                  onClick={() => {
                    copyToClipboard(revealed.token)
                      .then(() => toast.success("Copied to clipboard"), () => toast.error("Failed to copy to clipboard"));
                  }}
                >
                  <Copy className="size-4" />
                </Button>
              </div>
              <div className="flex flex-col gap-1">
                <p className="text-xs text-muted-foreground">Connect a client with this token:</p>
                <McpSetupSnippets token={revealed.token} compact />
              </div>
              <Button type="button" variant="ghost" size="sm" className="w-fit" onClick={() => setRevealed(null)}>
                Done
              </Button>
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
            <div className="flex flex-col gap-2 flex-1">
              <Label htmlFor="new-mcp-token-name">New token name</Label>
              <Input
                id="new-mcp-token-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Claude Code on my laptop"
                onKeyDown={(e) => { if (e.key === "Enter") void handleCreate(); }}
              />
            </div>
            <div className="flex flex-col gap-2 sm:w-44">
              <Label>Access</Label>
              <Select value={access} onValueChange={(v) => { if (v) setAccess(v as McpAccess); }}>
                <SelectTrigger><SelectValue>{MCP_ACCESS_LABELS[access]}</SelectValue></SelectTrigger>
                <SelectContent>
                  {MCP_ACCESS_LEVELS.map((a) => (
                    <SelectItem key={a} value={a}>{MCP_ACCESS_LABELS[a]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={handleCreate} disabled={creating}>
              {creating ? "Creating…" : "Create token"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground -mt-3">{ACCESS_HELP[access]}</p>

          {loading ? (
            <div className="h-16 bg-muted rounded animate-pulse" />
          ) : tokens.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No MCP tokens or connected clients yet. Create a token above, or add the server URL to an OAuth-capable
              client and approve its sign-in.
            </p>
          ) : (
            <div className="flex flex-col divide-y divide-border border border-border rounded-md">
              {tokens.map((t) => (
                <div key={t.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 py-3">
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-sm font-medium truncate flex items-center gap-2">
                      {t.name}
                      <Badge variant={t.access === "write" ? "default" : "secondary"}>{MCP_ACCESS_LABELS[t.access]}</Badge>
                      {t.oauthClientId && <Badge variant="outline">OAuth</Badge>}
                    </span>
                    {t.oauthClientId ? (
                      <span className="text-xs text-muted-foreground">{oauthStatus(t)}</span>
                    ) : (
                      <span className="text-xs text-muted-foreground font-mono">{t.keyPrefix}</span>
                    )}
                    <span className="text-xs text-muted-foreground">
                      Created {formatDate(t.createdAt)} · Last used {formatDate(t.lastUsedAt)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Select value={t.access} onValueChange={(v) => { if (v) void handleAccessChange(t, v as McpAccess); }}>
                      <SelectTrigger className="w-36" aria-label={`Access for ${t.name}`}>
                        <SelectValue>{MCP_ACCESS_LABELS[t.access]}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {MCP_ACCESS_LEVELS.map((a) => (
                          <SelectItem key={a} value={a}>{MCP_ACCESS_LABELS[a]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button variant="ghost" size="sm" onClick={() => handleDelete(t)} aria-label={`${t.oauthClientId ? "Disconnect" : "Revoke"} ${t.name}`}>
                      <Trash2 className="size-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Changing a token&apos;s access applies to the client&apos;s next request — some clients cache the tool
            list, so reconnect them to see newly allowed tools.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
