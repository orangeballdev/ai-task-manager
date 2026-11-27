"use client";
import { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { Check, Loader2 } from "lucide-react";

async function saveSetting(key: string, value: string) {
  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
  if (!res.ok) throw new Error("Failed to save");
}

type FieldStatus = "idle" | "saving" | "saved";

function SavedIndicator({ status }: { status: FieldStatus }) {
  if (status === "saving") return <Loader2 className="size-3.5 animate-spin text-muted-foreground" />;
  if (status === "saved") return <Check className="size-3.5 text-green-500" />;
  return null;
}

interface VerifyResult {
  ok: boolean;
  error?: string;
  user?: { username: string; name: string; email?: string };
  isBot?: boolean;
  scopes?: string[];
  expiresAt?: string | null;
  hasWriteRepo?: boolean;
}

type Provider = "github" | "gitlab";

const PROVIDER_LABELS: Record<Provider, string> = {
  github: "GitHub",
  gitlab: "GitLab",
};

export default function GitSettingsPage() {
  const [provider, setProvider] = useState<Provider>("github");
  const [gitBaseUrl, setGitBaseUrl] = useState("");
  const savedGitBaseUrl = useRef("");

  const [gitToken, setGitToken] = useState("");
  const [gitTokenConfigured, setGitTokenConfigured] = useState(false);
  const [gitTokenEditing, setGitTokenEditing] = useState(false);

  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);

  const [defaultBaseBranch, setDefaultBaseBranch] = useState("");
  const savedDefaultBaseBranch = useRef("");

  const [gitUserName, setGitUserName] = useState("");
  const savedGitUserName = useRef("");
  const [gitUserEmail, setGitUserEmail] = useState("");
  const savedGitUserEmail = useRef("");

  const [sshKey, setSshKey] = useState("");
  const [sshKeyConfigured, setSshKeyConfigured] = useState(false);
  const [sshKeyEditing, setSshKeyEditing] = useState(false);

  const [prSyncEnabled, setPrSyncEnabled] = useState(false);

  const [autoApplyPreviousRun, setAutoApplyPreviousRun] = useState(false);

  const [status, setStatus] = useState<Record<string, FieldStatus>>({});

  function setFieldStatus(field: string, value: FieldStatus) {
    setStatus((prev) => ({ ...prev, [field]: value }));
  }

  async function commit(field: string, key: string, value: string, onSuccess?: () => void) {
    setFieldStatus(field, "saving");
    try {
      await saveSetting(key, value);
      setFieldStatus(field, "saved");
      onSuccess?.();
      setTimeout(() => setFieldStatus(field, "idle"), 1500);
    } catch {
      setFieldStatus(field, "idle");
      toast.error("Failed to save setting");
    }
  }

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data: Record<string, string>) => {
        if (data.git_access_token === "***") setGitTokenConfigured(true);
        if (data.git_ssh_key === "***") setSshKeyConfigured(true);
        if (data.git_user_name) { setGitUserName(data.git_user_name); savedGitUserName.current = data.git_user_name; }
        if (data.git_user_email) { setGitUserEmail(data.git_user_email); savedGitUserEmail.current = data.git_user_email; }
        if (data.git_provider) setProvider(data.git_provider === "self-hosted" ? "gitlab" : (data.git_provider as Provider));
        if (data.git_base_url) { setGitBaseUrl(data.git_base_url); savedGitBaseUrl.current = data.git_base_url; }
        if (data.git_default_base_branch) { setDefaultBaseBranch(data.git_default_base_branch); savedDefaultBaseBranch.current = data.git_default_base_branch; }
        setPrSyncEnabled(data.git_pr_status_sync_enabled === "true");
        setAutoApplyPreviousRun(data.git_auto_apply_previous_run_settings === "true");
      })
      .catch(() => {});
  }, []);

  const needsBaseUrl = provider === "gitlab";
  const verifyBaseUrl = provider === "github" ? "https://api.github.com" : (gitBaseUrl || "https://gitlab.com");

  async function handleVerifyToken() {
    setVerifying(true);
    setVerifyResult(null);
    try {
      const res = await fetch("/api/git/verify-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: gitToken.trim() || undefined,
          provider,
          baseUrl: verifyBaseUrl || undefined,
        }),
      });
      setVerifyResult(await res.json() as VerifyResult);
    } catch {
      setVerifyResult({ ok: false, error: "Request failed" });
    } finally {
      setVerifying(false);
    }
  }

  function handleProviderChange(p: Provider) {
    setProvider(p);
    setVerifyResult(null);
    commit("provider", "git_provider", p);
  }

  function handleBaseUrlBlur() {
    const value = gitBaseUrl.trim();
    if (value === savedGitBaseUrl.current) return;
    commit("baseUrl", "git_base_url", value, () => { savedGitBaseUrl.current = value; });
  }

  function handleDefaultBaseBranchBlur() {
    const value = defaultBaseBranch.trim();
    if (value === savedDefaultBaseBranch.current) return;
    commit("defaultBaseBranch", "git_default_base_branch", value, () => { savedDefaultBaseBranch.current = value; });
  }

  function handleUserNameBlur() {
    const value = gitUserName.trim();
    if (value === savedGitUserName.current) return;
    commit("userName", "git_user_name", value, () => { savedGitUserName.current = value; });
  }

  function handleUserEmailBlur() {
    const value = gitUserEmail.trim();
    if (value === savedGitUserEmail.current) return;
    commit("userEmail", "git_user_email", value, () => { savedGitUserEmail.current = value; });
  }

  function handleSaveToken() {
    const value = gitToken.trim();
    if (!value) return;
    commit("token", "git_access_token", value, () => {
      setGitTokenConfigured(true);
      setGitToken("");
      setGitTokenEditing(false);
      setVerifyResult(null);
    });
  }

  function togglePrSync() {
    if (!gitTokenConfigured) {
      toast.error("Add and save a personal access token first");
      return;
    }
    setPrSyncEnabled((prev) => {
      const next = !prev;
      commit("prSync", "git_pr_status_sync_enabled", next ? "true" : "false");
      return next;
    });
  }

  function toggleAutoApplyPreviousRun() {
    setAutoApplyPreviousRun((prev) => {
      const next = !prev;
      commit("autoApplyPreviousRun", "git_auto_apply_previous_run_settings", next ? "true" : "false");
      return next;
    });
  }

  function handleSaveSshKey() {
    const value = sshKey.trim();
    if (!value) return;
    commit("sshKey", "git_ssh_key", value, () => {
      setSshKeyConfigured(true);
      setSshKey("");
      setSshKeyEditing(false);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle id="git-provider" className="text-base flex items-center gap-2 scroll-mt-24">
            Git Provider
            <SavedIndicator status={status.provider ?? "idle"} />
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div>
            <Label>Provider</Label>
            <div className="flex gap-2 mt-1">
              {(["github", "gitlab"] as Provider[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => handleProviderChange(p)}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium border transition-colors ${
                    provider === p
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
                  }`}
                >
                  {PROVIDER_LABELS[p]}
                </button>
              ))}
            </div>
          </div>

          {needsBaseUrl && (
            <div>
              <Label htmlFor="git-base-url" className="flex items-center gap-2">
                GitLab URL
                <SavedIndicator status={status.baseUrl ?? "idle"} />
              </Label>
              <Input
                id="git-base-url"
                type="url"
                value={gitBaseUrl}
                onChange={(e) => setGitBaseUrl(e.target.value)}
                onBlur={handleBaseUrlBlur}
                placeholder="https://gitlab.com (leave blank to use gitlab.com)"
                className="mt-1"
              />
            </div>
          )}

          <div>
            <Label htmlFor="git-default-base-branch" className="flex items-center gap-2">
              Default PR Base Branch
              <SavedIndicator status={status.defaultBaseBranch ?? "idle"} />
            </Label>
            <Input
              id="git-default-base-branch"
              type="text"
              value={defaultBaseBranch}
              onChange={(e) => setDefaultBaseBranch(e.target.value)}
              onBlur={handleDefaultBaseBranchBlur}
              placeholder="main"
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Branch that agent pull requests target when a repo doesn&apos;t use &quot;main&quot;.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle id="auto-apply-previous-run-settings" className="text-base flex items-center gap-2 scroll-mt-24">
            Repository Defaults
            <SavedIndicator status={status.autoApplyPreviousRun ?? "idle"} />
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            When creating a task against a repo you&apos;ve used before, automatically apply the branch and
            &quot;after task completes&quot; setting from the last run against that repo, the same defaults
            the &quot;Use previous run settings&quot; button fills in, applied without an extra click.
          </p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              role="switch"
              aria-checked={autoApplyPreviousRun}
              onClick={toggleAutoApplyPreviousRun}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${autoApplyPreviousRun ? "bg-primary" : "bg-muted-foreground/30"}`}
            >
              <span
                className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${autoApplyPreviousRun ? "translate-x-4" : "translate-x-0.5"}`}
              />
            </button>
            <Label className="cursor-pointer" onClick={toggleAutoApplyPreviousRun}>
              Auto-apply previous run settings for known repos
            </Label>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle id="personal-access-token" className="text-base flex items-center gap-2 scroll-mt-24">
            Personal Access Token
            <SavedIndicator status={status.token ?? "idle"} />
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            {provider === "github"
              ? <>Classic PAT with <code className="text-xs bg-muted px-1 py-0.5 rounded">repo</code> scope, or fine-grained token with read/write access to your repos.</>
              : <>Personal access token (not a project token) with <code className="text-xs bg-muted px-1 py-0.5 rounded">write_repository</code> or <code className="text-xs bg-muted px-1 py-0.5 rounded">api</code> scope.</>
            }
          </p>
          {gitTokenConfigured && !gitTokenEditing ? (
            <div className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2">
              <span className="text-sm text-muted-foreground font-mono tracking-widest">••••••••••••••••</span>
              <Button variant="ghost" size="sm" onClick={() => setGitTokenEditing(true)}>Update</Button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div>
                <Label htmlFor="git-token">
                  {gitTokenConfigured ? "New Token" : "Token"}
                </Label>
                <Input
                  id="git-token"
                  type="password"
                  value={gitToken}
                  onChange={(e) => { setGitToken(e.target.value); setVerifyResult(null); }}
                  onKeyDown={(e) => { if (e.key === "Enter") handleSaveToken(); }}
                  placeholder={provider === "github" ? "ghp_..." : "glpat-..."}
                  className="mt-1"
                  autoFocus={gitTokenEditing}
                />
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={handleSaveToken} disabled={!gitToken.trim() || status.token === "saving"}>
                  {status.token === "saving" ? "Saving…" : "Save token"}
                </Button>
                {gitTokenEditing && (
                  <Button variant="ghost" size="sm" onClick={() => { setGitTokenEditing(false); setGitToken(""); setVerifyResult(null); }}>Cancel</Button>
                )}
              </div>
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleVerifyToken}
              disabled={verifying || (!gitToken.trim() && !gitTokenConfigured)}
            >
              {verifying ? "Verifying…" : "Verify token"}
            </Button>
          </div>

          {verifyResult && (
            <div className={`rounded-md p-3 text-sm ${verifyResult.ok ? "bg-green-950 text-green-300" : "bg-red-950 text-red-300"}`}>
              {verifyResult.error ? <p>{verifyResult.error}</p> : (
                <div className="flex flex-col gap-1">
                  {verifyResult.isBot && (
                    <p className="font-medium">Project access token detected ({verifyResult.user?.username}). Use a personal access token instead.</p>
                  )}
                  {!verifyResult.isBot && verifyResult.user && (
                    <p>Authenticated as <strong>{verifyResult.user.name}</strong> ({verifyResult.user.username}){verifyResult.user.email ? ` · ${verifyResult.user.email}` : ""}</p>
                  )}
                  {verifyResult.scopes && verifyResult.scopes.length > 0 && (
                    <p>Scopes: {verifyResult.scopes.join(", ")}</p>
                  )}
                  {verifyResult.hasWriteRepo === false && !verifyResult.isBot && (
                    <p className="font-medium">Token is missing write access, pushes will fail.</p>
                  )}
                  {verifyResult.expiresAt && (
                    <p>Expires: {new Date(verifyResult.expiresAt).toLocaleDateString()}</p>
                  )}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle id="pr-status-sync" className="text-base flex items-center gap-2 scroll-mt-24">
            Pull Request Status Sync
            <SavedIndicator status={status.prSync ?? "idle"} />
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Periodically check open pull/merge requests via the GitHub or GitLab API and move a task from
            &quot;In Review&quot; to &quot;Done&quot; on the kanban board once its PR is merged. Polls every 2 minutes.
          </p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              role="switch"
              aria-checked={prSyncEnabled}
              onClick={togglePrSync}
              disabled={!gitTokenConfigured}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed ${prSyncEnabled ? "bg-primary" : "bg-muted-foreground/30"}`}
            >
              <span
                className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${prSyncEnabled ? "translate-x-4" : "translate-x-0.5"}`}
              />
            </button>
            <Label className={gitTokenConfigured ? "cursor-pointer" : "text-muted-foreground"} onClick={togglePrSync}>
              Auto-update kanban status from PR merges
            </Label>
          </div>
          {!gitTokenConfigured && (
            <p className="text-xs text-muted-foreground">Save a personal access token above to enable this.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle id="committer-identity" className="text-base scroll-mt-24">Committer Identity</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">Name and email used for git commits.</p>
          <div>
            <Label htmlFor="git-user-name" className="flex items-center gap-2">
              Name
              <SavedIndicator status={status.userName ?? "idle"} />
            </Label>
            <Input id="git-user-name" type="text" value={gitUserName} onChange={(e) => setGitUserName(e.target.value)} onBlur={handleUserNameBlur} placeholder="Your Name" className="mt-1" />
          </div>
          <div>
            <Label htmlFor="git-user-email" className="flex items-center gap-2">
              Email
              <SavedIndicator status={status.userEmail ?? "idle"} />
            </Label>
            <Input id="git-user-email" type="email" value={gitUserEmail} onChange={(e) => setGitUserEmail(e.target.value)} onBlur={handleUserEmailBlur} placeholder="you@example.com" className="mt-1" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle id="ssh-private-key" className="text-base flex items-center gap-2 scroll-mt-24">
            SSH Private Key
            <SavedIndicator status={status.sshKey ?? "idle"} />
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Used when cloning <code className="text-xs bg-muted px-1 py-0.5 rounded">git@</code> repositories. Paste the contents of <code className="text-xs bg-muted px-1 py-0.5 rounded">~/.ssh/id_rsa</code> or similar.
          </p>
          {sshKeyConfigured && !sshKeyEditing ? (
            <div className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2">
              <span className="text-sm text-muted-foreground font-mono tracking-widest">••••••••••••••••</span>
              <Button variant="ghost" size="sm" onClick={() => setSshKeyEditing(true)}>Update</Button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <Label htmlFor="ssh-key">{sshKeyConfigured ? "New Private Key" : "Private Key"}</Label>
              <Textarea id="ssh-key" rows={6} value={sshKey} onChange={(e) => setSshKey(e.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" className="font-mono text-xs" autoFocus={sshKeyEditing} />
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={handleSaveSshKey} disabled={!sshKey.trim() || status.sshKey === "saving"}>
                  {status.sshKey === "saving" ? "Saving…" : "Save key"}
                </Button>
                {sshKeyEditing && (
                  <Button variant="ghost" size="sm" onClick={() => { setSshKeyEditing(false); setSshKey(""); }}>Cancel</Button>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
