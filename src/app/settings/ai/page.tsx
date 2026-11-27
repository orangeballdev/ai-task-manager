"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip } from "@/components/ui/tooltip";
import { toast } from "sonner";
import type { AIProvider, AIProviderType } from "@/lib/types";
import { ANTHROPIC_MODELS, OPENAI_MODELS, CODEX_MODELS, DEFAULT_ASSISTANT_MODEL } from "@/lib/models";
import { EFFORT_LEVELS, EFFORT_LABELS, normalizeEffort, type TaskEffort } from "@/lib/effort";
import type { ProviderHealthStatus } from "@/lib/health-check";
import { ClaudeLoginPanel } from "@/components/ClaudeLoginPanel";

async function saveSetting(key: string, value: string) {
  await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
}

interface ProviderFormState {
  name: string;
  type: AIProviderType;
  apiKey: string;
  apiKeyConfigured: boolean;
  apiKeyEditing: boolean;
  baseUrl: string;
  model: string;
  modelSelectValue: string;
  credentials: string;
  credentialsExist: boolean;
  credentialsEditing: boolean;
  configDir: string | null;
  // claude-pki
  proxyUrl: string;
  pkiCertExists: boolean;
  pkiCertFilename: string | null;
  pkiCertEditing: boolean;
  pkiPassphrase: string;
}

const TYPE_LABELS: Record<AIProviderType, string> = {
  cli: "Claude CLI",
  api: "Anthropic API",
  openai: "OpenAI / Compatible",
  "codex-cli": "Codex CLI (ChatGPT)",
  "claude-pki": "Claude (PKI / mTLS)",
};

interface ProviderFormState {
  name: string;
  type: AIProviderType;
  apiKey: string;
  apiKeyConfigured: boolean;
  apiKeyEditing: boolean;
  baseUrl: string;
  model: string;
  modelSelectValue: string;
  credentials: string;
  credentialsExist: boolean;
  credentialsEditing: boolean;
  configDir: string | null;
  // claude-pki
  proxyUrl: string;
  pkiCertExists: boolean;
  pkiCertFilename: string | null;
  pkiCertEditing: boolean;
  pkiPassphrase: string;
  // Usage cap (subscription CLIs): share of each plan window tasks may use, as typed.
  maxUsagePercent: string;
}

function emptyForm(type: AIProviderType = "cli"): ProviderFormState {
  return {
    name: "",
    type,
    apiKey: "",
    apiKeyConfigured: false,
    apiKeyEditing: false,
    baseUrl: "",
    model: type === "openai" ? "gpt-4o" : type === "codex-cli" ? "gpt-5.6-sol" : DEFAULT_ASSISTANT_MODEL,
    modelSelectValue: type === "openai" ? "gpt-4o" : type === "codex-cli" ? "gpt-5.6-sol" : DEFAULT_ASSISTANT_MODEL,
    credentials: "",
    credentialsExist: false,
    credentialsEditing: false,
    configDir: null,
    proxyUrl: "",
    pkiCertExists: false,
    pkiCertFilename: null,
    pkiCertEditing: false,
    pkiPassphrase: "",
    maxUsagePercent: "100",
  };
}

function providerToForm(p: AIProvider): ProviderFormState {
  const modelId = p.model ?? (p.type === "openai" ? "gpt-4o" : p.type === "codex-cli" ? "gpt-5.6-sol" : DEFAULT_ASSISTANT_MODEL);
  // Treat the saved model as a known selection — dynamic model list will validate it
  return {
    name: p.name,
    type: p.type,
    apiKey: "",
    apiKeyConfigured: p.apiKey === "***",
    apiKeyEditing: false,
    baseUrl: p.baseUrl ?? "",
    model: modelId,
    modelSelectValue: modelId,
    credentials: "",
    credentialsExist: false,
    credentialsEditing: false,
    configDir: null,
    proxyUrl: p.proxyUrl ?? "",
    pkiCertExists: !!p.pkiCertConfigured,
    pkiCertFilename: p.pkiCertFilename ?? null,
    pkiCertEditing: false,
    pkiPassphrase: "",
    maxUsagePercent: String(p.maxUsagePercent ?? 100),
  };
}

/** Parse the usage-cap field: a whole number 1–100, or null when it isn't one. */
function parseUsageCapField(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return 100;
  const n = Number(trimmed);
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : null;
}

