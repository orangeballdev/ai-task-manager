"use client";

/**
 * Settings → Agent Tools.
 *
 * Which external CLIs agents may use, whether each is granted to tasks by
 * default, and the credentials behind them. Individual tasks can override the
 * default either way from the new-task form (Advanced Options → Tool Access).
 * See src/lib/agent-tools.ts for the model.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { Check, CheckCircle2, ExternalLink, Loader2, TriangleAlert } from "lucide-react";
import { GITHUB_CLI_TOOL_ID, githubTokenLinks } from "@/lib/agent-tools";

interface ToolInfo {
  id: string;
  name: string;
  command: string;
  description: string;
  settingsAnchor: string;
  grantedByDefault: boolean;
}

interface AgentToolsState {
  tools: ToolInfo[];
  github: {
    installed: boolean;
    version: string | null;
    dedicatedToken: boolean;
    useGitToken: boolean;
    gitTokenAvailable: boolean;
    ready: boolean;
  };
}

interface VerifyResult {
  ok: boolean;
  error?: string;
  user?: { username: string; name: string };
  tokenType?: "classic" | "fine-grained";
  scopes?: string[];
  expiresAt?: string | null;
  ghInstalled?: boolean;
}

async function saveSetting(key: string, value: string) {
  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
  if (!res.ok) throw new Error("Failed to save");
}

const TOKEN_LINKS = githubTokenLinks();

export default function AgentToolsSettingsPage() {
  const [state, setState] = useState<AgentToolsState | null>(null);
  const [savingDefault, setSavingDefault] = useState<string | null>(null);

  const [token, setToken] = useState("");
  const [editingToken, setEditingToken] = useState(false);
  const [savingToken, setSavingToken] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/agent-tools");
      setState((await res.json()) as AgentToolsState);
    } catch {
      toast.error("Failed to load agent tool settings");
    }
  }, []);

  useEffect(() => {
    fetch("/api/settings/agent-tools")
      .then((r) => r.json())
      .then((d: AgentToolsState) => setState(d))
      .catch(() => toast.error("Failed to load agent tool settings"));
  }, []);

  async function setDefault(toolId: string, granted: boolean) {
    setSavingDefault(toolId);
    setState((s) => s && { ...s, tools: s.tools.map((t) => (t.id === toolId ? { ...t, grantedByDefault: granted } : t)) });
    try {
      const res = await fetch("/api/settings/agent-tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaults: { [toolId]: granted } }),
      });
      if (!res.ok) throw new Error();
    } catch {
      toast.error("Failed to save");
      await load();
    } finally {
      setSavingDefault(null);
    }
  }

  async function saveToken() {
    const value = token.trim();
    if (!value) return;
    setSavingToken(true);
    try {
      await saveSetting("github_cli_token", value);
      setToken("");
      setEditingToken(false);
      toast.success("GitHub token saved");
      await load();
    } catch {
      toast.error("Failed to save token");
    } finally {
      setSavingToken(false);
    }
  }

  async function removeToken() {
    try {
      await saveSetting("github_cli_token", "");
      setVerifyResult(null);
      toast.success("GitHub token removed");
      await load();
    } catch {
      toast.error("Failed to remove token");
    }
  }

  async function setUseGitToken(value: boolean) {
    setState((s) => s && { ...s, github: { ...s.github, useGitToken: value } });
    try {
      await saveSetting("github_cli_use_git_token", value ? "true" : "false");
      setVerifyResult(null);
      await load();
    } catch {
      toast.error("Failed to save");
    }
  }

  async function verify() {
    setVerifying(true);
    setVerifyResult(null);
    try {
      const res = await fetch("/api/settings/agent-tools/github/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim() || undefined }),
      });
      setVerifyResult((await res.json()) as VerifyResult);
    } catch {
      setVerifyResult({ ok: false, error: "Request failed" });
    } finally {
      setVerifying(false);
    }
  }

  if (!state) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading…
      </div>
    );
  }

  const github = state.tools.find((t) => t.id === GITHUB_CLI_TOOL_ID);
  const gh = state.github;
  const hasAnyToken = gh.dedicatedToken || (gh.useGitToken && gh.gitTokenAvailable);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Give agents access to external command-line tools. Each tool can be granted to every task by default, and
        any single task can override that from <strong>Advanced Options → Tool Access</strong> on the new-task form.
        A tool that isn&apos;t granted is blocked for the run: its command is replaced by a stub and its credentials are
        removed from the agent&apos;s environment.
      </p>

      {github && (
        <Card>
          <CardHeader>
            <CardTitle id={github.settingsAnchor} className="text-base flex items-center gap-2 scroll-mt-24">
              GitHub CLI
              <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-normal">gh</code>
              {gh.ready ? (
                <span className="ml-auto flex items-center gap-1 text-xs font-normal text-green-500">
                  <CheckCircle2 className="size-3.5" /> Ready
                </span>
              ) : (
                <span className="ml-auto flex items-center gap-1 text-xs font-normal text-amber-500">
                  <TriangleAlert className="size-3.5" /> Setup needed
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <p className="text-sm text-muted-foreground">
              Lets agents run <code className="text-xs bg-muted px-1 py-0.5 rounded">gh</code> — for example to open an
              issue, comment on a pull request, or check a workflow run.
            </p>

            {!gh.installed && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                The <code className="text-xs">gh</code> binary wasn&apos;t found on the server. It&apos;s included in
                the Docker image; for other installs see{" "}
                <a className="underline" href="https://cli.github.com/" target="_blank" rel="noreferrer">cli.github.com</a>.
              </div>
            )}
            {gh.installed && gh.version && <p className="text-xs text-muted-foreground -mt-3">Installed: {gh.version}</p>}

            {/* Step 1 — token */}
            <div className="flex flex-col gap-3">
              <div>
                <Label className="text-sm">1. Create a GitHub token</Label>
                <p className="text-xs text-muted-foreground mt-1">
                  Click the button, choose an expiry and which repositories agents may touch, then press
                  <strong> Generate token</strong> and paste it below. The link pre-fills the name and the permissions
                  agents need (Issues and Pull requests: read &amp; write, Contents and Actions: read).
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <a href={TOKEN_LINKS.fineGrained} target="_blank" rel="noreferrer" className={buttonVariants({ size: "sm" })}>
                  Create fine-grained token <ExternalLink className="size-3.5" />
                </a>
                <a href={TOKEN_LINKS.classic} target="_blank" rel="noreferrer" className={buttonVariants({ size: "sm", variant: "outline" })}>
                  Classic token instead <ExternalLink className="size-3.5" />
                </a>
              </div>
              <p className="text-xs text-muted-foreground">
                Fine-grained tokens are recommended: they can be limited to specific repositories. For organisation
                repositories, pick the organisation as the token&apos;s <em>Resource owner</em> (it may need an admin&apos;s
                approval).
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="github-cli-token" className="text-sm">2. Paste it here</Label>
              {gh.dedicatedToken && !editingToken ? (
                <div className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2">
                  <span className="text-sm text-muted-foreground font-mono tracking-widest">••••••••••••••••</span>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setEditingToken(true)}>Update</Button>
                    <Button variant="ghost" size="sm" onClick={() => void removeToken()}>Remove</Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <Input
                    id="github-cli-token"
                    type="password"
                    value={token}
                    onChange={(e) => { setToken(e.target.value); setVerifyResult(null); }}
                    onKeyDown={(e) => { if (e.key === "Enter") void saveToken(); }}
                    placeholder="github_pat_… or ghp_…"
                    autoFocus={editingToken}
                  />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => void saveToken()} disabled={!token.trim() || savingToken}>
                      {savingToken ? "Saving…" : "Save token"}
                    </Button>
                    {editingToken && (
                      <Button variant="ghost" size="sm" onClick={() => { setEditingToken(false); setToken(""); setVerifyResult(null); }}>
                        Cancel
                      </Button>
                    )}
                  </div>
                </div>
              )}

              <div className="flex items-start gap-3 mt-1">
                <Switch
                  id="github-cli-use-git-token"
                  checked={gh.useGitToken}
                  onCheckedChange={(v) => void setUseGitToken(v)}
                  disabled={!gh.gitTokenAvailable && !gh.useGitToken}
                />
                <div>
                  <Label htmlFor="github-cli-use-git-token" className="cursor-pointer">
                    Fall back to the token from <Link href="/settings/git#personal-access-token" className="underline">Git settings</Link>
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {gh.gitTokenAvailable
                      ? "Used only when no dedicated token is saved above. Quickest setup, but agents then get everything that token can do."
                      : "No GitHub token is saved in Git settings."}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 mt-1">
                <Button variant="outline" size="sm" onClick={() => void verify()} disabled={verifying || (!token.trim() && !hasAnyToken)}>
                  {verifying ? "Verifying…" : "Verify token"}
                </Button>
              </div>

              {verifyResult && (
                <div className={`rounded-md p-3 text-sm ${verifyResult.ok ? "bg-green-950 text-green-300" : "bg-red-950 text-red-300"}`}>
                  {verifyResult.error ? (
                    <p>{verifyResult.error}</p>
                  ) : (
                    <div className="flex flex-col gap-1">
                      <p>
                        Authenticated as <strong>{verifyResult.user?.name}</strong> ({verifyResult.user?.username})
                        {verifyResult.tokenType ? ` · ${verifyResult.tokenType} token` : ""}
                      </p>
                      {verifyResult.scopes && verifyResult.scopes.length > 0 && <p>Scopes: {verifyResult.scopes.join(", ")}</p>}
                      {verifyResult.expiresAt && <p>Expires: {verifyResult.expiresAt}</p>}
                      {verifyResult.ghInstalled === false && <p className="font-medium">Note: gh isn&apos;t installed on the server yet.</p>}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Step 3 — default */}
            <div className="flex flex-col gap-2">
              <Label className="text-sm">3. Choose the default</Label>
              <div className="flex items-start gap-3">
                <Switch
                  id="github-cli-default"
                  checked={github.grantedByDefault}
                  onCheckedChange={(v) => void setDefault(github.id, v)}
                  disabled={savingDefault === github.id}
                />
                <div>
                  <Label htmlFor="github-cli-default" className="cursor-pointer flex items-center gap-2">
                    Grant to all tasks by default
                    {savingDefault === github.id && <Loader2 className="size-3.5 animate-spin" />}
                    {savingDefault !== github.id && github.grantedByDefault && <Check className="size-3.5 text-green-500" />}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {github.grantedByDefault
                      ? "Every task gets GitHub CLI access unless it's switched off for that task."
                      : "Tasks don't get GitHub CLI access unless it's switched on for that task."}
                    {" "}Tasks that don&apos;t pick explicitly follow this setting, including ones already queued.
                  </p>
                </div>
              </div>
              {github.grantedByDefault && !gh.ready && (
                <p className="text-xs text-amber-500">
                  Granted by default, but not usable yet — {gh.installed ? "save a token above" : "gh is not installed"}.
                  Tasks will be told the tool is unavailable.
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
