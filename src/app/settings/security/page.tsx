"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { confirm } from "@/components/ui/confirm-dialog";

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  passwordLoginDisabled: boolean;
  createdAt: string;
  passkeyCount: number;
  sessionCount: number;
  current: boolean;
}

interface EventRow {
  id: string;
  email: string | null;
  method: string;
  success: boolean;
  reason: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

const METHOD_LABELS: Record<string, string> = {
  password: "Password",
  passkey: "Passkey",
  signup: "Sign-up",
  logout: "Sign-out",
  password_change: "Password change",
};

const REASON_LABELS: Record<string, string> = {
  unknown_email: "Unknown email",
  bad_password: "Wrong password",
  no_password: "Account has no password",
  password_login_disabled: "Password sign-in disabled",
  rate_limited: "Rate limited",
  signups_disabled: "Sign-ups disabled",
  email_taken: "Email already registered",
  unknown_passkey: "Unknown passkey",
  challenge_expired: "Challenge expired",
  not_verified: "Passkey not verified",
};

async function api(url: string, method = "GET", body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

const PAGE = 100;

export default function SecuritySettingsPage() {
  const [auth, setAuth] = useState<{ required: boolean; signedIn: boolean } | null>(null);
  const [savingAuth, setSavingAuth] = useState(false);
  const [signups, setSignups] = useState<boolean | null>(null);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [failedOnly, setFailedOnly] = useState(false);

  const loadEvents = useCallback(async (before?: string) => {
    const qs = new URLSearchParams({ limit: String(PAGE) });
    if (before) qs.set("before", before);
    if (failedOnly) qs.set("failedOnly", "1");
    const data = await api(`/api/auth/events?${qs}`);
    setEvents((prev) => (before ? [...prev, ...data.events] : data.events));
    setHasMore(data.hasMore);
  }, [failedOnly]);

  useEffect(() => {
    api("/api/auth/required")
      .then(setAuth)
      .catch((err) => toast.error(err instanceof Error ? err.message : "Failed to load"));
  }, []);

  const signedIn = !!auth?.signedIn;

  const load = useCallback(async () => {
    if (!signedIn) return;
    try {
      const [s, u] = await Promise.all([api("/api/auth/signups"), api("/api/auth/users")]);
      setSignups(s.enabled);
      setUsers(u);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load");
    }
  }, [signedIn]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- async loader; setState happens after an await, not synchronously in the effect body
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!signedIn) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async loader; setState happens after an await
    loadEvents().catch((err) => toast.error(err instanceof Error ? err.message : "Failed to load sign-in log"));
  }, [loadEvents, signedIn]);

  async function toggleAuthRequired(required: boolean) {
    if (!required) {
      const ok = await confirm({
        title: "Turn off required sign-in?",
        description:
          "Anyone who can reach this instance will be able to use it — see and change tasks, settings and stored credentials — without signing in.",
        confirmLabel: "Turn off",
        variant: "destructive",
      });
      if (!ok) return;
    }
    setSavingAuth(true);
    try {
      const r = await api("/api/auth/required", "PUT", { required });
      setAuth((prev) => (prev ? { ...prev, required: r.required } : prev));
      toast.success(required ? "Sign-in is now required" : "Sign-in is no longer required");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSavingAuth(false);
    }
  }

  async function toggleSignups(enabled: boolean) {
    try {
      const r = await api("/api/auth/signups", "PUT", { enabled });
      setSignups(r.enabled);
      toast.success(enabled ? "Sign-ups enabled" : "Sign-ups disabled");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    }
  }