function TypeBadge({ type }: { type: AIProviderType }) {
  const colors: Record<AIProviderType, string> = {
    cli: "bg-violet-500/15 text-violet-400",
    api: "bg-blue-500/15 text-blue-400",
    openai: "bg-emerald-500/15 text-emerald-400",
    "codex-cli": "bg-cyan-500/15 text-cyan-400",
    "claude-pki": "bg-amber-500/15 text-amber-400",
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${colors[type]}`}>
      {TYPE_LABELS[type]}
    </span>
  );
}

// Reads a File as a base64 string (without the data: URL prefix)
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.includes(",") ? result.split(",")[1] : result;
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function ProviderForm({
  form,
  onChange,
  onSave,
  saving,
  isNew,
  onCancel,
  providerId,
}: {
  form: ProviderFormState;
  onChange: (patch: Partial<ProviderFormState>) => void;
  onSave: () => void | Promise<void>;
  saving: boolean;
  isNew: boolean;
  onCancel: () => void;
  providerId?: string;
}) {
  const [credentialsSaving, setCredentialsSaving] = useState(false);
  const savedCredentialsRef = useRef<string>("");
  const [signingIn, setSigningIn] = useState(false);
  // Bumped after "Sign in with Claude" stores a new login, to reload the credentials below.
  const [credentialsVersion, setCredentialsVersion] = useState(0);
  const [pkiCertSaving, setPkiCertSaving] = useState(false);
  const [pkiFile, setPkiFile] = useState<File | null>(null);
  const staticModels = form.type === "codex-cli" ? CODEX_MODELS : form.type === "openai" ? OPENAI_MODELS : ANTHROPIC_MODELS;
  // Live model list, tagged with the provider + type it was fetched for. A new
  // provider (no ID) or a type change makes the tag stale, so the static list
  // shows until a fresh fetch lands.
  const dynamicModelsKey = providerId ? `${providerId}:${form.type}` : null;
  const [dynamicModels, setDynamicModels] = useState<{ key: string; models: { id: string; label: string }[] } | null>(null);
  const models = dynamicModels && dynamicModels.key === dynamicModelsKey ? dynamicModels.models : staticModels;

  // When editing an existing provider, fetch live model list from the API (no tokens consumed)
  useEffect(() => {
    if (!providerId || !dynamicModelsKey) return;
    let cancelled = false;
    fetch(`/api/providers/${providerId}/models`)
      .then((r) => r.json())
      .then((d: { models: { id: string; label: string }[] }) => {
        if (!cancelled && d.models?.length) setDynamicModels({ key: dynamicModelsKey, models: d.models });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [providerId, dynamicModelsKey]);

  useEffect(() => {
    if (!providerId || (form.type !== "cli" && form.type !== "codex-cli")) return;
    fetch(`/api/providers/${providerId}/credentials`)
      .then((r) => r.json())
      .then((d: { exists: boolean; configDir: string; content: string | null }) => {
        savedCredentialsRef.current = d.content ?? "";
        onChange({ credentialsExist: d.exists, configDir: d.configDir, credentials: d.content ?? "", credentialsEditing: false });
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, credentialsVersion]);

  useEffect(() => {
    if (!providerId || form.type !== "claude-pki") return;
    fetch(`/api/providers/${providerId}/pki-cert`)
      .then((r) => r.json())
      .then((d: { exists: boolean; filename: string | null }) => {
        onChange({ pkiCertExists: d.exists, pkiCertFilename: d.filename });
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, form.type]);

  // Returns false to signal handleSaveAll() should abort (validation or request failure).
  // No-op (returns true) when there's nothing pending to upload.
  async function savePkiCert(opts: { silent?: boolean } = {}): Promise<boolean> {
    if (!pkiFile || !providerId) return true;
    setPkiCertSaving(true);
    try {
      const certBase64 = await readFileAsBase64(pkiFile);
      const res = await fetch(`/api/providers/${providerId}/pki-cert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ certBase64, filename: pkiFile.name, passphrase: form.pkiPassphrase.trim() || null }),
      });
      const data = await res.json() as { ok: boolean; error?: string };
      if (data.ok) {
        if (!opts.silent) toast.success("Certificate saved");
        onChange({ pkiCertExists: true, pkiCertFilename: pkiFile.name, pkiCertEditing: false, pkiPassphrase: "" });
        setPkiFile(null);
        return true;
      }
      toast.error(data.error ?? "Failed to save certificate");
      return false;
    } catch {
      toast.error("Request failed");
      return false;
    } finally {
      setPkiCertSaving(false);
    }
  }

  async function removePkiCert() {
    if (!providerId) return;
    try {
      await fetch(`/api/providers/${providerId}/pki-cert`, { method: "DELETE" });
      onChange({ pkiCertExists: false, pkiCertFilename: null, pkiCertEditing: false });
      toast.success("Certificate removed");
    } catch {
      toast.error("Failed to remove certificate");
    }
  }

  // Returns false to signal handleSaveAll() should abort (validation or request failure).
  // No-op (returns true) when the credentials box is empty or unchanged since the last save.
  async function saveCredentials(opts: { silent?: boolean } = {}): Promise<boolean> {
    if (!providerId) return true;
    const trimmed = form.credentials.trim();
    if (!trimmed || trimmed === savedCredentialsRef.current) return true;
    try { JSON.parse(trimmed); } catch {
      toast.error("Invalid JSON: paste the full contents of the credentials file");
      return false;
    }
    setCredentialsSaving(true);
    try {
      const res = await fetch(`/api/providers/${providerId}/credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credentials: trimmed }),
      });
      const data = await res.json() as { ok: boolean; error?: string };
      if (data.ok) {
        if (!opts.silent) toast.success("Credentials saved");
        savedCredentialsRef.current = trimmed;
        onChange({ credentialsExist: true, credentialsEditing: false });
        return true;
      }
      toast.error(data.error ?? "Failed to save credentials");
      return false;
    } catch {
      toast.error("Request failed");
      return false;
    } finally {
      setCredentialsSaving(false);
    }
  }

  // Single entry point for the bottom "Save Changes" button: persists any pending
  // credentials/certificate uploads first, then the provider-level fields, so the
  // user only ever has one save action to take instead of saving each box separately.
  async function handleSaveAll() {
    const credsOk = await saveCredentials({ silent: true });
    if (!credsOk) return;
    const certOk = await savePkiCert({ silent: true });
    if (!certOk) return;
    await onSave();
  }

  const busy = saving || credentialsSaving || pkiCertSaving;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="prov-name">Name</Label>
        <Input
          id="prov-name"
          value={form.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="e.g. Work Account, Personal CLI, GPT-4o"
          autoFocus
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label>Type</Label>
        <div className="flex flex-wrap gap-2">
          {(["cli", "codex-cli", "api", "openai", "claude-pki"] as AIProviderType[]).map((t) => (
            <Button
              key={t}
              size="sm"
              type="button"
              variant={form.type === t ? "default" : "outline"}
              onClick={() => {
                const defaultModel = t === "openai" ? "gpt-4o" : t === "codex-cli" ? "gpt-5.6-sol" : DEFAULT_ASSISTANT_MODEL;
                onChange({ type: t, model: defaultModel, modelSelectValue: defaultModel });
              }}
            >
              {TYPE_LABELS[t]}
            </Button>
          ))}
        </div>
      </div>

      {(form.type === "cli" || form.type === "codex-cli") && (
        <>
          <div className="flex flex-col gap-2">
            <Label htmlFor="prov-max-usage">Max usage</Label>
            <div className="flex items-center gap-2">
              <Input
                id="prov-max-usage"
                type="number"
                inputMode="numeric"
                min={1}
                max={100}
                step={1}
                className="w-24"
                value={form.maxUsagePercent}
                onChange={(e) => onChange({ maxUsagePercent: e.target.value })}
              />
              <span className="text-sm text-muted-foreground">% of each usage window</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Tasks stop using this subscription once its 5-hour or weekly window reaches this level, and resume when that window resets. The rest stays free for your own use. For example, 90 keeps 10% free. 100 means no limit.
              {parseUsageCapField(form.maxUsagePercent) === null && (
                <span className="block text-destructive mt-1">Enter a whole number from 1 to 100.</span>
              )}
            </p>
          </div>
          {!isNew && providerId && (
            <div className="flex flex-col gap-3 border-t border-border pt-4">
              <p className="text-sm font-medium">Credentials</p>
              <p className="text-xs text-muted-foreground">
                {form.type === "codex-cli" ? <>Paste the contents of <code className="bg-muted px-1 rounded">~/.codex/auth.json</code>. It is stored securely and written back to Codex&apos;s native auth location whenever a task runs.</> : <>Sign in with the Claude account this provider should use, or paste the contents of a <code className="bg-muted px-1 rounded">~/.claude/.credentials.json</code> below. Give each task manager instance its own sign-in: copying one login to two instances makes them log each other out.</>}
              </p>
              {form.type === "cli" && (
                signingIn ? (
                  <ClaudeLoginPanel
                    providerId={providerId}
                    onDone={() => { setSigningIn(false); setCredentialsVersion((n) => n + 1); }}
                    onCancel={() => setSigningIn(false)}
                  />
                ) : (
                  <div>
                    <Button size="sm" variant="outline" type="button" onClick={() => setSigningIn(true)}>Sign in with Claude</Button>
                  </div>
                )
              )}
              {form.credentialsExist && !form.credentialsEditing ? (
                <div className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2">
                  <span className="text-sm text-muted-foreground font-mono tracking-widest">••••••••••••••••</span>
                  <Button variant="ghost" size="sm" onClick={() => onChange({ credentialsEditing: true })}>Update</Button>
                </div>
              ) : (
                <>
                  <textarea
                    value={form.credentials}
                    onChange={(e) => onChange({ credentials: e.target.value })}
                    placeholder={form.type === "codex-cli" ? '{\n  "tokens": { ... }\n}' : '{\n  "claudeAiOauth": { ... }\n}'}
                    rows={5}
                    className="w-full rounded-md border border-input bg-muted px-3 py-2 text-xs font-mono text-muted-foreground resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                  <div className="flex items-center gap-2">
                    <p className="text-xs text-muted-foreground">Saved together with the provider when you click Save Changes below.</p>
                    {form.credentialsEditing && (
                      <Button variant="ghost" size="sm" onClick={() => onChange({ credentialsEditing: false, credentials: savedCredentialsRef.current })}>Cancel</Button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}

      {form.type === "claude-pki" && (
        <>
          <div className="flex flex-col gap-2">
            <Label htmlFor="prov-pki-baseurl">Endpoint URL</Label>
            <Input
              id="prov-pki-baseurl"
              value={form.baseUrl}
              onChange={(e) => onChange({ baseUrl: e.target.value })}
              placeholder="https://claude-gateway.internal.example.com"
            />
            <p className="text-xs text-muted-foreground">Base URL of your self-hosted, Anthropic-API-compatible endpoint.</p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="prov-pki-proxy">HTTP Proxy <span className="text-muted-foreground font-normal">(optional)</span></Label>
            <Input
              id="prov-pki-proxy"
              value={form.proxyUrl}
              onChange={(e) => onChange({ proxyUrl: e.target.value })}
              placeholder="http://proxy.internal:8080"
            />
            <p className="text-xs text-muted-foreground">Requests are tunneled through this proxy; the client certificate is still presented to the endpoint above.</p>
          </div>

          {!isNew && providerId ? (
            <div className="flex flex-col gap-3 border-t border-border pt-4">
              <p className="text-sm font-medium">Client Certificate (.p12)</p>
              <p className="text-xs text-muted-foreground">
                Authenticates to the endpoint via mutual TLS. Upload the client certificate bundle (PKCS#12 / .p12) issued for this provider, plus its passphrase if it has one.
              </p>
              {form.pkiCertExists && !form.pkiCertEditing ? (
                <div className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2">
                  <span className="text-sm text-muted-foreground font-mono truncate">{form.pkiCertFilename || "certificate.p12"}</span>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" onClick={() => onChange({ pkiCertEditing: true })}>Replace</Button>
                    <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={removePkiCert}>Remove</Button>
                  </div>
                </div>
              ) : (
                <>
                  <input
                    type="file"
                    accept=".p12,.pfx"
                    onChange={(e) => setPkiFile(e.target.files?.[0] ?? null)}
                    className="text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium file:cursor-pointer cursor-pointer"
                  />
                  <Input
                    type="password"
                    value={form.pkiPassphrase}
                    onChange={(e) => onChange({ pkiPassphrase: e.target.value })}
                    placeholder="Certificate passphrase (if any)"
                  />
                  <div className="flex items-center gap-2">
                    <p className="text-xs text-muted-foreground">
                      {pkiFile ? "Uploaded together with the provider when you click Save Changes below." : "Choose a file, then click Save Changes below to upload it."}
                    </p>
                    {form.pkiCertEditing && (
                      <Button variant="ghost" size="sm" onClick={() => { onChange({ pkiCertEditing: false, pkiPassphrase: "" }); setPkiFile(null); }}>Cancel</Button>
                    )}
                  </div>
                </>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground border-t border-border pt-4">
              Save the provider first, then upload its client certificate below.
            </p>
          )}

          <div className="flex flex-col gap-2">
            <Label htmlFor="prov-pki-apikey">API Key <span className="text-muted-foreground font-normal">(optional)</span></Label>
            {form.apiKeyConfigured && !form.apiKeyEditing ? (
              <div className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2">
                <span className="text-sm text-muted-foreground font-mono tracking-widest">••••••••••••••••</span>
                <Button variant="ghost" size="sm" onClick={() => onChange({ apiKeyEditing: true })}>Change</Button>
              </div>
            ) : (
              <div className="flex gap-2 items-end">
                <Input
                  id="prov-pki-apikey"
                  type="password"
                  value={form.apiKey}
                  onChange={(e) => onChange({ apiKey: e.target.value })}
                  placeholder="Only needed if your gateway also checks an API key"
                  autoFocus={form.apiKeyEditing}
                />
                {form.apiKeyEditing && (
                  <Button variant="ghost" onClick={() => onChange({ apiKeyEditing: false, apiKey: "" })}>Cancel</Button>
                )}
              </div>
            )}
            <p className="text-xs text-muted-foreground">The client certificate is the primary credential, only set this if your gateway also validates an API key header.</p>
          </div>
        </>
      )}

      <div className="flex flex-col gap-2">
        <Label>Default Model <span className="text-muted-foreground font-normal">(optional)</span></Label>
        <Select
          value={form.modelSelectValue}
          onValueChange={(v) => {
            if (!v) return;
            onChange({ modelSelectValue: v, model: v !== "custom" ? v : "" });
          }}
        >
          <SelectTrigger><SelectValue placeholder="Select a model…" /></SelectTrigger>
          <SelectContent>
            {models.map((m) => (
              <SelectItem key={m.id} value={m.id}>{m.label} <span className="text-muted-foreground text-xs ml-1">{m.id}</span></SelectItem>
            ))}
            <SelectItem value="custom">Custom…</SelectItem>
          </SelectContent>
        </Select>
        {form.modelSelectValue === "custom" && (
          <Input
            value={form.model}
            onChange={(e) => onChange({ model: e.target.value })}
            placeholder="e.g. my-custom-model-id"
            autoFocus
          />
        )}
        <p className="text-xs text-muted-foreground">Used for all tasks on this provider unless overridden per-task.</p>
      </div>

      {(form.type === "api" || form.type === "openai") && (
        <>
          <div className="flex flex-col gap-2">
            <Label htmlFor="prov-apikey">API Key</Label>
            {form.apiKeyConfigured && !form.apiKeyEditing ? (
              <div className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2">
                <span className="text-sm text-muted-foreground font-mono tracking-widest">••••••••••••••••</span>
                <Button variant="ghost" size="sm" onClick={() => onChange({ apiKeyEditing: true })}>Change</Button>
              </div>
            ) : (
              <div className="flex gap-2 items-end">
                <Input
                  id="prov-apikey"
                  type="password"
                  value={form.apiKey}
                  onChange={(e) => onChange({ apiKey: e.target.value })}
                  placeholder={form.type === "api" ? "sk-ant-..." : "sk-..."}
                  autoFocus={form.apiKeyEditing}
                />
                {form.apiKeyEditing && (
                  <Button variant="ghost" onClick={() => onChange({ apiKeyEditing: false, apiKey: "" })}>Cancel</Button>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="prov-baseurl">Base URL</Label>
            <Input
              id="prov-baseurl"
              value={form.baseUrl}
              onChange={(e) => onChange({ baseUrl: e.target.value })}
              placeholder={form.type === "api" ? "https://api.anthropic.com" : "https://api.openai.com/v1"}
            />
            <p className="text-xs text-muted-foreground">Optional. Override for custom endpoints.</p>
          </div>
        </>
      )}

      <div className="flex gap-2 pt-2">
        <Button onClick={handleSaveAll} disabled={busy || !form.name.trim()}>
          {busy ? "Saving…" : isNew ? "Add Provider" : "Save Changes"}
        </Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function AutoSwitchSettings() {
  const [enabled, setEnabled] = useState(true);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data: Record<string, string>) => {
        if (data.auto_switch_provider !== undefined) {
          setEnabled(data.auto_switch_provider !== "false");
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  function toggleEnabled() {
    setEnabled((prev) => {
      const next = !prev;
      saveSetting("auto_switch_provider", next ? "true" : "false")
        .then(() => toast.success("Saved"))
        .catch(() => toast.error("Failed to save"));
      return next;
    });
  }

  if (!loaded) return <div className="h-24 bg-muted rounded animate-pulse" />;

  return (
    <Card>
      <CardHeader>
        <CardTitle id="auto-switch-provider" className="text-base scroll-mt-24">Auto-Switch Provider</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          When a task hits a rate limit, automatically retry with another provider that has available capacity.
          If all providers are at their limit, the task is scheduled to resume with whichever provider resets first.
        </p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={toggleEnabled}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${enabled ? "bg-primary" : "bg-muted-foreground/30"}`}
          >
            <span
              className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-4" : "translate-x-0.5"}`}
            />
          </button>
          <Label className="cursor-pointer" onClick={toggleEnabled}>
            Auto-switch when throttled
          </Label>
        </div>
      </CardContent>
    </Card>
  );
}

