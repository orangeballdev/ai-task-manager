"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { KeyRound, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { confirm } from "@/components/ui/confirm-dialog";
import {
  createPasskey,
  describePasskeyError,
  usePasskeyUnsupportedReason,
} from "@/lib/auth/webauthn-client";

interface PasskeyRow {
  id: string;
  name: string;
  deviceType: string | null;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

interface Me {
  id: string;
  email: string;
  name: string | null;
  hasPassword: boolean;
  mustChangePassword: boolean;
  passwordLoginDisabled: boolean;
  passwordLoginAllowed: boolean;
  passkeys: PasskeyRow[];
}

interface SessionRow {
  id: string;
  method: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

async function api(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

function fmt(d: string | null) {
  return d ? new Date(d).toLocaleString() : "never";
}

/** Rough "Chrome on macOS" from a user-agent string, for the sessions list. */
function describeAgent(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

function defaultPasskeyName(): string {
  if (typeof navigator === "undefined") return "Passkey";
  return describeAgent(navigator.userAgent);
}

export default function AccountSettingsPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [signedOut, setSignedOut] = useState(false);
  const [name, setName] = useState("");
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [savingPw, setSavingPw] = useState(false);
  const [adding, setAdding] = useState(false);
  const passkeyBlocked = usePasskeyUnsupportedReason();

  const load = useCallback(async () => {
    try {
      // With sign-in turned off (Settings → Security) the page is reachable without a session.
      const { signedIn } = await api("/api/auth/required", "GET");
      if (!signedIn) {
        setSignedOut(true);
        return;
      }
      const [m, s] = await Promise.all([api("/api/auth/me", "GET"), api("/api/auth/sessions", "GET")]);
      setMe(m);
      setName(m.name ?? "");
      setSessions(s);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load account");
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- async loader; setState happens after an await, not synchronously in the effect body
  useEffect(() => { void load(); }, [load]);

  async function saveName() {
    if (!me || (me.name ?? "") === name.trim()) return;
    try {
      await api("/api/auth/me", "PATCH", { name });
      toast.success("Saved");
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    if (newPw !== confirmPw) {
      toast.error("New passwords don't match");
      return;
    }
    setSavingPw(true);
    try {
      const r = await api("/api/auth/password", "POST", { currentPassword: currentPw, newPassword: newPw });
      setCurrentPw("");
      setNewPw("");
      setConfirmPw("");
      toast.success(
        r.signedOutSessions ? `Password updated. Signed out ${r.signedOutSessions} other session(s).` : "Password updated",
      );
      if (me?.mustChangePassword) {
        // Reload so the "initial password" banner in the header goes away.
        window.location.reload();
        return;
      }
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update password");
    } finally {
      setSavingPw(false);
    }
  }

  async function addPasskey() {
    const label = window.prompt("Name this passkey (e.g. “MacBook Touch ID”, “YubiKey”)", defaultPasskeyName());
    if (label === null) return;
    setAdding(true);
    try {
      const options = await api("/api/auth/passkey/register/options", "POST");
      const response = await createPasskey(options);
      await api("/api/auth/passkey/register/verify", "POST", { response, name: label });
      toast.success("Passkey added");
      load();
    } catch (err) {
      toast.error(describePasskeyError(err));
    } finally {
      setAdding(false);
    }
  }

  async function renamePasskey(p: PasskeyRow) {
    const label = window.prompt("Rename passkey", p.name);
    if (!label || label.trim() === p.name) return;
    try {
      await api(`/api/auth/passkeys/${p.id}`, "PATCH", { name: label });
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to rename");
    }
  }

  async function removePasskey(p: PasskeyRow) {
    const last = me?.passkeys.length === 1;
    const ok = await confirm({
      title: "Remove passkey?",
      description:
        last && me?.passwordLoginDisabled
          ? `“${p.name}” is your only passkey. Removing it turns password sign-in back on.`
          : `“${p.name}” will no longer be able to sign in to this account.`,
      confirmLabel: "Remove",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      const r = await api(`/api/auth/passkeys/${p.id}`, "DELETE");
      toast.success(r.passwordLoginReenabled ? "Passkey removed — password sign-in re-enabled" : "Passkey removed");
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove");
    }
  }

  async function togglePasswordLogin(disabled: boolean) {
    if (disabled) {
      const ok = await confirm({
        title: "Turn off password sign-in?",
        description:
          "You'll only be able to sign in with one of your passkeys. Make sure you can use it on every device you need — consider registering a second passkey as a backup.",
        confirmLabel: "Turn off",
      });
      if (!ok) return;
    }
    try {
      await api("/api/auth/password-login", "PATCH", { disabled });
      toast.success(disabled ? "Password sign-in turned off" : "Password sign-in turned on");
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update");
    }
  }

  async function revokeSession(id?: string) {
    try {
      const r = await api(id ? `/api/auth/sessions?id=${encodeURIComponent(id)}` : "/api/auth/sessions", "DELETE");
      toast.success(id ? "Session signed out" : `Signed out ${r.count} other session(s)`);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  if (!me) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const hasPasskeys = me.passkeys.length > 0;

  if (signedOut) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Account</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Sign-in isn&apos;t required on this instance, and you&apos;re not signed in.{" "}
          <Link href="/login?next=/settings/account" className="underline underline-offset-4">Sign in</Link> to
          manage your password, passkeys and sessions.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle id="profile" className="text-base scroll-mt-24">Profile</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 max-w-md">
          <div className="flex flex-col gap-1.5">
            <Label>Email</Label>
            <p className="text-sm">{me.email}</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="displayName">Display name</Label>
            <Input id="displayName" value={name} onChange={(e) => setName(e.target.value)} onBlur={saveName} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle id="password" className="text-base scroll-mt-24">
            {me.hasPassword ? "Change password" : "Set a password"}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 max-w-md">
          {me.mustChangePassword && (
            <p className="text-sm text-amber-300">This account still has its initial password. Please change it.</p>
          )}
          <form onSubmit={changePassword} className="flex flex-col gap-3">
            {me.hasPassword && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="currentPw">Current password</Label>
                <Input
                  id="currentPw"
                  type="password"
                  autoComplete="current-password"
                  value={currentPw}
                  onChange={(e) => setCurrentPw(e.target.value)}
                  required
                />
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="newPw">New password</Label>
              <Input
                id="newPw"
                type="password"
                autoComplete="new-password"
                minLength={8}
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="confirmPw">Confirm new password</Label>
              <Input
                id="confirmPw"
                type="password"
                autoComplete="new-password"
                value={confirmPw}
                onChange={(e) => setConfirmPw(e.target.value)}
                required
              />
            </div>
            <p className="text-xs text-muted-foreground">Changing your password signs out your other sessions.</p>
            <div>
              <Button type="submit" disabled={savingPw}>
                {savingPw ? "Saving…" : me.hasPassword ? "Change password" : "Set password"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle id="passkeys" className="text-base scroll-mt-24">Passkeys</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Sign in with Touch ID, Face ID, Windows Hello, your phone or a security key instead of a password.
            Passkeys are tied to the address you register them on, so add them while using the URL you&apos;ll sign in from.
          </p>
          {me.passkeys.length > 0 ? (
            <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
              {me.passkeys.map((p) => (
                <li key={p.id} className="flex items-center gap-3 px-3 py-2">
                  <KeyRound size={16} className="text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{p.name}</span>
                      {p.backedUp && <Badge variant="secondary">Synced</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Added {fmt(p.createdAt)} · Last used {fmt(p.lastUsedAt)}
                    </p>
                  </div>
                  <Button variant="ghost" size="icon-sm" aria-label="Rename" onClick={() => renamePasskey(p)}>
                    <Pencil size={14} />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label="Remove" onClick={() => removePasskey(p)}>
                    <Trash2 size={14} />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No passkeys yet.</p>
          )}
          <div className="flex items-center gap-3">
            <Button onClick={addPasskey} disabled={adding || !!passkeyBlocked}>
              <KeyRound size={16} />
              {adding ? "Waiting for passkey…" : "Add a passkey"}
            </Button>
            {passkeyBlocked && <span className="text-xs text-muted-foreground">{passkeyBlocked}</span>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle id="password-login" className="text-base scroll-mt-24">Password sign-in</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-start gap-3">
            <Switch
              id="passwordLoginToggle"
              checked={!me.passwordLoginDisabled}
              disabled={!hasPasskeys && !me.passwordLoginDisabled}
              onCheckedChange={(on) => togglePasswordLogin(!on)}
            />
            <div className="flex flex-col gap-1">
              <Label htmlFor="passwordLoginToggle">Allow signing in with email and password</Label>
              <p className="text-sm text-muted-foreground">
                {hasPasskeys
                  ? "Turn this off to require a passkey. Removing your last passkey turns it back on, so you can't lock yourself out."
                  : "Add a passkey first — then you can turn password sign-in off and sign in with the passkey only."}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle id="sessions" className="text-base scroll-mt-24">Active sessions</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
            {sessions.map((s) => (
              <li key={s.id} className="flex items-center gap-3 px-3 py-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{describeAgent(s.userAgent)}</span>
                    {s.current && <Badge>This device</Badge>}
                    <Badge variant="outline">{s.method}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {s.ip ?? "unknown IP"} · Signed in {fmt(s.createdAt)} · Last active {fmt(s.lastSeenAt)}
                  </p>
                </div>
                {!s.current && (
                  <Button variant="ghost" size="sm" onClick={() => revokeSession(s.id)}>
                    Sign out
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {sessions.some((s) => !s.current) && (
            <div>
              <Button variant="outline" size="sm" onClick={() => revokeSession()}>
                Sign out all other sessions
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
