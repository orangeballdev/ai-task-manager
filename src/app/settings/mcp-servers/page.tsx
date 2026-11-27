"use client";
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { confirm } from "@/components/ui/confirm-dialog";
import { Server, Trash2, Pencil, Plus } from "lucide-react";
import {
  MCP_SERVER_NAME_RE,
  MCP_TRANSPORTS,
  MCP_TRANSPORT_LABELS,
  formatKeyValueLines,
  parseKeyValueLines,
  type McpTransport,
  type PublicMcpServer,
} from "@/lib/mcp-servers";

interface FormState {
  name: string;
  description: string;
  transport: McpTransport;
  command: string;
  /** One argument per line. */
  args: string;
  /** KEY=value lines. */
  env: string;
  url: string;
  /** Header: value lines. */
  headers: string;
  enabled: boolean;
}

const EMPTY_FORM: FormState = {
  name: "",
  description: "",
  transport: "stdio",
  command: "",
  args: "",
  env: "",
  url: "",
  headers: "",
  enabled: true,
};

function toForm(s: PublicMcpServer): FormState {
  return {
    name: s.name,
    description: s.description ?? "",
    transport: s.transport,
    command: s.command ?? "",
    args: s.args.join("\n"),
    env: formatKeyValueLines(s.env, "env"),
    url: s.url ?? "",
    headers: formatKeyValueLines(s.headers, "headers"),
    enabled: s.enabled,
  };
}

function summary(s: PublicMcpServer): string {
  if (s.transport === "stdio") return [s.command, ...s.args].filter(Boolean).join(" ");
  return s.url ?? "";
}

