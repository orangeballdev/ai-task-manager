"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DEFAULT_SES_REGION,
  DEFAULT_SMTP_PORT,
  EMAIL_SETTING_KEYS as K,
  isValidSesRegion,
  validateEmailAddress,
  validateSmtpPort,
  type SesCredentialSource,
  type SmtpSecurity,
} from "@/lib/email-transport";

const MASK = "***";

type Method = "" | "smtp" | "ses";

interface EmailStatus {
  envAwsCredentials: boolean;
  envAwsRegion: string | null;
  active: "smtp" | "ses" | "none";
  problem: string | null;
  usingLegacySes: boolean;
}

type Fields = Record<(typeof K)[keyof typeof K], string>;

const EMPTY: Fields = {
  [K.transport]: "",
  [K.from]: "",
  [K.smtpHost]: "",
  [K.smtpPort]: "",
  [K.smtpSecurity]: "starttls",
  [K.smtpUsername]: "",
  [K.smtpPassword]: "",
  [K.sesCredentialSource]: "env",
  [K.sesRegion]: "",
  [K.sesAccessKeyId]: "",
  [K.sesSecretAccessKey]: "",
};

const SECURITY_LABELS: Record<SmtpSecurity, string> = {
  starttls: "STARTTLS",
  tls: "TLS/SSL",
  none: "None",
};

async function saveSetting(key: string, value: string) {
  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
  if (!res.ok) throw new Error("Failed to save");
}

