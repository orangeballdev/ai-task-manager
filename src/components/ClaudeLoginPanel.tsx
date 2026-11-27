"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

type Phase = "starting" | "awaiting_code" | "submitting" | "failed";

/**
 * "Sign in with Claude" for a Claude subscription (`cli`) provider. Runs `claude auth login`
 * on the server (see `src/lib/providers/claude-login-runtime.ts`): the user opens the sign-in
 * page in their own browser, then pastes the code it shows back here.
 */
export function ClaudeLoginPanel({
  providerId,
  onDone,
  onCancel,
}: {
  providerId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("starting");
  const [url, setUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<string | null>(null);
  const finishedRef = useRef(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/providers/${providerId}/login`, { method: "POST" })
      .then(async (res) => {
        const data = (await res.json()) as { sessionId?: string; url?: string; error?: string };
        if (cancelled) {
          if (data.sessionId) void fetch(`/api/providers/${providerId}/login?session=${data.sessionId}`, { method: "DELETE" });
          return;
        }
        if (!res.ok || !data.sessionId || !data.url) {
          setError(data.error ?? "Couldn't start sign-in");
          setPhase("failed");
          return;
        }
        sessionRef.current = data.sessionId;
        setUrl(data.url);
        setPhase("awaiting_code");
      })
      .catch(() => {
        if (!cancelled) {
          setError("Request failed");
          setPhase("failed");
        }
      });
    return () => {
      cancelled = true;
      // Abandoned (closed, cancelled or restarted) before finishing: stop the CLI on the server.
      const session = sessionRef.current;
      if (session && !finishedRef.current) {
        void fetch(`/api/providers/${providerId}/login?session=${session}`, { method: "DELETE" });
      }
      sessionRef.current = null;
    };
  }, [providerId, attempt]);

  async function submit() {
    const session = sessionRef.current;
    if (!session || !code.trim()) return;
    setPhase("submitting");
    setError(null);
    try {
      const res = await fetch(`/api/providers/${providerId}/login/${session}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string; retry?: boolean; warning?: string };
      if (data.ok) {
        finishedRef.current = true;
        toast.success("Signed in to Claude");
        if (data.warning) toast.warning(data.warning);
        onDone();
        return;
      }
      setError(data.error ?? "Sign-in failed");
      if (data.retry) {
        setPhase("awaiting_code");
      } else {
        sessionRef.current = null;
        setPhase("failed");
      }
    } catch {
      setError("Request failed");
      setPhase("awaiting_code");
    }
  }

  function restart() {
    setUrl(null);
    setCode("");
    setError(null);
    setPhase("starting");
    setAttempt((n) => n + 1);
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/30 p-3">
      {phase === "starting" && <p className="text-sm text-muted-foreground">Starting sign-in…</p>}

      {(phase === "awaiting_code" || phase === "submitting") && url && (
        <>
          <div className="flex flex-col gap-1.5">
            <p className="text-sm">1. Open the Claude sign-in page and sign in with the account this provider should use.</p>
            <div>
              <Button size="sm" variant="outline" onClick={() => window.open(url, "_blank", "noopener,noreferrer")}>
                Open sign-in page
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <p className="text-sm">2. Paste the code it shows you.</p>
            <div className="flex gap-2">
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
                placeholder="Paste code here"
                className="font-mono text-xs"
                autoComplete="off"
                spellCheck={false}
                disabled={phase === "submitting"}
              />
              <Button size="sm" onClick={() => void submit()} disabled={phase === "submitting" || !code.trim()}>
                {phase === "submitting" ? "Signing in…" : "Sign in"}
              </Button>
            </div>
          </div>
        </>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex gap-2">
        {phase === "failed" && (
          <Button size="sm" variant="outline" onClick={restart}>Try again</Button>
        )}
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={phase === "submitting"}>Cancel</Button>
      </div>
    </div>
  );
}
