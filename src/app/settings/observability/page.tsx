"use client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { confirm } from "@/components/ui/confirm-dialog";
import {
  DEFAULT_METRIC_INTERVAL_SECONDS,
  DEFAULT_OTEL_SERVICE_NAME,
  MASKED_HEADERS as MASK,
  OTEL_SETTING_KEYS as K,
  OTEL_SIGNALS,
  defaultEndpoint,
  destinationLabel,
  newDestinationId,
  type OtelProtocol,
  type OtelSignal,
  type StoredOtelDestination,
} from "@/lib/otel-config";
import { CheckCircle2, Plus, Trash2, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { UserMonitoringCard } from "@/app/settings/_components/UserMonitoringCard";

// Destinations are edited through their own route (/api/settings/otel/destinations),
// not as individual Setting rows.
type SettingKey = Exclude<(typeof K)[keyof typeof K], typeof K.destinations>;
type OtelSettings = Record<SettingKey, string>;

const DEFAULTS: OtelSettings = {
  [K.enabled]: "false",
  [K.serviceName]: "",
  [K.resourceAttributes]: "",
  [K.tracesEnabled]: "true",
  [K.metricsEnabled]: "true",
  [K.logsEnabled]: "true",
  [K.dbSpans]: "false",
  [K.toolArguments]: "false",
  [K.captureConsole]: "true",
  [K.forwardToAgent]: "false",
  [K.agentDestination]: "",
  [K.metricIntervalSeconds]: "",
};

const PROTOCOL_LABELS: Record<OtelProtocol, string> = {
  "http/protobuf": "OTLP/HTTP (protobuf)",
  "http/json": "OTLP/HTTP (JSON)",
  grpc: "OTLP/gRPC",
};

const SIGNAL_LABELS: Record<OtelSignal, string> = { traces: "Traces", metrics: "Metrics", logs: "Logs" };

interface SignalTestResult {
  signal: OtelSignal;
  ok: boolean;
  url: string;
  error?: string;
}

async function saveSetting(key: string, value: string) {
  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
  if (!res.ok) throw new Error("Failed to save");
}

async function saveDestinations(destinations: StoredOtelDestination[]): Promise<StoredOtelDestination[]> {
  const res = await fetch("/api/settings/otel/destinations", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ destinations }),
  });
  if (!res.ok) throw new Error("Failed to save");
  return ((await res.json()) as { destinations: StoredOtelDestination[] }).destinations;
}

function ToggleRow({ id, label, description, checked, onChange, disabled }: {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start gap-3">
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} className="mt-0.5" />
      <div className="flex flex-col gap-0.5">
        <Label htmlFor={id} className={disabled ? "text-muted-foreground" : "cursor-pointer"}>{label}</Label>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
    </div>
  );
}