function SmartProviderSettings({ onEnabledChange }: { onEnabledChange?: (enabled: boolean) => void }) {
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data: Record<string, string>) => {
        if (data.smart_provider_picker !== undefined) {
          const value = data.smart_provider_picker === "true";
          setEnabled(value);
          onEnabledChange?.(value);
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleEnabled() {
    setEnabled((prev) => {
      const next = !prev;
      saveSetting("smart_provider_picker", next ? "true" : "false")
        .then(() => toast.success("Saved"))
        .catch(() => toast.error("Failed to save"));
      onEnabledChange?.(next);
      return next;
    });
  }

  if (!loaded) return <div className="h-24 bg-muted rounded animate-pulse" />;

  return (
    <Card>
      <CardHeader>
        <CardTitle id="smart-provider-picker" className="text-base scroll-mt-24">Smart Provider Picker</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Automatically select the best provider for each task at the moment it starts running, based on capability
          expiry and current availability. CLI providers whose credentials (OAuth tokens) are expiring soonest are
          prioritised, this ensures subscription capacity isn&apos;t wasted before credentials rotate. Throttled or
          expired providers are skipped. Because the pick happens at run time (not when the task is created), it
          reflects whatever providers are actually available when the task is picked up, including for retries,
          resumes, and recurring task instances.
        </p>
        <ul className="text-sm text-muted-foreground list-disc ml-4 flex flex-col gap-1">
          <li>Prefers CLI providers with credentials expiring soonest (but still valid)</li>
          <li>Falls back to API / OpenAI providers when no CLI provider is suitable</li>
          <li>Skips any provider currently throttled or with expired credentials</li>
          <li>Skips any provider marked &quot;excluded from smart pick&quot; below, even if it would otherwise score best</li>
        </ul>
        <div className="flex items-center gap-3">
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={toggleEnabled}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${enabled ? "bg-primary" : "bg-muted-foreground/30"}`}
          >
            <span
              className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-4" : "translate-x-0.5"}`}
            />
          </button>
          <Label className="cursor-pointer" onClick={toggleEnabled}>
            Enable smart provider picking by default
          </Label>
        </div>
        {enabled && (
          <p className="text-xs text-muted-foreground bg-muted/50 rounded px-3 py-2">
            Tasks with no provider specified will automatically use the best available provider, chosen when the task
            starts running. You can also select <strong>Smart Provider</strong> explicitly in a task&apos;s Advanced
            Settings.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function HealthCheckSettings() {
  const [enabled, setEnabled] = useState(true);
  const [intervalMinutes, setIntervalMinutes] = useState("60");
  const [model, setModel] = useState("");
  const [loaded, setLoaded] = useState(false);
  const savedRef = useRef<Record<string, string>>({});

  useEffect(() => {
    fetch("/api/providers/health")
      .then((r) => r.json())
      .then((data: { enabled: boolean; intervalMinutes: number; model: string }) => {
        setEnabled(data.enabled);
        setIntervalMinutes(String(data.intervalMinutes || 60));
        setModel(data.model ?? "");
        savedRef.current = {
          health_check_enabled: data.enabled ? "true" : "false",
          health_check_interval_minutes: String(data.intervalMinutes || 60),
          health_check_model: data.model ?? "",
        };
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  async function commit(key: string, value: string) {
    if (savedRef.current[key] === value) return;
    try {
      await saveSetting(key, value);
      savedRef.current[key] = value;
      toast.success("Saved");
    } catch {
      toast.error("Failed to save");
    }
  }

  function toggleEnabled() {
    setEnabled((prev) => {
      const next = !prev;
      void commit("health_check_enabled", next ? "true" : "false");
      return next;
    });
  }

  function commitInterval() {
    const parsed = parseInt(intervalMinutes, 10);
    if (isNaN(parsed) || parsed < 1) {
      toast.error("Interval must be at least 1 minute");
      return;
    }
    void commit("health_check_interval_minutes", String(parsed));
  }

  function commitModel() {
    void commit("health_check_model", model.trim());
  }

  if (!loaded) return <div className="h-24 bg-muted rounded animate-pulse" />;

  return (
    <Card>
      <CardHeader>
        <CardTitle id="health-checks" className="text-base scroll-mt-24">Health Checks</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Periodically sends a minimal test prompt to each configured provider to verify authentication and liveness. Results are shown in the navigation bar.
        </p>

        <div className="flex items-center gap-3">
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={toggleEnabled}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${enabled ? "bg-primary" : "bg-muted-foreground/30"}`}
          >
            <span
              className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-4" : "translate-x-0.5"}`}
            />
          </button>
          <Label className="cursor-pointer" onClick={toggleEnabled}>
            Enable health checks
          </Label>
        </div>

        {enabled && (
          <>
            <div className="flex flex-col gap-2 max-w-xs">
              <Label htmlFor="hc-interval">Check interval (minutes)</Label>
              <Input
                id="hc-interval"
                type="number"
                min={1}
                value={intervalMinutes}
                onChange={(e) => setIntervalMinutes(e.target.value)}
                onBlur={commitInterval}
                placeholder="60"
              />
              <p className="text-xs text-muted-foreground">How often background health checks run automatically. Default: 60 minutes.</p>
            </div>

            <div className="flex flex-col gap-2 max-w-xs">
              <Label htmlFor="hc-model">Health check model <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Input
                id="hc-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                onBlur={commitModel}
                placeholder="Defaults: claude-haiku-4-5-20251001 / gpt-4o-mini"
              />
              <p className="text-xs text-muted-foreground">Override the model used for liveness checks. Leave blank to use the cheapest default per provider type.</p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function MaxOutputTokensSettings() {
  const [value, setValue] = useState("");
  const [loaded, setLoaded] = useState(false);
  const savedRef = useRef<string>("");

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data: Record<string, string>) => {
        if (data.claude_code_max_output_tokens) setValue(data.claude_code_max_output_tokens);
        savedRef.current = data.claude_code_max_output_tokens ?? "";
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  async function commit() {
    const trimmed = value.trim();
    if (trimmed && (isNaN(parseInt(trimmed, 10)) || parseInt(trimmed, 10) < 1)) {
      toast.error("Must be a positive number");
      return;
    }
    if (savedRef.current === trimmed) return;
    try {
      await saveSetting("claude_code_max_output_tokens", trimmed);
      savedRef.current = trimmed;
      toast.success("Saved");
    } catch {
      toast.error("Failed to save");
    }
  }

  if (!loaded) return <div className="h-24 bg-muted rounded animate-pulse" />;

  return (
    <Card>
      <CardHeader>
        <CardTitle id="max-output-tokens" className="text-base scroll-mt-24">Max Output Tokens (CLI)</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Sets <code className="bg-muted px-1 rounded">CLAUDE_CODE_MAX_OUTPUT_TOKENS</code> for the Claude CLI provider. Raise this if tasks fail with
          &ldquo;response exceeded the output token maximum&rdquo;. Only applies to Claude CLI providers.
        </p>
        <div className="flex flex-col gap-2 max-w-xs">
          <Label htmlFor="max-output-tokens">Max output tokens</Label>
          <Input
            id="max-output-tokens"
            type="number"
            min={1}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={commit}
            placeholder="32000 (CLI default)"
          />
          <p className="text-xs text-muted-foreground">Leave blank to use the CLI&apos;s default (32,000).</p>
        </div>
      </CardContent>
    </Card>
  );
}

function AgentDelegationSettings() {
  const [enabled, setEnabled] = useState(true);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data: Record<string, string>) => {
        if (data.agent_delegation_enabled !== undefined) {
          setEnabled(data.agent_delegation_enabled !== "false");
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  function toggleEnabled() {
    setEnabled((prev) => {
      const next = !prev;
      saveSetting("agent_delegation_enabled", next ? "true" : "false")
        .then(() => toast.success("Saved"))
        .catch(() => toast.error("Failed to save"));
      return next;
    });
  }

  if (!loaded) return <div className="h-24 bg-muted rounded animate-pulse" />;

  return (
    <Card>
      <CardHeader>
        <CardTitle id="agent-delegation" className="text-base scroll-mt-24">Agent Delegation</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Tells the agent it can delegate well-scoped pieces of a task to subagents (Claude Code&apos;s built-in Task tool) instead of doing everything inline, and to pick the cheapest model that can reliably do each subagent&apos;s job &mdash; Haiku for simple/mechanical work, Sonnet by default, Opus reserved for the hardest reasoning. The agent still decides, per task, whether delegating actually helps.
        </p>
        <p className="text-xs text-muted-foreground">
          Only applies to Claude CLI providers &mdash; the Anthropic API and OpenAI providers use a fixed tool set with no subagent support, so this has no effect for tasks that run on them.
        </p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={toggleEnabled}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${enabled ? "bg-primary" : "bg-muted-foreground/30"}`}
          >
            <span
              className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-4" : "translate-x-0.5"}`}
            />
          </button>
          <Label className="cursor-pointer" onClick={toggleEnabled}>
            Let the agent delegate to subagents with per-agent model selection
          </Label>
        </div>
      </CardContent>
    </Card>
  );
}

function GlobalAgentInstructions() {
  const [instructions, setInstructions] = useState("");
  const [loaded, setLoaded] = useState(false);
  const savedRef = useRef<string>("");

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data: Record<string, string>) => {
        if (data.global_agent_instructions) setInstructions(data.global_agent_instructions);
        savedRef.current = data.global_agent_instructions ?? "";
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  async function commitInstructions() {
    const value = instructions.trim();
    if (savedRef.current === value) return;
    try {
      await saveSetting("global_agent_instructions", value);
      savedRef.current = value;
      toast.success("Saved");
    } catch {
      toast.error("Failed to save");
    }
  }

  if (!loaded) return <div className="h-24 bg-muted rounded animate-pulse" />;

  return (
    <Card>
      <CardHeader>
        <CardTitle id="global-agent-instructions" className="text-base scroll-mt-24">Global Agent Instructions</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Instructions appended to <em>every</em> task prompt, regardless of provider or task type. Use this for standing conventions that apply globally, e.g. &ldquo;always write unit tests&rdquo;, &ldquo;follow our team style guide&rdquo;, or &ldquo;commit after each logical change&rdquo;. Per-task context and custom system prompts still apply on top of this.
        </p>
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          onBlur={commitInstructions}
          rows={5}
          placeholder={"e.g. Always write unit tests for new functions.\nPrefer TypeScript strict mode.\nCommit after each logical change with a descriptive message."}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <p className="text-xs text-muted-foreground">Leave blank to disable. Changes apply to new task runs; in-progress tasks are unaffected.</p>
      </CardContent>
    </Card>
  );
}

function AssistantModelSettings() {
  const [modelSelectValue, setModelSelectValue] = useState<string>(DEFAULT_ASSISTANT_MODEL);
  const [model, setModel] = useState<string>(DEFAULT_ASSISTANT_MODEL);
  const [loaded, setLoaded] = useState(false);
  const [anthropicModels, setAnthropicModels] = useState<{ id: string; label: string }[]>(ANTHROPIC_MODELS);
  const [openaiModels, setOpenaiModels] = useState<{ id: string; label: string }[]>(OPENAI_MODELS);
  const savedRef = useRef<string>("");

  useEffect(() => {
    // Load saved model setting
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data: Record<string, string>) => {
        const saved = data.prompt_builder_model;
        if (saved) {
          setModel(saved);
          setModelSelectValue(saved);
        }
        savedRef.current = saved ?? "";
        setLoaded(true);
      })
      .catch(() => setLoaded(true));

    // Fetch live model lists from Anthropic/OpenAI APIs (free — no tokens consumed)
    fetch("/api/models?type=anthropic")
      .then((r) => r.json())
      .then((d: { models: { id: string; label: string }[] }) => {
        if (d.models?.length) setAnthropicModels(d.models);
      })
      .catch(() => {});

    fetch("/api/models?type=openai")
      .then((r) => r.json())
      .then((d: { models: { id: string; label: string }[] }) => {
        if (d.models?.length) setOpenaiModels(d.models);
      })
      .catch(() => {});
  }, []);

  async function commitModel(value: string) {
    const trimmed = value.trim();
    if (savedRef.current === trimmed) return;
    try {
      await saveSetting("prompt_builder_model", trimmed);
      savedRef.current = trimmed;
      toast.success("Saved");
    } catch {
      toast.error("Failed to save");
    }
  }

  const allKnownModels = [...anthropicModels, ...openaiModels];

  if (!loaded) return <div className="h-24 bg-muted rounded animate-pulse" />;

  // If the saved model isn't in the dynamic list, show it as "Custom…" after load
  const isKnown = allKnownModels.some((m) => m.id === modelSelectValue);
  const displayValue = isKnown ? modelSelectValue : (modelSelectValue === "custom" ? "custom" : model ? "custom" : "");

  return (
    <Card>
      <CardHeader>
        <CardTitle id="prompt-builder" className="text-base scroll-mt-24">Prompt Builder & Chat Assistant</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Model used for the Prompt Builder and Task Chat assistant. This is separate from the model used to run tasks and can also be changed inline during a conversation.
        </p>

        <div className="flex flex-col gap-2 max-w-sm">
          <Label>Model</Label>
          <Select
            value={displayValue}
            onValueChange={(v) => {
              if (!v) return;
              setModelSelectValue(v);
              if (v !== "custom") {
                setModel(v);
                void commitModel(v);
              }
            }}
          >
            <SelectTrigger><SelectValue placeholder="Select a model…" /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Anthropic</SelectLabel>
                {anthropicModels.map((m) => (
                  <SelectItem key={m.id} value={m.id}>{m.label} <span className="text-muted-foreground text-xs ml-1">{m.id}</span></SelectItem>
                ))}
              </SelectGroup>
              <SelectGroup>
                <SelectLabel>OpenAI</SelectLabel>
                {openaiModels.map((m) => (
                  <SelectItem key={m.id} value={m.id}>{m.label} <span className="text-muted-foreground text-xs ml-1">{m.id}</span></SelectItem>
                ))}
              </SelectGroup>
              <SelectItem value="custom">Custom…</SelectItem>
            </SelectContent>
          </Select>
          {(displayValue === "custom") && (
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              onBlur={() => commitModel(model)}
              placeholder="e.g. my-custom-model-id"
              autoFocus
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function DefaultEffortSettings() {
  const [effort, setEffort] = useState<TaskEffort | null>(null);
  const [loaded, setLoaded] = useState(false);
  const savedRef = useRef<string>("");

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data: Record<string, string>) => {
        const saved = normalizeEffort(data.default_effort);
        setEffort(saved);
        savedRef.current = saved ?? "";
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  async function commit(value: TaskEffort | null) {
    const trimmed = value ?? "";
    if (savedRef.current === trimmed) return;
    try {
      await saveSetting("default_effort", trimmed);
      savedRef.current = trimmed;
      toast.success("Saved");
    } catch {
      toast.error("Failed to save");
    }
  }

  if (!loaded) return <div className="h-24 bg-muted rounded animate-pulse" />;

  return (
    <Card>
      <CardHeader>
        <CardTitle id="default-effort" className="text-base scroll-mt-24">Default Effort</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          The thinking effort level new tasks are pre-filled with in Advanced Options. Passed as <code className="bg-muted px-1 rounded">--effort</code> on the Claude CLI or <code className="bg-muted px-1 rounded">output_config.effort</code> on the Anthropic API. Each task can still override this individually before it&apos;s created.
        </p>
        <div className="flex flex-col gap-2 max-w-xs">
          <Label>Default effort</Label>
          <Select
            value={effort ?? "__default__"}
            onValueChange={(v) => {
              const next = v === "__default__" ? null : (v as TaskEffort);
              setEffort(next);
              void commit(next);
            }}
          >
            <SelectTrigger><SelectValue>{effort ? EFFORT_LABELS[effort] : "Provider default"}</SelectValue></SelectTrigger>
            <SelectContent>
              <SelectItem value="__default__">Provider default</SelectItem>
              {EFFORT_LEVELS.map((level) => (
                <SelectItem key={level} value={level}>{EFFORT_LABELS[level]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">Leave as &ldquo;Provider default&rdquo; to let the CLI/API use its own default effort.</p>
        </div>
      </CardContent>
    </Card>
  );
}

async function fetchProviders(): Promise<AIProvider[]> {
  const res = await fetch("/api/providers");
  return (await res.json()) as AIProvider[];
}

export default function AISettingsPage() {
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [form, setForm] = useState<ProviderFormState>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [smartPickerEnabled, setSmartPickerEnabled] = useState(false);
  const [health, setHealth] = useState<Map<string, ProviderHealthStatus>>(new Map());
  const [signInFor, setSignInFor] = useState<string | null>(null);

  const fetchHealth = useCallback(async () => {
    const res = await fetch("/api/providers/health");
    const data = (await res.json()) as { cache?: { results?: ProviderHealthStatus[] } | null };
    return new Map((data.cache?.results ?? []).map((r) => [r.providerId, r]));
  }, []);

  const loadHealth = useCallback(async () => {
    // The badges are a hint; the page works without them.
    try { setHealth(await fetchHealth()); } catch { /* ignore */ }
  }, [fetchHealth]);

  useEffect(() => {
    let cancelled = false;
    fetchHealth()
      .then((h) => { if (!cancelled) setHealth(h); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [fetchHealth]);

  const loadProviders = useCallback(async () => {
    try {
      setProviders(await fetchProviders());
    } catch {
      toast.error("Failed to load providers");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchProviders()
      .then((data) => { if (!cancelled) setProviders(data); })
      .catch(() => { if (!cancelled) toast.error("Failed to load providers"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  function startEdit(p: AIProvider) {
    setForm(providerToForm(p));
    setEditingId(p.id);
  }

  function startNew() {
    setForm(emptyForm("cli"));
    setEditingId("new");
  }

  function cancelEdit() {
    setEditingId(null);
  }

  async function setDefault(id: string) {
    try {
      await fetch(`/api/providers/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isDefault: true }),
      });
      await loadProviders();
      toast.success("Default provider updated");
    } catch {
      toast.error("Failed to update default");
    }
  }

  async function toggleEnabled(p: AIProvider) {
    try {
      await fetch(`/api/providers/${p.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isEnabled: !p.isEnabled }),
      });
      await loadProviders();
    } catch {
      toast.error("Failed to update provider");
    }
  }

  async function toggleSmartPickerExclude(p: AIProvider) {
    try {
      await fetch(`/api/providers/${p.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excludeFromSmartPicker: !p.excludeFromSmartPicker }),
      });
      await loadProviders();
      toast.success(p.excludeFromSmartPicker ? "Provider can be smart-picked again" : "Provider excluded from Smart Provider Picker");
    } catch {
      toast.error("Failed to update provider");
    }
  }

  async function deleteProvider(id: string) {
    setDeleting(id);
    try {
      const res = await fetch(`/api/providers/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json() as { error: string };
        toast.error(data.error);
        return;
      }
      await loadProviders();
      toast.success("Provider deleted");
      if (editingId === id) setEditingId(null);
    } catch {
      toast.error("Failed to delete provider");
    } finally {
      setDeleting(null);
    }
  }

  async function saveProvider() {
    const isSubscriptionForm = form.type === "cli" || form.type === "codex-cli";
    const maxUsage = parseUsageCapField(form.maxUsagePercent);
    if (isSubscriptionForm && maxUsage === null) {
      toast.error("Max usage must be a whole number from 1 to 100");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        type: form.type,
        apiKey: (form.type === "api" || form.type === "openai" || form.type === "claude-pki")
          ? (form.apiKeyEditing || !form.apiKeyConfigured ? (form.apiKey.trim() || null) : "***")
          : null,
        baseUrl: (form.type === "api" || form.type === "openai" || form.type === "claude-pki") ? (form.baseUrl.trim() || null) : null,
        model: form.model.trim() || null,
        proxyUrl: form.type === "claude-pki" ? (form.proxyUrl.trim() || null) : null,
        // Only subscription CLIs report usage, so the cap is only editable (and sent) for them.
        ...(isSubscriptionForm ? { maxUsagePercent: maxUsage } : {}),
      };

      if (editingId === "new") {
        const res = await fetch("/api/providers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const data = await res.json() as { error: string };
          toast.error(data.error);
          return;
        }
        const newProvider = await res.json() as AIProvider;
        await loadProviders();
        if (form.type === "cli" || form.type === "codex-cli") {
          // For CLI providers, immediately enter edit mode so credentials can be entered
          setForm(providerToForm(newProvider));
          setEditingId(newProvider.id);
          toast.success(form.type === "codex-cli" ? "Provider added, paste ~/.codex/auth.json below" : "Provider added, paste your credentials below");
        } else if (form.type === "claude-pki") {
          // For claude-pki providers, immediately enter edit mode so the .p12 cert can be uploaded
          setForm(providerToForm(newProvider));
          setEditingId(newProvider.id);
          toast.success("Provider added, upload your client certificate below");
        } else {
          setEditingId(null);
          toast.success("Provider added");
        }
        return;
      } else if (editingId) {
        const res = await fetch(`/api/providers/${editingId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const data = await res.json() as { error: string };
          toast.error(data.error);
          return;
        }
        toast.success("Provider updated");
      }

      await loadProviders();
      setEditingId(null);
    } catch {
      toast.error("Failed to save provider");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="h-32 bg-muted rounded animate-pulse" />;
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Provider list */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle id="ai-providers" className="text-base scroll-mt-24">AI Providers</CardTitle>
          {editingId !== "new" && (
            <Button size="sm" onClick={startNew}>Add Provider</Button>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-col gap-1 pb-1">
            <p className="text-sm text-muted-foreground">
              The <span className="font-medium text-foreground">default</span> provider is used for all new tasks unless a specific provider is selected. One provider must always be set as the default.
              {smartPickerEnabled && " While Smart Provider Picker is enabled, it chooses the provider automatically and the default cannot be changed here."}
            </p>
            <p className="text-sm text-muted-foreground">
              <strong className="text-foreground">Claude CLI</strong>: uses your Claude subscription via the installed CLI. Add multiple instances for different accounts by specifying different config directories.
            </p>
            <p className="text-sm text-muted-foreground">
              <strong className="text-foreground">Codex CLI (ChatGPT)</strong>: uses your ChatGPT/OpenAI Codex login through the installed <code>codex</code> CLI. Paste <code>~/.codex/auth.json</code>; no API key is required.
            </p>
            <p className="text-sm text-muted-foreground">
              <strong className="text-foreground">Anthropic API / OpenAI</strong>: calls the API directly with your API key. Each instance can have its own key, model, and endpoint.
            </p>
            <p className="text-sm text-muted-foreground">
              <strong className="text-foreground">Claude (PKI / mTLS)</strong>: for self-hosted Claude-compatible gateways that authenticate with a client certificate instead of (or alongside) an API key. Upload a .p12 bundle, set the endpoint URL, and optionally route through an HTTP proxy.
            </p>
          </div>

          {providers.length === 0 && editingId !== "new" && (
            <p className="text-sm text-muted-foreground">No providers configured. Add one to get started.</p>
          )}

          {editingId === "new" && (
            <div className="rounded-lg border border-border p-4">
              <p className="text-sm font-medium mb-4">New Provider</p>
              <ProviderForm
                form={form}
                onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
                onSave={saveProvider}
                saving={saving}
                isNew
                onCancel={cancelEdit}
              />
            </div>
          )}

          {providers.map((p) => (
            <div key={p.id}>
              {editingId === p.id ? (
                <div className="rounded-lg border border-border p-4">
                  <p className="text-sm font-medium mb-4">Edit {p.name}</p>
                  <ProviderForm
                    form={form}
                    onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
                    onSave={saveProvider}
                    saving={saving}
                    isNew={false}
                    onCancel={cancelEdit}
                    providerId={p.id}
                  />
                </div>
              ) : (
                <div className={`rounded-lg border px-3 py-2.5 ${p.isDefault ? "border-primary/50 bg-primary/5" : "border-border"}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex flex-col gap-1 min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-sm font-medium">{p.name}</span>
                        <TypeBadge type={p.type} />
                        {p.isDefault && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-primary/20 text-primary font-medium">default</span>
                        )}
                        {!p.isEnabled && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">disabled</span>
                        )}
                        {p.excludeFromSmartPicker && (
                          <Tooltip label="Smart Provider Picker will never auto-select this provider. It remains usable as the default or when chosen explicitly.">
                            <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">excluded from smart pick</span>
                          </Tooltip>
                        )}
                        {p.type === "cli" && health.get(p.id) && health.get(p.id)!.authStatus !== "ok" && (
                          <Tooltip label={health.get(p.id)!.authError ?? "No credentials stored for this provider"}>
                            <span className="text-xs px-1.5 py-0.5 rounded bg-destructive/15 text-destructive font-medium">
                              {health.get(p.id)!.authStatus === "missing" ? "not signed in" : "sign-in failing"}
                            </span>
                          </Tooltip>
                        )}
                        {(p.type === "cli" || p.type === "codex-cli") && (p.maxUsagePercent ?? 100) < 100 && (
                          <Tooltip label={`Tasks won't use this subscription once a usage window reaches ${p.maxUsagePercent}%, keeping ${100 - p.maxUsagePercent}% free for manual use.`}>
                            <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">max {p.maxUsagePercent}% usage</span>
                          </Tooltip>
                        )}
                      </div>
                      {p.model && (
                        <span className="text-xs text-muted-foreground font-mono">{p.model}</span>
                      )}
                    </div>
                    {/* Actions - stack on small screens */}
                    <div className="flex flex-wrap items-center gap-1 shrink-0 justify-end">
                      {p.type === "cli" && health.get(p.id) && health.get(p.id)!.authStatus !== "ok" && signInFor !== p.id && (
                        <Button variant="outline" size="sm" onClick={() => setSignInFor(p.id)} className="text-xs h-7 px-2">
                          Sign in
                        </Button>
                      )}
                      {!p.isDefault && (
                        smartPickerEnabled ? (
                          <Tooltip label="Can't set a default while Smart Provider Picker is enabled, disable it below to choose manually">
                            <Button variant="ghost" size="sm" disabled className="text-xs h-7 px-2 opacity-50 cursor-not-allowed">
                              <span className="hidden sm:inline">Set default</span>
                              <span className="sm:hidden">Default</span>
                            </Button>
                          </Tooltip>
                        ) : (
                          <Button variant="ghost" size="sm" onClick={() => setDefault(p.id)} className="text-xs h-7 px-2">
                            <span className="hidden sm:inline">Set default</span>
                            <span className="sm:hidden">Default</span>
                          </Button>
                        )
                      )}
                      <Button variant="ghost" size="sm" onClick={() => toggleEnabled(p)} className="text-xs h-7 px-2">
                        {p.isEnabled ? "Disable" : "Enable"}
                      </Button>
                      <Tooltip
                        label={
                          p.excludeFromSmartPicker
                            ? "Allow the Smart Provider Picker to auto-select this provider again"
                            : "Keep this provider out of the Smart Provider Picker's auto-selection (still usable as the default or when chosen explicitly)"
                        }
                      >
                        <Button variant="ghost" size="sm" onClick={() => toggleSmartPickerExclude(p)} className="text-xs h-7 px-2">
                          <span className="hidden sm:inline">{p.excludeFromSmartPicker ? "Include in Smart Pick" : "Exclude from Smart Pick"}</span>
                          <span className="sm:hidden">{p.excludeFromSmartPicker ? "Include" : "Exclude"}</span>
                        </Button>
                      </Tooltip>
                      <Button variant="ghost" size="sm" onClick={() => startEdit(p)} className="text-xs h-7 px-2">Edit</Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => deleteProvider(p.id)}
                        disabled={deleting === p.id}
                        className="text-destructive hover:text-destructive text-xs h-7 px-2"
                      >
                        {deleting === p.id ? "…" : "Delete"}
                      </Button>
                    </div>
                  </div>
                  {signInFor === p.id && (
                    <div className="mt-3">
                      <ClaudeLoginPanel
                        providerId={p.id}
                        onDone={() => { setSignInFor(null); void loadHealth(); void loadProviders(); }}
                        onCancel={() => setSignInFor(null)}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          </CardContent>
        </Card>

      <AutoSwitchSettings />
      <SmartProviderSettings onEnabledChange={setSmartPickerEnabled} />
      <HealthCheckSettings />
      <MaxOutputTokensSettings />
      <AgentDelegationSettings />
      <GlobalAgentInstructions />
      <AssistantModelSettings />
      <DefaultEffortSettings />
    </div>
  );
}
