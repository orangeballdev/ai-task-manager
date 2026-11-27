"use client";
import { copyToClipboard } from "@/lib/clipboard";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Textarea } from "@/components/ui/textarea";
import { ANTHROPIC_MODELS, OPENAI_MODELS } from "@/lib/models";

// Module-level cache so we don't re-fetch on every render
let _cachedAnthropicModels: { id: string; label: string }[] | null = null;
let _cachedOpenaiModels: { id: string; label: string }[] | null = null;
import type { AIProvider } from "@/lib/types";
import { ChevronDown, ChevronRight, MessageSquare, Mail, PowerOff } from "lucide-react";
import { useIntegrationsServiceEnabled } from "./availability";

interface IntegrationConfig {
  botToken?: string;
  appToken?: string;
  aiProviderId?: string;
  model?: string;
  inboundToken?: string;
  allowedSenders?: string;
  repoUrl?: string;
  repoAlias?: string;
}

interface Integration {
  id: string;
  name: string;
  isEnabled: boolean;
  config: IntegrationConfig;
}

const MASK = "***";

function SlackBotCard() {
  const serviceEnabled = useIntegrationsServiceEnabled();
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [anthropicModels, setAnthropicModels] = useState<{ id: string; label: string }[]>(
    _cachedAnthropicModels ?? ANTHROPIC_MODELS
  );
  const [openaiModels, setOpenaiModels] = useState<{ id: string; label: string }[]>(
    _cachedOpenaiModels ?? OPENAI_MODELS
  );

  // Local form state (separate from fetched state so we can track edits)
  const [enabled, setEnabled] = useState(false);
  const [botToken, setBotToken] = useState("");
  const [botTokenConfigured, setBotTokenConfigured] = useState(false);
  const [botTokenEditing, setBotTokenEditing] = useState(false);
  const [appToken, setAppToken] = useState("");
  const [appTokenConfigured, setAppTokenConfigured] = useState(false);
  const [appTokenEditing, setAppTokenEditing] = useState(false);
  const [aiProviderId, setAiProviderId] = useState<string>("default");
  const [modelSelectValue, setModelSelectValue] = useState("default");
  const [model, setModel] = useState("");

  const load = useCallback(async () => {
    try {
      const [intRes, provRes] = await Promise.all([
        fetch("/api/integrations"),
        fetch("/api/providers"),
      ]);
      const integrations = await intRes.json() as Integration[];
      const providerList = await provRes.json() as AIProvider[];
      setProviders(providerList);

      const slack = integrations.find((i) => i.id === "slack");
      if (slack) {
        setEnabled(slack.isEnabled);
        setBotTokenConfigured(slack.config.botToken === MASK);
        setAppTokenConfigured(slack.config.appToken === MASK);
        setAiProviderId(slack.config.aiProviderId ?? "default");
        const savedModel = slack.config.model ?? "";
        setModel(savedModel);
        // Treat the saved model as a known value — dynamic list will have it
        setModelSelectValue(savedModel || "default");
      }
    } catch {
      toast.error("Failed to load integrations");
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch live model lists (free — no tokens consumed)
  useEffect(() => {
    if (!_cachedAnthropicModels) {
      fetch("/api/models?type=anthropic")
        .then((r) => r.json())
        .then((d: { models: { id: string; label: string }[] }) => {
          if (d.models?.length) {
            _cachedAnthropicModels = d.models;
            setAnthropicModels(d.models);
          }
        })
        .catch(() => {});
    }
    if (!_cachedOpenaiModels) {
      fetch("/api/models?type=openai")
        .then((r) => r.json())
        .then((d: { models: { id: string; label: string }[] }) => {
          if (d.models?.length) {
            _cachedOpenaiModels = d.models;
            setOpenaiModels(d.models);
          }
        })
        .catch(() => {});
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- load() is async; setState is in a Promise, not synchronously in the effect body
  useEffect(() => { void load(); }, [load]);

  async function handleSave() {
    setSaving(true);
    try {
      const config: Record<string, string | undefined> = {
        aiProviderId: aiProviderId !== "default" ? aiProviderId : undefined,
        model: modelSelectValue === "default" ? undefined : (modelSelectValue === "custom" ? model.trim() || undefined : model || undefined),
      };

      // Only send token if it's been edited (not the mask placeholder)
      if (!botTokenConfigured || botTokenEditing) {
        config.botToken = botToken.trim() || undefined;
      } else {
        config.botToken = MASK; // preserve existing
      }
      if (!appTokenConfigured || appTokenEditing) {
        config.appToken = appToken.trim() || undefined;
      } else {
        config.appToken = MASK; // preserve existing
      }

      const res = await fetch(`/api/integrations/slack`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // With the service off the switch is locked, so leave the stored
        // on/off state alone and only save the credentials and model.
        body: JSON.stringify({ ...(serviceEnabled ? { isEnabled: enabled } : {}), config }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(err?.error ?? "Failed to save Slack integration");
      }
      const updated = await res.json() as Integration;
      setBotTokenConfigured(updated.config.botToken === MASK);
      setAppTokenConfigured(updated.config.appToken === MASK);
      setBotTokenEditing(false);
      setAppTokenEditing(false);
      setBotToken("");
      setAppToken("");
      toast.success("Slack integration saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save Slack integration");
    } finally {
      setSaving(false);
    }
  }

  function handleToggle() {
    if (!serviceEnabled) {
      toast.info("Integrations are turned off on this deployment", {
        description: "The Slack bot can't run here, so it can't be switched on.",
      });
      return;
    }
    setEnabled((v) => !v);
  }

  if (loading) {
    return <div className="h-16 bg-muted rounded animate-pulse" />;
  }

  // A provider pinned here can be disabled (or deleted) later. Keep it in the menu, flagged,
  // so the field doesn't silently blank out — and say what the bot does about it: it falls
  // back to any other enabled provider rather than refusing to answer.
  const pinnedProvider = aiProviderId !== "default" ? providers.find((p) => p.id === aiProviderId) : undefined;
  const pinnedUnavailable = aiProviderId !== "default" && !pinnedProvider?.isEnabled;
  const providerOptions = [
    ...providers.filter((p) => p.isEnabled),
    ...(pinnedUnavailable
      ? [{ ...(pinnedProvider ?? { id: aiProviderId, name: "Unknown provider", isEnabled: false }), name: `${pinnedProvider?.name ?? "Unknown provider"} (unavailable)` }]
      : []),
  ];

  return (
    <Card id="slack-bot" className="scroll-mt-24">
      {/* Always-visible header */}
      <CardHeader className="py-4">
        <button
          type="button"
          className="flex items-center gap-3 w-full text-left"
          onClick={() => setExpanded((v) => !v)}
        >
          <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium flex-1">Slack Bot</span>
          {serviceEnabled ? (
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${enabled ? "bg-emerald-500/15 text-emerald-400" : "bg-muted text-muted-foreground"}`}>
              {enabled ? "Enabled" : "Disabled"}
            </span>
          ) : (
            <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-amber-500/15 text-amber-600 dark:text-amber-400">
              Unavailable
            </span>
          )}
          {/* Toggle — stopPropagation so clicking it doesn't also expand/collapse.
              Locked off (but still clickable, to explain why) when the
              integrations service doesn't run on this deployment. */}
          <button
            type="button"
            role="switch"
            aria-checked={serviceEnabled && enabled}
            aria-disabled={!serviceEnabled}
            title={serviceEnabled ? undefined : "Integrations are turned off on this deployment"}
            onClick={(e) => { e.stopPropagation(); handleToggle(); }}
            className={`shrink-0 relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${serviceEnabled && enabled ? "bg-primary" : "bg-muted-foreground/30"} ${serviceEnabled ? "" : "opacity-50 cursor-not-allowed"}`}
          >
            <span
              className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${serviceEnabled && enabled ? "translate-x-4" : "translate-x-0.5"}`}
            />
          </button>
          {expanded
            ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
            : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          }
        </button>
      </CardHeader>

      {!serviceEnabled && (
        <CardContent className={expanded ? "pt-0 pb-4" : "pt-0"}>
          <div className="flex gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
            <PowerOff className="size-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
            <div className="space-y-1">
              <p className="font-medium text-foreground">Integrations are turned off on this deployment</p>
              <p className="text-muted-foreground">
                The Slack bot runs in a separate integrations service, which isn&apos;t running here, so it
                can&apos;t be switched on. You can still save credentials for later. Inbound email below
                isn&apos;t affected.
              </p>
            </div>
          </div>
        </CardContent>
      )}

      {/* Collapsible body */}
      {expanded && (
        <CardContent className="flex flex-col gap-5 pt-0">
          <p className="text-sm text-muted-foreground">
            An AI-powered Slack bot that lets your team create and manage tasks directly from Slack.
            Mention the bot in any channel or send it a DM to describe what you want to do, it can
            propose tasks, check status, view logs, and notify you when tasks complete.
          </p>

          <div className="rounded-md bg-muted/50 border border-border px-4 py-3 text-sm text-muted-foreground space-y-1">
            <p className="font-medium text-foreground">What the Slack bot can do</p>
            <ul className="list-disc list-inside space-y-0.5 text-xs mt-1">
              <li>Propose and create tasks from natural language descriptions</li>
              <li>List tasks by status (pending, running, completed, failed)</li>
              <li>Report task status and recent output</li>
              <li>Notify you in-thread when tasks complete or fail</li>
              <li>Send messages to running agents mid-task</li>
              <li>Make direct API calls to query or update the task manager</li>
            </ul>
          </div>

          <div className="flex flex-col gap-4 border-t border-border pt-4">
            <p className="text-sm font-medium">Credentials</p>
            <p className="text-xs text-muted-foreground">
              Create a Slack app with Socket Mode enabled and Bot Token Scopes: <code className="bg-muted px-1 rounded">app_mentions:read</code>, <code className="bg-muted px-1 rounded">channels:history</code>, <code className="bg-muted px-1 rounded">chat:write</code>, <code className="bg-muted px-1 rounded">groups:history</code>, <code className="bg-muted px-1 rounded">im:history</code>, <code className="bg-muted px-1 rounded">im:read</code>, <code className="bg-muted px-1 rounded">im:write</code>, <code className="bg-muted px-1 rounded">mpim:history</code>.
              Enable Socket Mode with an app-level token with <code className="bg-muted px-1 rounded">connections:write</code> scope.
            </p>

            <div className="flex flex-col gap-2">
              <Label htmlFor="bot-token">Bot Token <span className="text-muted-foreground font-normal text-xs">(xoxb-…)</span></Label>
              {botTokenConfigured && !botTokenEditing ? (
                <div className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2">
                  <span className="text-sm text-muted-foreground font-mono tracking-widest">••••••••••••••••</span>
                  <Button variant="ghost" size="sm" onClick={() => { setBotTokenEditing(true); setBotToken(""); }}>Change</Button>
                </div>
              ) : (
                <div className="flex gap-2 items-end">
                  <Input
                    id="bot-token"
                    type="password"
                    value={botToken}
                    onChange={(e) => setBotToken(e.target.value)}
                    placeholder="xoxb-..."
                    autoFocus={botTokenEditing}
                  />
                  {botTokenEditing && (
                    <Button variant="ghost" onClick={() => { setBotTokenEditing(false); setBotToken(""); }}>Cancel</Button>
                  )}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="app-token">App Token <span className="text-muted-foreground font-normal text-xs">(xapp-…)</span></Label>
              {appTokenConfigured && !appTokenEditing ? (
                <div className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2">
                  <span className="text-sm text-muted-foreground font-mono tracking-widest">••••••••••••••••</span>
                  <Button variant="ghost" size="sm" onClick={() => { setAppTokenEditing(true); setAppToken(""); }}>Change</Button>
                </div>
              ) : (
                <div className="flex gap-2 items-end">
                  <Input
                    id="app-token"
                    type="password"
                    value={appToken}
                    onChange={(e) => setAppToken(e.target.value)}
                    placeholder="xapp-..."
                    autoFocus={appTokenEditing}
                  />
                  {appTokenEditing && (
                    <Button variant="ghost" onClick={() => { setAppTokenEditing(false); setAppToken(""); }}>Cancel</Button>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-4 border-t border-border pt-4">
            <p className="text-sm font-medium">AI Configuration</p>
            <p className="text-xs text-muted-foreground">
              Choose which AI provider and model the Slack bot uses for its chat responses.
              Defaults to your default AI provider if not set.
            </p>

            <div className="flex flex-col gap-2 max-w-sm">
              <Label>AI Provider</Label>
              <Select
                value={aiProviderId}
                onValueChange={(v) => {
                  if (!v) return;
                  setAiProviderId(v);
                  setModelSelectValue("default");
                  setModel("");
                }}
              >
                <SelectTrigger><SelectValue placeholder="Select a provider…" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">Default provider</SelectItem>
                  {providerOptions.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                The provider used for Slack AI chat responses. If it&apos;s ever disabled or
                rate-limited, the bot automatically uses another enabled provider instead.
              </p>
              {pinnedUnavailable && (
                <p className="text-xs text-amber-500">
                  This provider is disabled or no longer exists — the bot is currently replying with
                  another enabled provider.
                </p>
              )}
            </div>

            <div className="flex flex-col gap-2 max-w-sm">
              <Label>Model</Label>
              <Select
                value={modelSelectValue}
                onValueChange={(v) => {
                  if (!v) return;
                  setModelSelectValue(v);
                  if (v !== "custom" && v !== "default") setModel(v);
                  if (v === "default") setModel("");
                }}
              >
                <SelectTrigger><SelectValue placeholder="Select a model…" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">Provider default</SelectItem>
                  <SelectGroup>
                    <SelectLabel>Anthropic</SelectLabel>
                    {anthropicModels.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.label} <span className="text-muted-foreground text-xs ml-1">{m.id}</span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                  <SelectGroup>
                    <SelectLabel>OpenAI</SelectLabel>
                    {openaiModels.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.label} <span className="text-muted-foreground text-xs ml-1">{m.id}</span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                  <SelectItem value="custom">Custom…</SelectItem>
                </SelectContent>
              </Select>
              {modelSelectValue === "custom" && (
                <Input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="e.g. claude-sonnet-5-5"
                />
              )}
            </div>
          </div>

          <div className="flex flex-col gap-4 border-t border-border pt-4">
            <p className="text-sm font-medium">Credentials</p>
            <p className="text-xs text-muted-foreground">
              Create a Slack app with Socket Mode enabled and Bot Token Scopes: <code className="bg-muted px-1 rounded">app_mentions:read</code>, <code className="bg-muted px-1 rounded">channels:history</code>, <code className="bg-muted px-1 rounded">chat:write</code>, <code className="bg-muted px-1 rounded">groups:history</code>, <code className="bg-muted px-1 rounded">im:history</code>, <code className="bg-muted px-1 rounded">im:read</code>, <code className="bg-muted px-1 rounded">im:write</code>, <code className="bg-muted px-1 rounded">mpim:history</code>.
              Enable Socket Mode with an app-level token with <code className="bg-muted px-1 rounded">connections:write</code> scope.
            </p>

            <div className="flex flex-col gap-2">
              <Label htmlFor="bot-token">Bot Token <span className="text-muted-foreground font-normal text-xs">(xoxb-…)</span></Label>
              {botTokenConfigured && !botTokenEditing ? (
                <div className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2">
                  <span className="text-sm text-muted-foreground font-mono tracking-widest">••••••••••••••••</span>
                  <Button variant="ghost" size="sm" onClick={() => { setBotTokenEditing(true); setBotToken(""); }}>Change</Button>
                </div>
              ) : (
                <div className="flex gap-2 items-end">
                  <Input
                    id="bot-token"
                    type="password"
                    value={botToken}
                    onChange={(e) => setBotToken(e.target.value)}
                    placeholder="xoxb-..."
                    autoFocus={botTokenEditing}
                  />
                  {botTokenEditing && (
                    <Button variant="ghost" onClick={() => { setBotTokenEditing(false); setBotToken(""); }}>Cancel</Button>
                  )}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="app-token">App Token <span className="text-muted-foreground font-normal text-xs">(xapp-…)</span></Label>
              {appTokenConfigured && !appTokenEditing ? (
                <div className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2">
                  <span className="text-sm text-muted-foreground font-mono tracking-widest">••••••••••••••••</span>
                  <Button variant="ghost" size="sm" onClick={() => { setAppTokenEditing(true); setAppToken(""); }}>Change</Button>
                </div>
              ) : (
                <div className="flex gap-2 items-end">
                  <Input
                    id="app-token"
                    type="password"
                    value={appToken}
                    onChange={(e) => setAppToken(e.target.value)}
                    placeholder="xapp-..."
                    autoFocus={appTokenEditing}
                  />
                  {appTokenEditing && (
                    <Button variant="ghost" onClick={() => { setAppTokenEditing(false); setAppToken(""); }}>Cancel</Button>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-4 border-t border-border pt-4">
            <p className="text-sm font-medium">AI Configuration</p>
            <p className="text-xs text-muted-foreground">
              Choose which AI provider and model the Slack bot uses for its chat responses.
              Defaults to your default AI provider if not set.
            </p>

            <div className="flex flex-col gap-2 max-w-sm">
              <Label>AI Provider</Label>
              <Select
                value={aiProviderId}
                onValueChange={(v) => {
                  if (!v) return;
                  setAiProviderId(v);
                  setModelSelectValue("default");
                  setModel("");
                }}
              >
                <SelectTrigger><SelectValue placeholder="Select a provider…" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">Default provider</SelectItem>
                  {providerOptions.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                The provider used for Slack AI chat responses. If it&apos;s ever disabled or
                rate-limited, the bot automatically uses another enabled provider instead.
              </p>
              {pinnedUnavailable && (
                <p className="text-xs text-amber-500">
                  This provider is disabled or no longer exists — the bot is currently replying with
                  another enabled provider.
                </p>
              )}
            </div>

            <div className="flex flex-col gap-2 max-w-sm">
              <Label>Model</Label>
              <Select
                value={modelSelectValue}
                onValueChange={(v) => {
                  if (!v) return;
                  setModelSelectValue(v);
                  if (v !== "custom" && v !== "default") setModel(v);
                  if (v === "default") setModel("");
                }}
              >
                <SelectTrigger><SelectValue placeholder="Select a model…" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">Provider default</SelectItem>
                  <SelectGroup>
                    <SelectLabel>Anthropic</SelectLabel>
                    {ANTHROPIC_MODELS.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.label} <span className="text-muted-foreground text-xs ml-1">{m.id}</span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                  <SelectGroup>
                    <SelectLabel>OpenAI</SelectLabel>
                    {openaiModels.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.label} <span className="text-muted-foreground text-xs ml-1">{m.id}</span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                  <SelectItem value="custom">Custom…</SelectItem>
                </SelectContent>
              </Select>
              {modelSelectValue === "custom" && (
                <Input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="e.g. my-custom-model-id"
                  autoFocus
                />
              )}
              <p className="text-xs text-muted-foreground">
                Model used for Slack chat responses. Uses the provider&apos;s default model if not set.
              </p>
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

function EmailIntegrationCard() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const [enabled, setEnabled] = useState(false);
  const [inboundToken, setInboundToken] = useState("");
  const [tokenConfigured, setTokenConfigured] = useState(false);
  const [tokenEditing, setTokenEditing] = useState(false);
  const [allowedSenders, setAllowedSenders] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [repoAlias, setRepoAlias] = useState("");
  const [origin, setOrigin] = useState("");

  const load = useCallback(async () => {
    try {
      const intRes = await fetch("/api/integrations");
      const integrations = await intRes.json() as Integration[];

      const email = integrations.find((i) => i.id === "email");
      if (email) {
        setEnabled(email.isEnabled);
        // inboundToken is returned in full (not masked) so the webhook URL below
        // can always be reconstructed and copied, not just right after generating it.
        setInboundToken(email.config.inboundToken ?? "");
        setTokenConfigured(!!email.config.inboundToken);
        setAllowedSenders(email.config.allowedSenders ?? "");
        setRepoUrl(email.config.repoUrl ?? "");
        setRepoAlias(email.config.repoAlias ?? "");
      }
    } catch {
      toast.error("Failed to load integrations");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- window.location is only available client-side; mirrors TriggerUrl in webhooks/page.tsx
    setOrigin(window.location.origin);
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- load() is async; setState is in a Promise, not synchronously in the effect body
  useEffect(() => { void load(); }, [load]);

  const inboundUrl = inboundToken
    ? `${origin}/api/integrations/email/inbound?token=${inboundToken}`
    : "";

  async function handleSave() {
    setSaving(true);
    try {
      const config: Record<string, string | undefined> = {
        allowedSenders: allowedSenders.trim() || undefined,
        repoUrl: repoUrl.trim() || undefined,
        repoAlias: repoAlias.trim() || undefined,
        // Explicitly clear any AI provider/model previously set on this integration —
        // emailed tasks now always use the platform's default provider configuration.
        aiProviderId: "",
        model: "",
        inboundToken: inboundToken.trim() || undefined,
      };

      const res = await fetch(`/api/integrations/email`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isEnabled: enabled, config }),
      });
      if (!res.ok) throw new Error("Failed");
      const updated = await res.json() as Integration;
      setInboundToken(updated.config.inboundToken ?? "");
      setTokenConfigured(!!updated.config.inboundToken);
      setTokenEditing(false);
      toast.success("Email integration saved");
    } catch {
      toast.error("Failed to save email integration");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="h-16 bg-muted rounded animate-pulse" />;
  }

  return (
    <Card id="email-integration" className="scroll-mt-24">
      <CardHeader className="py-4">
        <button
          type="button"
          className="flex items-center gap-3 w-full text-left"
          onClick={() => setExpanded((v) => !v)}
        >
          <Mail className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium flex-1">Email</span>
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${enabled ? "bg-emerald-500/15 text-emerald-400" : "bg-muted text-muted-foreground"}`}>
            {enabled ? "Enabled" : "Disabled"}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={(e) => { e.stopPropagation(); setEnabled((v) => !v); }}
            className={`shrink-0 relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${enabled ? "bg-primary" : "bg-muted-foreground/30"}`}
          >
            <span
              className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-4" : "translate-x-0.5"}`}
            />
          </button>
          {expanded
            ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
            : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          }
        </button>
      </CardHeader>

      {expanded && (
        <CardContent className="flex flex-col gap-5 pt-0">
          <p className="text-sm text-muted-foreground">
            Create tasks by emailing (or forwarding an email to) the task manager. Add any extra
            instructions above the forwarded content, they become the task description, and the
            forwarded email is kept as context for the agent. You&apos;ll get a confirmation email
            right away and another when the task finishes.
          </p>

          <div className="rounded-md bg-muted/50 border border-border px-4 py-3 text-sm text-muted-foreground space-y-2">
            <p className="font-medium text-foreground">Setup (AWS SES)</p>
            <ol className="list-decimal list-inside space-y-1 text-xs">
              <li>Verify a domain/address for receiving in SES and add an MX record pointing at it.</li>
              <li>Create an SES receipt rule for that address with a &quot;Deliver to Amazon SNS topic&quot; action (include the message content).</li>
              <li>Subscribe this URL to that SNS topic as an HTTPS endpoint: the first request auto-confirms the subscription.</li>
              <li>Add the sender addresses you want to allow below (required, nobody can create tasks until you do).</li>
            </ol>
          </div>

          <div className="flex flex-col gap-4 border-t border-border pt-4">
            <p className="text-sm font-medium">Inbound webhook</p>

            <div className="flex flex-col gap-2">
              <Label htmlFor="inbound-token">Secret token</Label>
              {tokenConfigured && !tokenEditing ? (
                <div className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2">
                  <span className="text-sm text-muted-foreground font-mono tracking-widest">••••••••••••••••</span>
                  <Button variant="ghost" size="sm" onClick={() => { setTokenEditing(true); setInboundToken(crypto.randomUUID()); }}>Change</Button>
                </div>
              ) : (
                <div className="flex gap-2 items-end">
                  <Input
                    id="inbound-token"
                    value={inboundToken}
                    onChange={(e) => setInboundToken(e.target.value)}
                    placeholder="click generate"
                    autoFocus={tokenEditing}
                  />
                  <Button type="button" variant="outline" onClick={() => setInboundToken(crypto.randomUUID())}>Generate</Button>
                  {tokenEditing && (
                    <Button variant="ghost" onClick={() => { setTokenEditing(false); setInboundToken(""); }}>Cancel</Button>
                  )}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Included as <code className="bg-muted px-1 rounded">?token=</code> on the inbound URL below: this is the only auth SNS supports for HTTPS endpoints.
              </p>
            </div>

            {inboundUrl && (
              <div className="flex flex-col gap-2">
                <Label>Inbound URL</Label>
                <div className="flex gap-2 items-end">
                  <Input readOnly value={inboundUrl} className="font-mono text-xs" />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => copyToClipboard(inboundUrl).then(() => toast.success("URL copied"), () => toast.error("Failed to copy to clipboard"))}
                  >
                    Copy
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Subscribe this exact URL as an HTTPS endpoint on your SES SNS topic. If you just generated
                  a new token, save first so this URL matches what&apos;s stored.
                </p>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-4 border-t border-border pt-4">
            <p className="text-sm font-medium">Allowed senders</p>
            <p className="text-xs text-muted-foreground">
              Only emails from these addresses (or whole domains, e.g. <code className="bg-muted px-1 rounded">@yourcompany.com</code>) can
              create tasks. Comma or newline separated. Empty means nobody is allowed.
            </p>
            <Textarea
              value={allowedSenders}
              onChange={(e) => setAllowedSenders(e.target.value)}
              placeholder={"you@example.com\n@yourcompany.com"}
              rows={3}
            />
          </div>

          <div className="flex flex-col gap-4 border-t border-border pt-4">
            <p className="text-sm font-medium">Default repository <span className="text-muted-foreground font-normal text-xs">(optional)</span></p>
            <p className="text-xs text-muted-foreground">
              Only needed if emailed tasks should have a repo checked out to work against. Leave blank for tasks that don&apos;t touch code.
            </p>
            <div className="flex flex-col gap-2 max-w-sm">
              <Label>Clone URL</Label>
              <Input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/org/repo.git" />
            </div>
            <div className="flex flex-col gap-2 max-w-sm">
              <Label>Alias</Label>
              <Input value={repoAlias} onChange={(e) => setRepoAlias(e.target.value)} placeholder="repo" />
            </div>
          </div>

          <p className="text-xs text-muted-foreground border-t border-border pt-4">
            Emailed tasks run with the platform&apos;s default AI provider — configure that under{" "}
            <a href="/settings/ai#ai-providers" className="underline hover:text-foreground">Settings → AI Providers</a>.
          </p>

          <div className="flex justify-end pt-2">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

export default function IntegrationsSettingsPage() {
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-muted-foreground">
            Connect external services to your AI task manager. Credentials and configuration
            are stored securely in the database and applied without restarting the integrations service.
          </p>
        </CardContent>
      </Card>

      <SlackBotCard />
      <EmailIntegrationCard />
    </div>
  );
}