function DestinationEditor({ dest, index, exportEnabled, globalSignals, onChange, onCommit, onSaveHeaders, onRemove }: {
  dest: StoredOtelDestination;
  index: number;
  exportEnabled: boolean;
  globalSignals: Record<OtelSignal, boolean>;
  /** Local edit only (text fields, before blur). */
  onChange: (patch: Partial<StoredOtelDestination>) => void;
  /** Edit and persist. */
  onCommit: (patch?: Partial<StoredOtelDestination>) => void;
  onSaveHeaders: (headers: string) => Promise<boolean>;
  onRemove: () => void;
}) {
  const headersConfigured = dest.headers === MASK;
  const [headersEditing, setHeadersEditing] = useState(false);
  const [headersDraft, setHeadersDraft] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResults, setTestResults] = useState<SignalTestResult[] | null>(null);
  const idp = `otel-dest-${dest.id}`;
  const showDraft = !headersConfigured || headersEditing;

  async function saveHeaders(value: string) {
    if (await onSaveHeaders(value)) {
      setHeadersEditing(false);
      setHeadersDraft("");
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResults(null);
    try {
      const res = await fetch("/api/settings/otel/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ destination: { ...dest, headers: showDraft ? headersDraft : MASK } }),
      });
      const data = await res.json() as { ok: boolean; error?: string; results?: SignalTestResult[] };
      if (data.results) setTestResults(data.results);
      if (data.ok && !(exportEnabled && dest.enabled)) {
        toast.success(`${destinationLabel(dest)} accepted the test data — switch it on to start sending`);
      } else if (data.ok) toast.success(`${destinationLabel(dest)} accepted the test data`);
      else toast.error(data.error ?? "Some signals failed — see details below");
    } catch {
      toast.error("Test request failed");
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border p-4">
      <div className="flex items-start justify-between gap-3">
        <ToggleRow
          id={`${idp}-enabled`}
          label={dest.name.trim() || dest.endpoint.trim() || `Destination ${index + 1}`}
          description={dest.enabled ? (exportEnabled ? "Receiving telemetry." : "On, but export is off at the top of the page.") : "Off — nothing is sent here."}
          checked={dest.enabled}
          onChange={() => onCommit({ enabled: !dest.enabled })}
        />
        <Button variant="ghost" size="sm" onClick={onRemove} aria-label="Remove destination">
          <Trash2 className="size-4" />
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${idp}-name`}>Name</Label>
          <Input
            id={`${idp}-name`}
            value={dest.name}
            onChange={(e) => onChange({ name: e.target.value })}
            onBlur={() => onCommit({ name: dest.name.trim() })}
            placeholder="e.g. ObiStack"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label>Protocol</Label>
          <Select value={dest.protocol} onValueChange={(v) => { if (v) onCommit({ protocol: v as OtelProtocol }); }}>
            <SelectTrigger><SelectValue>{PROTOCOL_LABELS[dest.protocol]}</SelectValue></SelectTrigger>
            <SelectContent>
              {(Object.keys(PROTOCOL_LABELS) as OtelProtocol[]).map((p) => (
                <SelectItem key={p} value={p}>{PROTOCOL_LABELS[p]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={`${idp}-endpoint`}>Endpoint</Label>
        <Input
          id={`${idp}-endpoint`}
          value={dest.endpoint}
          onChange={(e) => onChange({ endpoint: e.target.value })}
          onBlur={() => onCommit({ endpoint: dest.endpoint.trim() })}
          placeholder={defaultEndpoint(dest.protocol)}
        />
        <p className="text-xs text-muted-foreground">
          {dest.protocol === "grpc"
            ? "The collector's gRPC address, usually port 4317. Use https:// for TLS."
            : "The base OTLP/HTTP URL, usually port 4318 — /v1/traces, /v1/metrics and /v1/logs are appended automatically."}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={`${idp}-headers`}>Headers</Label>
        {!showDraft ? (
          <div className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2">
            <span className="text-sm text-muted-foreground font-mono tracking-widest">••••••••••••••••</span>
            <div className="flex gap-1">
              <Button variant="ghost" size="sm" onClick={() => setHeadersEditing(true)}>Update</Button>
              <Button variant="ghost" size="sm" onClick={() => void saveHeaders("")}>Remove</Button>
            </div>
          </div>
        ) : (
          <>
            <Textarea
              id={`${idp}-headers`}
              value={headersDraft}
              onChange={(e) => setHeadersDraft(e.target.value)}
              placeholder={"Authorization=Bearer abc123\nx-honeycomb-team=your-key"}
              rows={3}
              className="font-mono text-xs"
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void saveHeaders(headersDraft.trim())} disabled={!headersDraft.trim()}>Save headers</Button>
              {headersEditing && (
                <Button variant="ghost" size="sm" onClick={() => { setHeadersEditing(false); setHeadersDraft(""); }}>Cancel</Button>
              )}
            </div>
          </>
        )}
        <p className="text-xs text-muted-foreground">
          Optional, one <code>key=value</code> per line (or comma-separated) — typically an API key
          for a hosted backend. Stored like other credentials and never shown again.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Send</Label>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {OTEL_SIGNALS.map((signal) => (
            <div key={signal} className="flex items-center gap-2">
              <Switch
                id={`${idp}-${signal}`}
                checked={dest[signal]}
                onCheckedChange={() => onCommit({ [signal]: !dest[signal] })}
              />
              <Label htmlFor={`${idp}-${signal}`} className={globalSignals[signal] ? "cursor-pointer" : "text-muted-foreground cursor-pointer"}>
                {SIGNAL_LABELS[signal]}
              </Label>
            </div>
          ))}
        </div>
        {OTEL_SIGNALS.some((s) => dest[s] && !globalSignals[s]) && (
          <p className="text-xs text-muted-foreground">
            Greyed-out signals are switched off under Signals below, so no destination receives them.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-4">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={handleTest} disabled={testing}>
            {testing ? "Sending…" : "Send test data"}
          </Button>
          <span className="text-xs text-muted-foreground">
            Sends one of each selected signal to this destination, even while it&apos;s off.
          </span>
        </div>
        {testResults && (
          <ul className="flex flex-col gap-1.5">
            {testResults.map((r) => (
              <li key={r.signal} className="flex items-start gap-2 text-sm">
                {r.ok
                  ? <CheckCircle2 className="size-4 text-green-600 mt-0.5 shrink-0" />
                  : <XCircle className="size-4 text-destructive mt-0.5 shrink-0" />}
                <div className="min-w-0">
                  <span className="font-medium capitalize">{r.signal}</span>{" "}
                  <span className="text-muted-foreground text-xs break-all">{r.url}</span>
                  {r.error && <p className="text-xs text-destructive break-words">{r.error}</p>}
                </div>
              </li>
            ))}
          </ul>
        )}
        {testResults && !(exportEnabled && dest.enabled) && (
          <p className="text-xs text-amber-600 dark:text-amber-500">
            {!exportEnabled
              ? <>Export is still off, so nothing is being sent yet. Turn on <span className="font-medium">Export telemetry</span> at the top of this page.</>
              : <>This destination is switched off, so nothing is being sent to it yet.</>}
          </p>
        )}
      </div>
    </div>
  );
}

export default function ObservabilitySettingsPage() {
  const [settings, setSettings] = useState<OtelSettings>(DEFAULTS);
  const [destinations, setDestinations] = useState<StoredOtelDestination[]>([]);
  const [loading, setLoading] = useState(true);
  // Last value persisted per key, so committing an unchanged field is a no-op.
  const savedRef = useRef<Record<string, string>>({});
  const savedDestinationsRef = useRef("");

  useEffect(() => {
    Promise.all([
      fetch("/api/settings").then((r) => r.json()) as Promise<Record<string, string>>,
      fetch("/api/settings/otel/destinations").then((r) => r.json()) as Promise<{ destinations: StoredOtelDestination[] }>,
    ])
      .then(([data, dests]) => {
        const loaded = { ...DEFAULTS };
        for (const key of Object.keys(DEFAULTS) as SettingKey[]) {
          if (data[key] !== undefined) loaded[key] = data[key];
        }
        setSettings(loaded);
        savedRef.current = { ...loaded };
        setDestinations(dests.destinations);
        savedDestinationsRef.current = JSON.stringify(dests.destinations);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const on = (key: SettingKey) => settings[key] === "true";
  const enabled = on(K.enabled);
  const globalSignals: Record<OtelSignal, boolean> = {
    traces: on(K.tracesEnabled),
    metrics: on(K.metricsEnabled),
    logs: on(K.logsEnabled),
  };

  async function commit(key: SettingKey, value: string) {
    if (savedRef.current[key] === value) return;
    try {
      await saveSetting(key, value);
      savedRef.current[key] = value;
      toast.success("Saved");
    } catch {
      toast.error("Failed to save");
    }
  }

  function toggle(key: SettingKey) {
    const next = settings[key] === "true" ? "false" : "true";
    setSettings((prev) => ({ ...prev, [key]: next }));
    void commit(key, next);
  }

  function set(key: SettingKey, value: string) {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }

  /** Persists the whole list; returns false (after a toast) on failure. */
  async function commitDestinations(next: StoredOtelDestination[], successMessage = "Saved"): Promise<boolean> {
    setDestinations(next);
    if (JSON.stringify(next) === savedDestinationsRef.current) return true;
    try {
      const saved = await saveDestinations(next);
      savedDestinationsRef.current = JSON.stringify(saved);
      setDestinations(saved);
      toast.success(successMessage);
      return true;
    } catch {
      toast.error("Failed to save");
      return false;
    }
  }

  const patchAt = (id: string, patch: Partial<StoredOtelDestination>) =>
    destinations.map((d) => (d.id === id ? { ...d, ...patch } : d));

  function addDestination() {
    // Starts switched off: a blank endpoint means localhost, and it shouldn't
    // start exporting there while it's still being filled in.
    void commitDestinations([...destinations, {
      id: newDestinationId(),
      name: "",
      enabled: false,
      endpoint: "",
      protocol: "http/protobuf",
      headers: "",
      traces: true,
      metrics: true,
      logs: true,
    }], "Destination added");
  }

  async function removeDestination(dest: StoredOtelDestination, index: number) {
    const label = dest.name.trim() || dest.endpoint.trim() || `Destination ${index + 1}`;
    const ok = await confirm({
      title: "Remove destination",
      description: `Stop sending telemetry to ${label} and delete its settings${dest.headers ? ", including its saved headers" : ""}?`,
      confirmLabel: "Remove",
      variant: "destructive",
    });
    if (ok) void commitDestinations(destinations.filter((d) => d.id !== dest.id), "Destination removed");
  }

  // Mirrors agentDestination() in otel-config.ts, so the page shows which one the CLI really gets.
  const agentCandidates = destinations.filter(
    (d) => d.enabled && ((globalSignals.metrics && d.metrics) || (globalSignals.logs && d.logs)),
  );
  const agentDest = agentCandidates.find((d) => d.id === settings[K.agentDestination]) ?? agentCandidates[0];
  const labelOf = (d: StoredOtelDestination) =>
    d.name.trim() || d.endpoint.trim() || `Destination ${destinations.indexOf(d) + 1}`;

  if (loading) {
    return <div className="h-48 bg-muted rounded animate-pulse" />;
  }

  const activeCount = destinations.filter((d) => d.enabled).length;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle id="otel-export" className="text-base scroll-mt-24">OpenTelemetry Export</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Send traces, metrics and logs from the app, worker and integrations processes to one or
            more OTLP-compatible collectors or backends (OpenTelemetry Collector, Grafana, Honeycomb,
            Datadog, Jaeger…). Changes apply to the app immediately and to the worker and
            integrations within about 30 seconds — no restart needed.
          </p>
          <ToggleRow
            id="otel-enabled"
            label="Export telemetry"
            description={!enabled
              ? "Off — nothing is sent."
              : activeCount === 0
                ? "On, but no destination is switched on below."
                : `Exporting to ${activeCount} destination${activeCount === 1 ? "" : "s"}.`}
            checked={enabled}
            onChange={() => toggle(K.enabled)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle id="otel-destinations" className="text-base scroll-mt-24">Destinations</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Every destination receives its own copy of the selected signals, so you can feed two
            platforms at once. Each one exports independently — a slow or unreachable backend
            doesn&apos;t hold up the others.
          </p>
          {destinations.length === 0 && (
            <p className="text-sm text-muted-foreground italic">No destinations yet — add one to start exporting.</p>
          )}
          {destinations.map((dest, index) => (
            <DestinationEditor
              key={dest.id}
              dest={dest}
              index={index}
              exportEnabled={enabled}
              globalSignals={globalSignals}
              onChange={(patch) => setDestinations(patchAt(dest.id, patch))}
              onCommit={(patch = {}) => void commitDestinations(patchAt(dest.id, patch))}
              onSaveHeaders={(headers) =>
                commitDestinations(patchAt(dest.id, { headers }), headers ? "Saved" : "Headers removed")}
              onRemove={() => void removeDestination(dest, index)}
            />
          ))}
          <div>
            <Button variant="outline" size="sm" onClick={addDestination}>
              <Plus className="size-4" /> Add destination
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle id="otel-service" className="text-base scroll-mt-24">Service</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="otel-service-name">Service name</Label>
            <Input
              id="otel-service-name"
              value={settings[K.serviceName]}
              onChange={(e) => set(K.serviceName, e.target.value)}
              onBlur={() => void commit(K.serviceName, settings[K.serviceName].trim())}
              placeholder={DEFAULT_OTEL_SERVICE_NAME}
              className="max-w-sm"
            />
            <p className="text-xs text-muted-foreground">
              Each process reports as its own service: <code>{settings[K.serviceName].trim() || DEFAULT_OTEL_SERVICE_NAME}-app</code>,{" "}
              <code>-worker</code> and <code>-integrations</code>, grouped under this name as <code>service.namespace</code>.
              The same to every destination.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="otel-resource-attributes">Resource attributes</Label>
            <Textarea
              id="otel-resource-attributes"
              value={settings[K.resourceAttributes]}
              onChange={(e) => set(K.resourceAttributes, e.target.value)}
              onBlur={() => void commit(K.resourceAttributes, settings[K.resourceAttributes].trim())}
              placeholder={"deployment.environment=production\nteam=platform"}
              rows={2}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">Optional extra attributes attached to everything exported.</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle id="otel-signals" className="text-base scroll-mt-24">Signals</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            What is produced at all. Each destination can then opt out of individual signals.
          </p>
          <ToggleRow
            id="otel-traces"
            label="Traces"
            description="A task.run span per task (status, provider, model, tokens, cost) with an invoke_agent child per agent (one per team stage), plus Next.js request spans."
            checked={on(K.tracesEnabled)}
            onChange={() => toggle(K.tracesEnabled)}
          />
          {on(K.tracesEnabled) && (
            <div className="flex flex-col gap-4 pl-12">
              <ToggleRow
                id="otel-db-spans"
                label="Database query spans"
                description="A span per Prisma query with its SQL (parameters are never included), nested under the task or request that ran it. Background polling isn't traced. Adds many spans per task — every log line is a write."
                checked={on(K.dbSpans)}
                onChange={() => toggle(K.dbSpans)}
              />
              <ToggleRow
                id="otel-tool-arguments"
                label="Record tool call arguments"
                description="Add what each agent tool call was asked to do to its execute_tool span (gen_ai.tool.call.arguments): the Bash command and its description, file paths, search patterns, URLs. File contents, edits, prompts and tool output are never recorded. Values that look like secrets (tokens, passwords, keys, credentials in URLs) are masked, but that is best effort — leave this off if commands may contain secrets in other forms. Takes effect on the next tool call."
                checked={on(K.toolArguments)}
                onChange={() => toggle(K.toolArguments)}
              />
            </div>
          )}
          <ToggleRow
            id="otel-metrics"
            label="Metrics"
            description="Tasks started/finished, task duration, tokens, estimated cost, queue depth, running tasks, database query duration and database file size."
            checked={on(K.metricsEnabled)}
            onChange={() => toggle(K.metricsEnabled)}
          />
          {on(K.metricsEnabled) && (
            <div className="flex flex-col gap-2 pl-12">
              <Label htmlFor="otel-metric-interval">Export interval (seconds)</Label>
              <Input
                id="otel-metric-interval"
                type="number"
                min={5}
                value={settings[K.metricIntervalSeconds]}
                onChange={(e) => set(K.metricIntervalSeconds, e.target.value)}
                onBlur={() => void commit(K.metricIntervalSeconds, settings[K.metricIntervalSeconds].trim())}
                placeholder={String(DEFAULT_METRIC_INTERVAL_SECONDS)}
                className="max-w-32"
              />
            </div>
          )}
          <ToggleRow
            id="otel-logs"
            label="Logs"
            description="Every task log line, tagged with its task id and linked to the task's trace, plus a warning for any database query slower than 500ms."
            checked={on(K.logsEnabled)}
            onChange={() => toggle(K.logsEnabled)}
          />
          {on(K.logsEnabled) && (
            <div className="pl-12">
              <ToggleRow
                id="otel-capture-console"
                label="Include process console output"
                description="Also export what the app, worker and integrations print to stdout/stderr."
                checked={on(K.captureConsole)}
                onChange={() => toggle(K.captureConsole)}
              />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle id="otel-agent" className="text-base scroll-mt-24">Claude Code Telemetry</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ToggleRow
            id="otel-forward-agent"
            label="Forward to Claude Code"
            description="Pass a destination's settings to the Claude CLI when it runs a task, so it exports its own metrics and events (API requests, tool use, token usage) tagged with ctm.task.id. Applies to CLI-based Claude providers; takes effect on the next task."
            checked={on(K.forwardToAgent)}
            onChange={() => toggle(K.forwardToAgent)}
          />
          {on(K.forwardToAgent) && (
            <div className="flex flex-col gap-2 pl-12">
              <Label>Destination</Label>
              {agentCandidates.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No destination is switched on and receiving metrics or logs, so nothing is forwarded.
                </p>
              ) : (
                <>
                  <Select
                    value={agentDest?.id ?? ""}
                    onValueChange={(v) => {
                      if (!v) return;
                      set(K.agentDestination, v);
                      void commit(K.agentDestination, v);
                    }}
                  >
                    <SelectTrigger className="max-w-sm"><SelectValue>{agentDest ? labelOf(agentDest) : ""}</SelectValue></SelectTrigger>
                    <SelectContent>
                      {agentCandidates.map((d) => (
                        <SelectItem key={d.id} value={d.id}>{labelOf(d)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    The Claude CLI can export to only one endpoint. If this destination is switched
                    off or removed, the first remaining one is used.
                  </p>
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <UserMonitoringCard />
    </div>
  );
}
