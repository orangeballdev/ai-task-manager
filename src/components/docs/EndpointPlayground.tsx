"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "./CodeBlock";
import { useDocsApiKey } from "@/lib/use-docs-api-key";
import { resolvePath, withQuery, buildCurl, buildJavaScript, buildPython } from "@/lib/api-code-samples";
import type { ApiEndpoint } from "@/lib/api-endpoints";

type Lang = "curl" | "js" | "python";
const LANGS: { id: Lang; label: string }[] = [
  { id: "curl", label: "cURL" },
  { id: "js", label: "JavaScript" },
  { id: "python", label: "Python" },
];

interface SendResult {
  status: number;
  ok: boolean;
  body: string;
}

/**
 * The "Try it" console for one documented endpoint — a real, live request against this
 * app's own /api/v1/* routes (not a mock). Renders editable inputs for the endpoint's
 * path/query/body params, the equivalent cURL/JS/Python for whatever's currently filled
 * in, a Send button, and the actual response.
 */
export function EndpointPlayground({ endpoint }: { endpoint: ApiEndpoint }) {
  const [apiKey, setApiKey] = useDocsApiKey();
  const [origin, setOrigin] = useState("");
  const [lang, setLang] = useState<Lang>("curl");
  const [pathValues, setPathValues] = useState<Record<string, string>>({});
  const [queryValues, setQueryValues] = useState<Record<string, string>>({});
  const [bodyText, setBodyText] = useState(endpoint.bodyExample ?? "");
  const [sending, setSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [result, setResult] = useState<SendResult | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- window.location is only available client-side; mirrors EmailIntegrationCard's origin pattern
    setOrigin(window.location.origin);
  }, []);

  const sampleOpts = useMemo(
    () => ({ origin, apiKey, pathValues, queryValues, body: endpoint.bodyParams ? bodyText.trim() || undefined : undefined }),
    [origin, apiKey, pathValues, queryValues, bodyText, endpoint.bodyParams]
  );

  const sample =
    lang === "curl" ? buildCurl(endpoint, sampleOpts)
    : lang === "js" ? buildJavaScript(endpoint, sampleOpts)
    : buildPython(endpoint, sampleOpts);

  async function handleSend() {
    setErrorMsg(null);

    const missingPath = (endpoint.pathParams ?? []).find((p) => p.required && !pathValues[p.name]?.trim());
    if (missingPath) {
      setErrorMsg(`"${missingPath.name}" is required.`);
      return;
    }
    if (!apiKey.trim()) {
      setErrorMsg("Paste an API key below first (create one under Settings -> API).");
      return;
    }

    let parsedBody: unknown;
    if (endpoint.bodyParams && bodyText.trim()) {
      try {
        parsedBody = JSON.parse(bodyText);
      } catch {
        setErrorMsg("Request body isn't valid JSON.");
        return;
      }
    }

    setSending(true);
    setResult(null);
    try {
      const url = withQuery(resolvePath(endpoint, pathValues), queryValues);
      const res = await fetch(url, {
        method: endpoint.method,
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          ...(parsedBody !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: parsedBody !== undefined ? JSON.stringify(parsedBody) : undefined,
      });
      const text = await res.text();
      let pretty = text;
      try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* non-JSON response, show raw */ }
      setResult({ status: res.status, ok: res.ok, body: pretty });
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Request failed — is the app running?");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="rounded-lg border border-border overflow-hidden bg-card">
      <div className="bg-muted/40 px-4 py-3 border-b border-border flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1 flex-1 min-w-[200px]">
          <Label htmlFor={`api-key-${endpoint.id}`} className="text-xs text-muted-foreground">API key</Label>
          <Input
            id={`api-key-${endpoint.id}`}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="tm_live_..."
            className="font-mono text-xs h-8"
          />
        </div>
        <Link href="/settings/api" className="text-xs text-primary hover:underline whitespace-nowrap pb-1.5">
          Get a key →
        </Link>
      </div>

      <div className="grid md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-border">
        <div className="p-4 flex flex-col gap-4">
          {(endpoint.pathParams?.length || endpoint.queryParams?.length) ? (
            <div className="flex flex-col gap-3">
              {endpoint.pathParams?.map((p) => (
                <div key={p.name} className="flex flex-col gap-1">
                  <Label htmlFor={`${endpoint.id}-path-${p.name}`} className="text-xs">
                    {p.name} <span className="text-muted-foreground font-normal">(path)</span>
                  </Label>
                  <Input
                    id={`${endpoint.id}-path-${p.name}`}
                    value={pathValues[p.name] ?? ""}
                    onChange={(e) => setPathValues((v) => ({ ...v, [p.name]: e.target.value }))}
                    placeholder={p.example ?? `e.g. clx1a2b3c0000`}
                    className="font-mono text-xs h-8"
                  />
                </div>
              ))}
              {endpoint.queryParams?.map((p) => (
                <div key={p.name} className="flex flex-col gap-1">
                  <Label htmlFor={`${endpoint.id}-query-${p.name}`} className="text-xs">
                    {p.name} <span className="text-muted-foreground font-normal">(query, optional)</span>
                  </Label>
                  <Input
                    id={`${endpoint.id}-query-${p.name}`}
                    value={queryValues[p.name] ?? ""}
                    onChange={(e) => setQueryValues((v) => ({ ...v, [p.name]: e.target.value }))}
                    placeholder={p.example ?? p.type}
                    className="font-mono text-xs h-8"
                  />
                </div>
              ))}
            </div>
          ) : null}

          {endpoint.bodyParams && (
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${endpoint.id}-body`} className="text-xs">Request body (JSON)</Label>
              <Textarea
                id={`${endpoint.id}-body`}
                value={bodyText}
                onChange={(e) => setBodyText(e.target.value)}
                rows={10}
                className="font-mono text-xs"
              />
            </div>
          )}

          <div className="flex flex-col gap-2">
            <div className="flex gap-1">
              {LANGS.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => setLang(l.id)}
                  className={`text-xs px-2 py-1 rounded-md transition-colors ${
                    lang === l.id ? "bg-muted text-foreground font-medium" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {l.label}
                </button>
              ))}
            </div>
            <CodeBlock code={sample} />
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={handleSend} disabled={sending} size="sm">
              {sending ? "Sending…" : `Send ${endpoint.method} request`}
            </Button>
            {errorMsg && <p className="text-xs text-destructive">{errorMsg}</p>}
          </div>
        </div>

        <div className="p-4 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {result ? "Response" : "Example response"}
            </span>
            {result && (
              <span
                className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                  result.ok ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"
                }`}
              >
                {result.status}
              </span>
            )}
          </div>
          <CodeBlock code={result ? result.body : endpoint.responseExample} />
        </div>
      </div>
    </div>
  );
}
