"use client";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  DEFAULT_USER_MONITORING_HOST,
  USER_MONITORING_KEYS as K,
  validateUserMonitoringHost,
  validateUserMonitoringKey,
} from "@/lib/user-monitoring";

async function saveSetting(key: string, value: string) {
  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
  if (!res.ok) throw new Error("Failed to save");
}

const APPLIES_ON_RELOAD = "Takes effect the next time a page loads.";

/**
 * Settings → Observability: opt-in ObiStack user monitoring. Off by default;
 * switching it on asks for an analytics key, and it only counts as enabled once
 * one is saved (see `resolveUserMonitoring()`).
 */
export function UserMonitoringCard() {
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  // Switched on in the UI but not saved yet, because there's no key to start with.
  const [askingForKey, setAskingForKey] = useState(false);
  const [savedKey, setSavedKey] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [host, setHost] = useState("");
  const savedHost = useRef("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data: Record<string, string>) => {
        const key = data[K.apiKey] ?? "";
        setSavedKey(key);
        setKeyDraft(key);
        setEnabled(data[K.enabled] === "true" && !!key.trim());
        setHost(data[K.host] ?? "");
        savedHost.current = data[K.host] ?? "";
      })
      .catch(() => toast.error("Failed to load user monitoring settings"))
      .finally(() => setLoading(false));
  }, []);

  async function toggle(next: boolean) {
    if (next && !savedKey.trim()) {
      // Nothing to send with yet: ask for the key, save once it's entered.
      setAskingForKey(true);
      return;
    }
    setAskingForKey(false);
    setBusy(true);
    try {
      await saveSetting(K.enabled, next ? "true" : "false");
      setEnabled(next);
      toast.success(`User monitoring ${next ? "enabled" : "disabled"}. ${APPLIES_ON_RELOAD}`);
    } catch {
      toast.error("Failed to save");
    } finally {
      setBusy(false);
    }
  }

  async function saveKey() {
    const problem = validateUserMonitoringKey(keyDraft);
    setKeyError(problem);
    if (problem) return;
    const key = keyDraft.trim();
    setBusy(true);
    try {
      await saveSetting(K.apiKey, key);
      setSavedKey(key);
      setKeyDraft(key);
      if (askingForKey || !enabled) {
        await saveSetting(K.enabled, "true");
        setEnabled(true);
        setAskingForKey(false);
        toast.success(`User monitoring enabled. ${APPLIES_ON_RELOAD}`);
      } else {
        toast.success(`Analytics key saved. ${APPLIES_ON_RELOAD}`);
      }
    } catch {
      toast.error("Failed to save");
    } finally {
      setBusy(false);
    }
  }

  async function commitHost() {
    if (host === savedHost.current) return;
    const problem = validateUserMonitoringHost(host);
    if (problem) {
      toast.error(problem);
      return;
    }
    try {
      await saveSetting(K.host, host.trim());
      savedHost.current = host.trim();
      toast.success("Saved");
    } catch {
      toast.error("Failed to save");
    }
  }

  const showForm = enabled || askingForKey;
  const keyChanged = keyDraft.trim() !== savedKey.trim();

  return (
    <Card>
      <CardHeader>
        <CardTitle id="user-monitoring" className="text-base scroll-mt-24">User Monitoring</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <Switch
            id="user-monitoring-enabled"
            checked={showForm}
            onCheckedChange={(v) => void toggle(v)}
            disabled={loading || busy}
            className="mt-0.5"
          />
          <div className="flex flex-col gap-0.5">
            <Label htmlFor="user-monitoring-enabled" className="cursor-pointer">Enable user monitoring in ObiStack</Label>
            <p className="text-xs text-muted-foreground">
              Sends page views, clicks, web vitals and front-end errors from this web UI to your ObiStack workspace.
              Off by default; nothing is sent until you turn it on and add an analytics key.
            </p>
          </div>
        </div>

        {showForm && (
          <div className="flex flex-col gap-4 pl-12">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="user-monitoring-key">ObiStack analytics key</Label>
              <div className="flex gap-2 max-w-lg">
                <Input
                  id="user-monitoring-key"
                  value={keyDraft}
                  placeholder="lsk_…"
                  autoFocus={askingForKey}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => {
                    setKeyDraft(e.target.value);
                    setKeyError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveKey();
                  }}
                  className="font-mono"
                />
                <Button onClick={() => void saveKey()} disabled={busy || (!askingForKey && !keyChanged)}>
                  {askingForKey ? "Save & enable" : "Save"}
                </Button>
              </div>
              {keyError ? (
                <p className="text-xs text-red-400">{keyError}</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  The website analytics key from your ObiStack workspace. It starts with <code>lsk_</code> and is write-only.
                </p>
              )}
              {askingForKey && (
                <p className="text-xs text-amber-300">Not enabled yet: save a key to turn user monitoring on.</p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="user-monitoring-host">
                Ingest host <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
              <Input
                id="user-monitoring-host"
                value={host}
                placeholder={DEFAULT_USER_MONITORING_HOST}
                onChange={(e) => setHost(e.target.value)}
                onBlur={() => void commitHost()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void commitHost();
                }}
                className="max-w-lg"
              />
              <p className="text-xs text-muted-foreground">Leave blank to use {DEFAULT_USER_MONITORING_HOST}.</p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