export default function McpServersSettingsPage() {
  const [servers, setServers] = useState<PublicMcpServer[]>([]);
  const [loading, setLoading] = useState(true);
  // null = form closed, "new" = adding, otherwise the id being edited.
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/mcp-servers");
      if (!res.ok) throw new Error("Failed");
      setServers(await res.json());
    } catch {
      toast.error("Failed to load MCP servers");
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- load() is async; setState is in a Promise, not synchronously in the effect body
  useEffect(() => { void load(); }, [load]);

  function openNew() {
    setForm(EMPTY_FORM);
    setEditing("new");
  }

  function openEdit(s: PublicMcpServer) {
    setForm(toForm(s));
    setEditing(s.id);
  }

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSave() {
    const name = form.name.trim();
    if (!MCP_SERVER_NAME_RE.test(name)) {
      toast.error("Name may only contain letters, numbers, '-' and '_'");
      return;
    }
    const body: Record<string, unknown> = {
      name,
      description: form.description,
      transport: form.transport,
      enabled: form.enabled,
    };
    if (form.transport === "stdio") {
      if (!form.command.trim()) {
        toast.error("Enter the command that starts the server");
        return;
      }
      const env = parseKeyValueLines(form.env, "env");
      if (!env.ok) {
        toast.error(env.error);
        return;
      }
      body.command = form.command.trim();
      body.args = form.args.split(/\r?\n/).map((a) => a.trim()).filter(Boolean);
      body.env = env.value;
    } else {
      const headers = parseKeyValueLines(form.headers, "headers");
      if (!headers.ok) {
        toast.error(headers.error);
        return;
      }
      body.url = form.url.trim();
      body.headers = headers.value;
    }

    setSaving(true);
    try {
      const isNew = editing === "new";
      const res = await fetch(isNew ? "/api/mcp-servers" : `/api/mcp-servers/${editing}`, {
        method: isNew ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to save MCP server");
      toast.success(isNew ? `Added "${name}"` : `Saved "${name}"`);
      setEditing(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save MCP server");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(s: PublicMcpServer, enabled: boolean) {
    setServers((prev) => prev.map((x) => (x.id === s.id ? { ...x, enabled } : x)));
    try {
      const res = await fetch(`/api/mcp-servers/${s.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error("Failed");
    } catch {
      setServers((prev) => prev.map((x) => (x.id === s.id ? { ...x, enabled: s.enabled } : x)));
      toast.error("Failed to update MCP server");
    }
  }

  async function handleDelete(s: PublicMcpServer) {
    const ok = await confirm({
      title: "Remove MCP server?",
      description: `"${s.name}" will no longer be available to tasks. Tasks already running keep it until they finish.`,
      confirmLabel: "Remove",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/mcp-servers/${s.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed");
      setServers((prev) => prev.filter((x) => x.id !== s.id));
      if (editing === s.id) setEditing(null);
      toast.success("MCP server removed");
    } catch {
      toast.error("Failed to remove MCP server");
    }
  }

  const isRemote = form.transport !== "stdio";

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="pt-6 flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            Connect agents to external MCP (Model Context Protocol) servers — databases, issue trackers, docs,
            browsers, internal APIs. Every <strong>enabled</strong> server is attached to each task run, so the
            agent can call its tools alongside its built-in ones. Changes apply from the next run.
          </p>
          <p className="text-sm text-muted-foreground">
            Supported by the Claude CLI and Codex CLI providers (Codex doesn&apos;t support legacy SSE servers).
            API-based providers run without them. Local (stdio) servers are started on the worker host, so their
            command must be installed there.
          </p>
        </CardContent>
      </Card>

      <Card id="mcp-servers" className="scroll-mt-24">
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-2 text-base">
            <span className="flex items-center gap-2">
              <Server className="size-4 text-muted-foreground" /> MCP Servers
            </span>
            {editing === null && (
              <Button size="sm" onClick={openNew}>
                <Plus className="size-4" /> Add server
              </Button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {editing !== null && (
            <div className="rounded-md border border-border p-4 flex flex-col gap-4">
              <p className="text-sm font-medium">{editing === "new" ? "Add MCP server" : `Edit "${form.name}"`}</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="mcp-server-name">Name</Label>
                  <Input
                    id="mcp-server-name"
                    value={form.name}
                    onChange={(e) => set("name", e.target.value)}
                    placeholder="e.g. linear"
                  />
                  <p className="text-xs text-muted-foreground">Letters, numbers, - and _. Tools appear as mcp__{form.name || "name"}__&lt;tool&gt;.</p>
                </div>
                <div className="flex flex-col gap-2">
                  <Label>Type</Label>
                  <Select value={form.transport} onValueChange={(v) => { if (v) set("transport", v as McpTransport); }}>
                    <SelectTrigger><SelectValue>{MCP_TRANSPORT_LABELS[form.transport]}</SelectValue></SelectTrigger>
                    <SelectContent>
                      {MCP_TRANSPORTS.map((t) => (
                        <SelectItem key={t} value={t}>{MCP_TRANSPORT_LABELS[t]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="mcp-server-description">Description (optional)</Label>
                <Input
                  id="mcp-server-description"
                  value={form.description}
                  onChange={(e) => set("description", e.target.value)}
                  placeholder="What it's for — included in the agent's prompt"
                />
              </div>

              {isRemote ? (
                <>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="mcp-server-url">URL</Label>
                    <Input
                      id="mcp-server-url"
                      value={form.url}
                      onChange={(e) => set("url", e.target.value)}
                      placeholder="https://mcp.example.com/mcp"
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="mcp-server-headers">Headers (one per line)</Label>
                    <Textarea
                      id="mcp-server-headers"
                      value={form.headers}
                      onChange={(e) => set("headers", e.target.value)}
                      placeholder="Authorization: Bearer …"
                      className="font-mono text-xs min-h-20"
                    />
                    <p className="text-xs text-muted-foreground">Values are stored as secrets and shown masked; leave a masked value as-is to keep it.</p>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="mcp-server-command">Command</Label>
                    <Input
                      id="mcp-server-command"
                      value={form.command}
                      onChange={(e) => set("command", e.target.value)}
                      placeholder="npx"
                      className="font-mono text-xs"
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="mcp-server-args">Arguments (one per line)</Label>
                    <Textarea
                      id="mcp-server-args"
                      value={form.args}
                      onChange={(e) => set("args", e.target.value)}
                      placeholder={"-y\n@modelcontextprotocol/server-postgres\npostgresql://localhost/mydb"}
                      className="font-mono text-xs min-h-20"
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="mcp-server-env">Environment variables (KEY=value, one per line)</Label>
                    <Textarea
                      id="mcp-server-env"
                      value={form.env}
                      onChange={(e) => set("env", e.target.value)}
                      placeholder="API_TOKEN=…"
                      className="font-mono text-xs min-h-20"
                    />
                    <p className="text-xs text-muted-foreground">Values are stored as secrets and shown masked; leave a masked value as-is to keep it.</p>
                  </div>
                </>
              )}

              <div className="flex items-center gap-2">
                <Switch id="mcp-server-enabled" checked={form.enabled} onCheckedChange={(v) => set("enabled", v)} />
                <Label htmlFor="mcp-server-enabled">Available to tasks</Label>
              </div>

              <div className="flex gap-2">
                <Button onClick={handleSave} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
                <Button variant="ghost" onClick={() => setEditing(null)} disabled={saving}>Cancel</Button>
              </div>
            </div>
          )}

          {loading ? (
            <div className="h-16 bg-muted rounded animate-pulse" />
          ) : servers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No MCP servers yet. Add one to make its tools available to tasks.</p>
          ) : (
            <div className="flex flex-col divide-y divide-border border border-border rounded-md">
              {servers.map((s) => (
                <div key={s.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 py-3">
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-sm font-medium truncate flex items-center gap-2">
                      {s.name}
                      <Badge variant="secondary">{s.transport === "stdio" ? "stdio" : s.transport.toUpperCase()}</Badge>
                      {!s.enabled && <Badge variant="outline">Disabled</Badge>}
                    </span>
                    {s.description && <span className="text-xs text-muted-foreground truncate">{s.description}</span>}
                    <span className="text-xs text-muted-foreground font-mono truncate">{summary(s)}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Switch
                      checked={s.enabled}
                      onCheckedChange={(v) => void handleToggle(s, v)}
                      aria-label={`${s.enabled ? "Disable" : "Enable"} ${s.name}`}
                    />
                    <Button variant="ghost" size="sm" onClick={() => openEdit(s)} aria-label={`Edit ${s.name}`}>
                      <Pencil className="size-4" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => handleDelete(s)} aria-label={`Remove ${s.name}`}>
                      <Trash2 className="size-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