  async function deleteUser(u: UserRow) {
    const ok = await confirm({
      title: "Delete account?",
      description: `${u.email} will be signed out everywhere and can no longer sign in. Tasks and settings are shared and are not affected.`,
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      await api(`/api/auth/users/${u.id}`, "DELETE");
      toast.success("Account deleted");
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle id="require-sign-in" className="text-base scroll-mt-24">Require sign-in</CardTitle>
        </CardHeader>
        <CardContent className="flex items-start gap-3">
          <Switch
            id="authRequiredToggle"
            checked={!!auth?.required}
            disabled={auth === null || savingAuth || (!auth.required && !auth.signedIn)}
            onCheckedChange={toggleAuthRequired}
          />
          <div className="flex flex-col gap-1">
            <Label htmlFor="authRequiredToggle">Require signing in to use the web UI</Label>
            <p className="text-sm text-muted-foreground">
              When off, anyone who can reach this instance can use it without an account. Turn it on for any
              install reachable by people you don&apos;t trust. API keys, MCP tokens and webhook secrets are
              checked either way.
            </p>
            {auth && !auth.required && !auth.signedIn && (
              <p className="text-sm text-amber-300">
                <Link href="/login?next=/settings/security" className="underline underline-offset-4">Sign in</Link>{" "}
                first to turn this on, so you know your account works and can&apos;t lock yourself out.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {auth && !signedIn && (
        <p className="text-sm text-muted-foreground">
          <Link href="/login?next=/settings/security" className="underline underline-offset-4">Sign in</Link> to
          manage sign-ups and accounts, and to see the sign-in log.
        </p>
      )}

      {signedIn && (<>
      <Card>
        <CardHeader>
          <CardTitle id="signups" className="text-base scroll-mt-24">Sign-ups</CardTitle>
        </CardHeader>
        <CardContent className="flex items-start gap-3">
          <Switch
            id="signupsToggle"
            checked={!!signups}
            disabled={signups === null}
            onCheckedChange={toggleSignups}
          />
          <div className="flex flex-col gap-1">
            <Label htmlFor="signupsToggle">Allow new accounts to be created at /signup</Label>
            <p className="text-sm text-muted-foreground">
              Every account can see and change everything on this instance, so leave this off unless you&apos;re
              adding someone — then turn it off again once they&apos;ve signed up.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle id="accounts" className="text-base scroll-mt-24">Accounts</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
            {users.map((u) => (
              <li key={u.id} className="flex items-center gap-3 px-3 py-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium truncate">{u.email}</span>
                    {u.current && <Badge>You</Badge>}
                    {u.passwordLoginDisabled && u.passkeyCount > 0 && <Badge variant="secondary">Passkey only</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {u.passkeyCount} passkey{u.passkeyCount === 1 ? "" : "s"} · {u.sessionCount} session
                    {u.sessionCount === 1 ? "" : "s"} · Created {new Date(u.createdAt).toLocaleDateString()}
                  </p>
                </div>
                {!u.current && (
                  <Button variant="ghost" size="icon-sm" aria-label={`Delete ${u.email}`} onClick={() => deleteUser(u)}>
                    <Trash2 size={14} />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle id="sign-in-log" className="text-base scroll-mt-24">Sign-in log</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Switch id="failedOnly" checked={failedOnly} onCheckedChange={setFailedOnly} />
            <Label htmlFor="failedOnly">Failures only</Label>
          </div>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground border-b border-border">
                <tr>
                  <th className="text-left font-medium px-3 py-2">Time</th>
                  <th className="text-left font-medium px-3 py-2">Event</th>
                  <th className="text-left font-medium px-3 py-2">Result</th>
                  <th className="text-left font-medium px-3 py-2">Email</th>
                  <th className="text-left font-medium px-3 py-2">IP</th>
                  <th className="text-left font-medium px-3 py-2">User agent</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {events.map((e) => (
                  <tr key={e.id}>
                    <td className="px-3 py-1.5 whitespace-nowrap">{new Date(e.createdAt).toLocaleString()}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap">{METHOD_LABELS[e.method] ?? e.method}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      {e.success ? (
                        <span className="text-green-400">Success</span>
                      ) : (
                        <span className="text-destructive" title={e.reason ?? undefined}>
                          {(e.reason && REASON_LABELS[e.reason]) ?? (e.reason?.split(":")[0] || "Failed")}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap">{e.email ?? "—"}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap font-mono text-xs">{e.ip ?? "—"}</td>
                    <td className="px-3 py-1.5 max-w-xs truncate text-xs text-muted-foreground" title={e.userAgent ?? undefined}>
                      {e.userAgent ?? "—"}
                    </td>
                  </tr>
                ))}
                {events.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-4 text-center text-muted-foreground">
                      No sign-in events yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {hasMore && (
            <div>
              <Button variant="outline" size="sm" onClick={() => loadEvents(events[events.length - 1]?.createdAt)}>
                Load older
              </Button>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Every sign-in attempt (successful or not), sign-up, sign-out and password change is recorded here
            and in the app&apos;s console log as <code>[auth] …</code>.
          </p>
        </CardContent>
      </Card>
      </>)}
    </div>
  );
}
