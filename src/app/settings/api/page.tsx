"use client";
import { copyToClipboard } from "@/lib/clipboard";
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { confirm } from "@/components/ui/confirm-dialog";
import { KeyRound, Trash2, Copy, BookOpen, Plug } from "lucide-react";
import Link from "next/link";
import { useAppOrigin } from "@/components/docs/McpSetupSnippets";
import { GatewayPauseControl } from "@/components/GatewayPauseControl";
import { apiKeyProviderValue, SMART_PROVIDER_VALUE } from "@/lib/api-key-provider";

interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  aiProviderId: string | null;
  useSmartProvider: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

interface ProviderOption {
  id: string;
  name: string;
  isDefault: boolean;
  isEnabled: boolean;
}

/**
 * The LLM gateway provider for a key, picked the same way as a task's (Advanced Options →
 * AI Provider): `""` = default provider, `"smart"` = Smart Provider, else a connection id.
 * A pin naming a since-disabled or deleted connection is still shown (so the user can see
 * why it's being skipped); the gateway falls through to the default chain for it.
 */
function ProviderPicker({
  id,
  value,
  providers,
  onChange,
  disabled,
  className,
}: {
  id?: string;
  value: string;
  providers: ProviderOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const pinned = value && value !== SMART_PROVIDER_VALUE ? providers.find((p) => p.id === value) : undefined;
  const label =
    value === SMART_PROVIDER_VALUE
      ? "Smart Provider"
      : !value
        ? "Default provider"
        : pinned
          ? `${pinned.name}${pinned.isEnabled ? "" : " (disabled)"}`
          : "Deleted provider";
  return (
    <Select value={value} onValueChange={(v) => onChange(typeof v === "string" ? v : "")} disabled={disabled}>
      <SelectTrigger id={id} className={className} aria-label="Provider">
        <SelectValue>{label}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="">Default provider</SelectItem>
        <SelectItem value={SMART_PROVIDER_VALUE}>
          Smart Provider
          <span className="ml-2 text-xs text-muted-foreground">auto-pick best available</span>
        </SelectItem>
        {providers.filter((p) => p.isEnabled).map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.name}
            {p.isDefault && <span className="ml-2 text-xs text-muted-foreground">default</span>}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString();
}

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="flex gap-2 items-center">
        <Input readOnly value={value} className="font-mono text-xs" />
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`Copy ${label}`}
          onClick={() => {
            copyToClipboard(value)
              .then(() => toast.success("Copied to clipboard"), () => toast.error("Failed to copy to clipboard"));
          }}
        >
          <Copy className="size-4" />
        </Button>
      </div>
    </div>
  );
}

/**
 * OpenAI/Anthropic-compatible gateway (src/app/api/llm/v1/*): any tool built for either API
 * can point its base URL here and run on the key's provider, authenticating with an API key
 * from the list below.
 */