function Segmented<T extends string>({ value, options, onChange, disabled }: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="inline-flex rounded-md border border-border p-0.5 gap-0.5">
      {options.map((o) => (
        <Button
          key={o.value}
          type="button"
          size="sm"
          variant={value === o.value ? "secondary" : "ghost"}
          disabled={disabled}
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}

/**
 * Settings → Notifications: how emails are delivered (SMTP or Amazon SES), and
 * the sender address. Nothing is sent until a method is configured — see
 * `resolveEmailTransport()` in src/lib/email-transport.ts.
 */
export function EmailDeliveryCard() {
  const [loading, setLoading] = useState(true);
  const [fields, setFields] = useState<Fields>(EMPTY);
  const saved = useRef<Fields>(EMPTY);
  // Secrets are never sent back to the browser; these say whether one is stored.
  const [hasSmtpPassword, setHasSmtpPassword] = useState(false);
  const [hasSesSecret, setHasSesSecret] = useState(false);
  const [status, setStatus] = useState<EmailStatus | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications/email-status", { cache: "no-store" });
      if (res.ok) setStatus(await res.json());
    } catch {
      /* keep the last status */
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/settings").then((r) => r.json() as Promise<Record<string, string>>),
      fetch("/api/notifications/email-status", { cache: "no-store" }).then((r) => (r.ok ? (r.json() as Promise<EmailStatus>) : null)),
    ])
      .then(([data, st]) => {
        if (cancelled) return;
        const loaded = { ...EMPTY };
        for (const key of Object.keys(EMPTY) as (keyof Fields)[]) {
          if (data[key] !== undefined) loaded[key] = data[key];
        }
        setHasSmtpPassword(loaded[K.smtpPassword] === MASK);
        setHasSesSecret(loaded[K.sesSecretAccessKey] === MASK);
        loaded[K.smtpPassword] = "";
        loaded[K.sesSecretAccessKey] = "";
        // An install that sends through SES from the environment without ever choosing
        // a method shows as SES, so switching away is an explicit choice.
        if (data[K.transport] === undefined && st?.usingLegacySes) loaded[K.transport] = "ses";
        setFields(loaded);
        saved.current = { ...loaded };
        setStatus(st);
      })
      .catch(() => toast.error("Failed to load email settings"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const set = (key: keyof Fields, value: string) => setFields((prev) => ({ ...prev, [key]: value }));

  async function commit(key: keyof Fields, value: string, opts: { quiet?: boolean } = {}) {
    if (saved.current[key] === value) return true;
    try {
      await saveSetting(key, value);
      saved.current = { ...saved.current, [key]: value };
      if (!opts.quiet) toast.success("Saved");
      void refreshStatus();
      return true;
    } catch {
      toast.error("Failed to save");
      return false;
    }
  }

  function commitValidated(key: keyof Fields, problem: string | null) {
    if (problem) {
      toast.error(problem);
      return;
    }
    void commit(key, fields[key].trim());
  }

  async function commitSecret(key: typeof K.smtpPassword | typeof K.sesSecretAccessKey) {
    const value = fields[key];
    if (!value) return; // empty = keep what's stored
    try {
      await saveSetting(key, value);
      if (key === K.smtpPassword) setHasSmtpPassword(true);
      else setHasSesSecret(true);
      set(key, "");
      toast.success("Saved");
      void refreshStatus();
    } catch {
      toast.error("Failed to save");
    }
  }

  function chooseMethod(method: Method) {
    set(K.transport, method);
    void commit(K.transport, method, { quiet: true }).then((ok) => {
      if (ok) toast.success(method ? `Email will be sent with ${method === "smtp" ? "SMTP" : "Amazon SES"}` : "Email delivery turned off");
    });
  }

  function chooseSecurity(security: SmtpSecurity) {
    set(K.smtpSecurity, security);
    void commit(K.smtpSecurity, security);
  }

  function chooseSesSource(source: SesCredentialSource) {
    set(K.sesCredentialSource, source);
    void commit(K.sesCredentialSource, source);
  }

  if (loading) return <div className="h-40 bg-muted rounded animate-pulse" />;

  const method = fields[K.transport] as Method;
  const security = (fields[K.smtpSecurity] || "starttls") as SmtpSecurity;
  const sesSource = (fields[K.sesCredentialSource] === "settings" ? "settings" : "env") as SesCredentialSource;
  const ready = status && status.active !== "none";

  return (
    <Card>
      <CardHeader>
        <CardTitle id="email-delivery" className="text-base scroll-mt-24">Email Delivery</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <p className="text-sm text-muted-foreground">
          How this server sends email: task notifications, provider alerts and replies to tasks created by email.
          Nothing is sent until you choose a method.
        </p>

        <div className="flex flex-col gap-2">
          <Label>Send email with</Label>
          <Segmented<Method>
            value={method}
            onChange={chooseMethod}
            options={[
              { value: "", label: "Off" },
              { value: "smtp", label: "SMTP" },
              { value: "ses", label: "Amazon SES" },
            ]}
          />
        </div>

        {method && (
          <div className="flex flex-col gap-1.5 max-w-sm">
            <Label htmlFor="email-from">Sender address</Label>
            <Input
              id="email-from"
              type="email"
              value={fields[K.from]}
              placeholder="no-reply@yourdomain.com"
              onChange={(e) => set(K.from, e.target.value)}
              onBlur={() => commitValidated(K.from, validateEmailAddress(fields[K.from]))}
            />
            <p className="text-xs text-muted-foreground">
              {method === "ses"
                ? "Must be an address or domain verified in Amazon SES."
                : "Your mail server must allow sending from this address."}
            </p>
          </div>
        )}

        {method === "smtp" && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-3">
              <div className="flex flex-col gap-1.5 w-full max-w-xs">
                <Label htmlFor="smtp-host">SMTP host</Label>
                <Input
                  id="smtp-host"
                  value={fields[K.smtpHost]}
                  placeholder="smtp.example.com"
                  autoComplete="off"
                  onChange={(e) => set(K.smtpHost, e.target.value)}
                  onBlur={() => commitValidated(K.smtpHost, null)}
                />
              </div>
              <div className="flex flex-col gap-1.5 w-28">
                <Label htmlFor="smtp-port">Port</Label>
                <Input
                  id="smtp-port"
                  inputMode="numeric"
                  value={fields[K.smtpPort]}
                  placeholder={String(DEFAULT_SMTP_PORT[security])}
                  onChange={(e) => set(K.smtpPort, e.target.value)}
                  onBlur={() => commitValidated(K.smtpPort, validateSmtpPort(fields[K.smtpPort]))}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Security</Label>
              <Segmented<SmtpSecurity>
                value={security}
                onChange={chooseSecurity}
                options={(["starttls", "tls", "none"] as SmtpSecurity[]).map((v) => ({ value: v, label: SECURITY_LABELS[v] }))}
              />
              <p className="text-xs text-muted-foreground">
                STARTTLS is usual on port 587, TLS/SSL on 465. Leave the port blank to use the usual one.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <div className="flex flex-col gap-1.5 w-full max-w-xs">
                <Label htmlFor="smtp-user">Username</Label>
                <Input
                  id="smtp-user"
                  value={fields[K.smtpUsername]}
                  autoComplete="off"
                  onChange={(e) => set(K.smtpUsername, e.target.value)}
                  onBlur={() => commitValidated(K.smtpUsername, null)}
                />
              </div>
              <div className="flex flex-col gap-1.5 w-full max-w-xs">
                <Label htmlFor="smtp-pass">Password</Label>
                <Input
                  id="smtp-pass"
                  type="password"
                  value={fields[K.smtpPassword]}
                  placeholder={hasSmtpPassword ? "Saved (type to replace)" : ""}
                  autoComplete="new-password"
                  onChange={(e) => set(K.smtpPassword, e.target.value)}
                  onBlur={() => void commitSecret(K.smtpPassword)}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Leave the username blank if your server doesn&apos;t need a login. For Gmail or Fastmail, use an app password.
            </p>
          </div>
        )}

        {method === "ses" && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label>AWS credentials</Label>
              <Segmented<SesCredentialSource>
                value={sesSource}
                onChange={chooseSesSource}
                options={[
                  { value: "env", label: "From the server environment" },
                  { value: "settings", label: "Enter them here" },
                ]}
              />
              {sesSource === "env" && (
                <p className="text-xs text-muted-foreground">
                  {status?.envAwsCredentials
                    ? "Found AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in this server's environment."
                    : "No AWS keys in this server's environment, so the AWS SDK's default chain (e.g. an instance role) is used. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or enter credentials here instead."}
                </p>
              )}
            </div>

            {sesSource === "settings" && (
              <div className="flex flex-wrap gap-3">
                <div className="flex flex-col gap-1.5 w-full max-w-xs">
                  <Label htmlFor="ses-key-id">Access key ID</Label>
                  <Input
                    id="ses-key-id"
                    value={fields[K.sesAccessKeyId]}
                    placeholder="AKIA…"
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                    onChange={(e) => set(K.sesAccessKeyId, e.target.value)}
                    onBlur={() => commitValidated(K.sesAccessKeyId, null)}
                  />
                </div>
                <div className="flex flex-col gap-1.5 w-full max-w-xs">
                  <Label htmlFor="ses-secret">Secret access key</Label>
                  <Input
                    id="ses-secret"
                    type="password"
                    value={fields[K.sesSecretAccessKey]}
                    placeholder={hasSesSecret ? "Saved (type to replace)" : ""}
                    autoComplete="new-password"
                    onChange={(e) => set(K.sesSecretAccessKey, e.target.value)}
                    onBlur={() => void commitSecret(K.sesSecretAccessKey)}
                  />
                </div>
              </div>
            )}

            <div className="flex flex-col gap-1.5 w-40">
              <Label htmlFor="ses-region">Region</Label>
              <Input
                id="ses-region"
                value={fields[K.sesRegion]}
                placeholder={(sesSource === "env" && status?.envAwsRegion) || DEFAULT_SES_REGION}
                onChange={(e) => set(K.sesRegion, e.target.value)}
                onBlur={() => {
                  const v = fields[K.sesRegion].trim();
                  commitValidated(K.sesRegion, v && !isValidSesRegion(v) ? "Enter an AWS region such as us-east-1" : null);
                }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              The credentials need the <code>ses:SendEmail</code> permission. New SES accounts are in the sandbox and can
              only send to verified addresses.
            </p>
          </div>
        )}

        {status && (
          <p className={`text-xs ${ready ? "text-green-400" : "text-amber-300"}`}>
            {ready
              ? `Ready: emails are sent with ${status.active === "smtp" ? "SMTP" : "Amazon SES"}. Use "Send test" below to check.`
              : status.problem}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
