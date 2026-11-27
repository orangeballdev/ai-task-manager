"use client";
import { useState } from "react";
import Link from "next/link";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthCard } from "./AuthCard";
import { describePasskeyError, getPasskey, usePasskeyUnsupportedReason } from "@/lib/auth/webauthn-client";

async function postJson(url: string, body?: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export function LoginForm({ next, signupsEnabled }: { next: string; signupsEnabled: boolean }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"password" | "passkey" | null>(null);
  const passkeyBlocked = usePasskeyUnsupportedReason();

  // A full page load (not router.push) so the root layout re-renders with the session.
  const done = () => window.location.assign(next);

  async function signInWithPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy("password");
    try {
      const { ok, data } = await postJson("/api/auth/login", { email, password });
      if (ok) return done();
      setError(data.error ?? "Sign-in failed.");
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setBusy(null);
    }
  }

  async function signInWithPasskey() {
    setError(null);
    setBusy("passkey");
    try {
      const opts = await postJson("/api/auth/passkey/login/options");
      if (!opts.ok) throw new Error(opts.data.error ?? "Couldn't start passkey sign-in.");
      const response = await getPasskey(opts.data);
      const { ok, data } = await postJson("/api/auth/passkey/login/verify", { response });
      if (ok) return done();
      setError(data.error ?? "Passkey sign-in failed.");
    } catch (err) {
      setError(describePasskeyError(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <AuthCard title="Sign in">
      <Button
        type="button"
        variant="outline"
        onClick={signInWithPasskey}
        disabled={busy !== null || !!passkeyBlocked}
        className="w-full"
      >
        <KeyRound size={16} />
        {busy === "passkey" ? "Waiting for passkey…" : "Sign in with a passkey"}
      </Button>
      {passkeyBlocked && <p className="text-xs text-muted-foreground -mt-2">{passkeyBlocked}</p>}

      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <div className="h-px flex-1 bg-border" />
        or
        <div className="h-px flex-1 bg-border" />
      </div>

      <form onSubmit={signInWithPassword} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="username webauthn"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy !== null} className="w-full">
          {busy === "password" ? "Signing in…" : "Sign in"}
        </Button>
      </form>

      {signupsEnabled && (
        <p className="text-sm text-muted-foreground text-center">
          No account?{" "}
          <Link href="/signup" className="underline underline-offset-4 text-foreground">
            Create one
          </Link>
        </p>
      )}
    </AuthCard>
  );
}