function LlmGatewayCard() {
  const base = useAppOrigin();

  return (
    <Card id="llm-gateway" className="scroll-mt-24">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Plug className="size-4 text-muted-foreground" /> OpenAI / Anthropic-compatible endpoint
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Point any service that speaks the OpenAI or Anthropic API at these base URLs and use one of the
          API keys below as its API key. Requests run on the provider chosen for that key — the default
          provider (Settings → AI), Smart Provider, or one specific connection — whichever vendor it is, and are translated between the two formats when needed. Pass model <code>default</code>
          {" "}(or any model from the other vendor) to use the provider&apos;s configured model.
        </p>
        <CopyRow label="OpenAI base URL (chat/completions, models)" value={`${base}/api/llm/v1`} />
        <CopyRow label="Anthropic base URL (messages, count_tokens, models)" value={`${base}/api/llm`} />
        <p className="text-xs text-muted-foreground">
          Streaming is supported. Tool calling and images need an API-based provider; subscription CLI
          providers (Claude Code, Codex) answer text-only requests and reject tools with a 400.
        </p>
        <Link
          href="/docs/llm-gateway"
          className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline w-fit"
        >
          <BookOpen className="size-4" /> Setup guide, SDK examples &amp; provider support
        </Link>
        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <p className="text-sm font-medium">Temporarily disable</p>
          <GatewayPauseControl compact />
          <Link href="/analytics/gateway" className="text-xs text-muted-foreground hover:text-foreground w-fit">
            Token usage &amp; estimated cost → Analytics › API Proxy
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

export default function ApiKeysSettingsPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [provider, setProvider] = useState("");
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [savingProviderFor, setSavingProviderFor] = useState<string | null>(null);
  const [revealedKey, setRevealedKey] = useState<{ name: string; key: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [keysRes, providersRes] = await Promise.all([fetch("/api/api-keys"), fetch("/api/providers")]);
      setKeys(await keysRes.json());
      if (providersRes.ok) setProviders(await providersRes.json());
    } catch {
      toast.error("Failed to load API keys");
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- load() is async; setState is in a Promise, not synchronously in the effect body
  useEffect(() => { void load(); }, [load]);

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Give the key a name so you can recognize it later");
      return;
    }
    setCreating(true);
    try {
      const res = await fetch("/api/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed, provider }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(data?.error ?? "Failed to create API key");
      }
      const created = await res.json() as ApiKey & { key: string };
      setRevealedKey({ name: created.name, key: created.key });
      setName("");
      setProvider("");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create API key");
    } finally {
      setCreating(false);
    }
  }

  async function handleProviderChange(key: ApiKey, value: string) {
    setSavingProviderFor(key.id);
    try {
      const res = await fetch(`/api/api-keys/${key.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: value }),
      });
      const data = await res.json().catch(() => null) as (ApiKey & { error?: string }) | null;
      if (!res.ok || !data) throw new Error(data?.error ?? "Failed to update provider");
      setKeys((prev) => prev.map((k) => (k.id === key.id ? { ...k, ...data } : k)));
      toast.success("Provider updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update provider");
    } finally {
      setSavingProviderFor(null);
    }
  }

  async function handleDelete(key: ApiKey) {
    const ok = await confirm({
      title: "Revoke API key?",
      description: `"${key.name}" will stop working immediately. Any integration using it will get 401 Unauthorized.`,
      confirmLabel: "Revoke",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/api-keys/${key.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed");
      setKeys((prev) => prev.filter((k) => k.id !== key.id));
      toast.success("API key revoked");
    } catch {
      toast.error("Failed to revoke API key");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="pt-6 flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            API keys authenticate requests to the public Task Manager API — create a task,
            start it, and check its results from your own scripts, CI, or other services.
          </p>
          <Link
            href="/docs/api"
            className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline w-fit"
          >
            <BookOpen className="size-4" /> Read the API docs & try it live
          </Link>
        </CardContent>
      </Card>

      <LlmGatewayCard />

      <Card id="api-keys" className="scroll-mt-24">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="size-4 text-muted-foreground" /> API Keys
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {revealedKey && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 flex flex-col gap-2">
              <p className="text-sm font-medium text-foreground">
                Save &quot;{revealedKey.name}&quot; now — it won&apos;t be shown again
              </p>
              <div className="flex gap-2 items-center">
                <Input readOnly value={revealedKey.key} className="font-mono text-xs" />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    copyToClipboard(revealedKey.key)
                      .then(() => toast.success("Copied to clipboard"), () => toast.error("Failed to copy to clipboard"));
                  }}
                >
                  <Copy className="size-4" />
                </Button>
              </div>
              <Button type="button" variant="ghost" size="sm" className="w-fit" onClick={() => setRevealedKey(null)}>
                Done
              </Button>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
              <div className="flex flex-col gap-2 flex-1">
                <Label htmlFor="new-key-name">New key name</Label>
                <Input
                  id="new-key-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. CI pipeline, local script"
                  onKeyDown={(e) => { if (e.key === "Enter") void handleCreate(); }}
                />
              </div>
              <div className="flex flex-col gap-2 sm:w-56">
                <Label htmlFor="new-key-provider">Provider</Label>
                <ProviderPicker id="new-key-provider" value={provider} providers={providers} onChange={setProvider} />
              </div>
              <Button onClick={handleCreate} disabled={creating}>
                {creating ? "Creating…" : "Create key"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Which AI provider runs this key&apos;s requests to the OpenAI / Anthropic-compatible endpoint.
              {" "}<strong>Smart Provider</strong> picks the best available provider on each request. If a pinned
              provider is disabled or rate-limited, requests fall back to the default provider. Doesn&apos;t
              affect tasks created through the API.
            </p>
          </div>

          {loading ? (
            <div className="h-16 bg-muted rounded animate-pulse" />
          ) : keys.length === 0 ? (
            <p className="text-sm text-muted-foreground">No API keys yet. Create one above to start using the public API.</p>
          ) : (
            <div className="flex flex-col divide-y divide-border border border-border rounded-md">
              {keys.map((k) => (
                <div key={k.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-sm font-medium truncate">{k.name}</span>
                    <span className="text-xs text-muted-foreground font-mono">{k.keyPrefix}</span>
                    <span className="text-xs text-muted-foreground">
                      Created {formatDate(k.createdAt)} · Last used {formatDate(k.lastUsedAt)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <ProviderPicker
                      value={apiKeyProviderValue(k)}
                      providers={providers}
                      onChange={(v) => { if (v !== apiKeyProviderValue(k)) void handleProviderChange(k, v); }}
                      disabled={savingProviderFor === k.id}
                      className="w-48"
                    />
                    <Button variant="ghost" size="sm" onClick={() => handleDelete(k)} aria-label={`Revoke ${k.name}`}>
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
