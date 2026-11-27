// How notification emails are delivered: SMTP or Amazon SES, chosen in
// Settings → Notifications → Email delivery. Pure — the runtime (nodemailer /
// the SES client) lives in notifications.ts and is handed the resolved config.
//
// Nothing is sent until a method is configured. The one exception keeps older
// installs working: if no method was ever chosen and the environment already has
// AWS credentials (how SES used to be set up), SES with those credentials is used.

import { NOTIFICATION_FROM_SETTING } from "./app-host";

export const EMAIL_SETTING_KEYS = {
  transport: "email_transport",
  from: NOTIFICATION_FROM_SETTING,
  smtpHost: "smtp_host",
  smtpPort: "smtp_port",
  smtpSecurity: "smtp_security",
  smtpUsername: "smtp_username",
  smtpPassword: "smtp_password",
  sesCredentialSource: "ses_credential_source",
  sesRegion: "ses_region",
  sesAccessKeyId: "ses_access_key_id",
  sesSecretAccessKey: "ses_secret_access_key",
} as const;

/** Setting rows that hold credentials: masked by GET /api/settings, never sent back to the browser. */
export const EMAIL_SECRET_KEYS: readonly string[] = [EMAIL_SETTING_KEYS.smtpPassword, EMAIL_SETTING_KEYS.sesSecretAccessKey];

export type EmailTransportKind = "smtp" | "ses";
/** `tls` = implicit TLS (usually port 465), `starttls` = upgrade after connecting (usually 587), `none` = plain. */
export type SmtpSecurity = "starttls" | "tls" | "none";
/** Where SES credentials come from: the process environment, or the Setting rows. */
export type SesCredentialSource = "env" | "settings";

export const DEFAULT_SMTP_PORT: Record<SmtpSecurity, number> = { starttls: 587, tls: 465, none: 25 };
export const DEFAULT_SES_REGION = "us-east-1";

export type EmailTransportConfig =
  | {
      kind: "smtp";
      from: string;
      host: string;
      port: number;
      security: SmtpSecurity;
      /** Omitted for servers that don't need authentication. */
      auth?: { user: string; pass: string };
    }
  | {
      kind: "ses";
      from: string;
      region: string;
      /** Omitted to let the AWS SDK use its default chain (instance role, shared config). */
      credentials?: { accessKeyId: string; secretAccessKey: string };
      source: SesCredentialSource;
    }
  | { kind: "none"; reason: string };

export const NOT_CONFIGURED_REASON =
  "Email isn't set up. Choose SMTP or Amazon SES under Settings → Notifications → Email delivery.";
export const MISSING_SENDER_REASON = "No sender address set. Add one under Settings → Notifications → Email delivery.";

type Env = Record<string, string | undefined>;
type SettingsMap = Record<string, string | undefined>;

const trim = (v: string | undefined) => (v ?? "").trim();

export function isValidSesRegion(region: string): boolean {
  return /^[a-z][a-z0-9-]*\d$/.test(region);
}

/** Whether the environment carries AWS keys SES can use. */
export function envHasAwsCredentials(env: Env): boolean {
  return !!trim(env.AWS_ACCESS_KEY_ID) && !!trim(env.AWS_SECRET_ACCESS_KEY);
}

function parseSecurity(raw: string): SmtpSecurity {
  return raw === "tls" || raw === "none" ? raw : "starttls";
}

/** The chosen delivery method, or null when none was ever chosen (as opposed to `""`, cleared on purpose). */
export function chosenTransport(settings: SettingsMap): EmailTransportKind | "" | null {
  const raw = settings[EMAIL_SETTING_KEYS.transport];
  if (raw === undefined) return null;
  return raw === "smtp" || raw === "ses" ? raw : "";
}

/** Resolve the Setting rows (and, for SES, the environment) into something the sender can use. */
export function resolveEmailTransport(settings: SettingsMap, env: Env): EmailTransportConfig {
  const K = EMAIL_SETTING_KEYS;
  const from = trim(settings[K.from]);
  let kind = chosenTransport(settings);

  // Installs from before this setting existed sent through SES with env credentials.
  if (kind === null) kind = envHasAwsCredentials(env) ? "ses" : "";
  if (!kind) return { kind: "none", reason: NOT_CONFIGURED_REASON };
  if (!from) return { kind: "none", reason: MISSING_SENDER_REASON };

  if (kind === "smtp") {
    const host = trim(settings[K.smtpHost]);
    if (!host) return { kind: "none", reason: "SMTP host is missing. Add it under Settings → Notifications → Email delivery." };
    const security = parseSecurity(trim(settings[K.smtpSecurity]));
    const port = Number.parseInt(trim(settings[K.smtpPort]), 10);
    const user = trim(settings[K.smtpUsername]);
    const pass = settings[K.smtpPassword] ?? "";
    return {
      kind: "smtp",
      from,
      host,
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_SMTP_PORT[security],
      security,
      ...(user ? { auth: { user, pass } } : {}),
    };
  }

  // SES
  const source: SesCredentialSource =
    settings[K.sesCredentialSource] === "settings" ? "settings" : "env";
  if (source === "settings") {
    const accessKeyId = trim(settings[K.sesAccessKeyId]);
    const secretAccessKey = trim(settings[K.sesSecretAccessKey]);
    if (!accessKeyId || !secretAccessKey) {
      return { kind: "none", reason: "Amazon SES access key is missing. Add it under Settings → Notifications → Email delivery." };
    }
    const region = trim(settings[K.sesRegion]) || DEFAULT_SES_REGION;
    return { kind: "ses", from, region: isValidSesRegion(region) ? region : DEFAULT_SES_REGION, credentials: { accessKeyId, secretAccessKey }, source };
  }
  const region = trim(settings[K.sesRegion]) || trim(env.AWS_REGION) || DEFAULT_SES_REGION;
  return {
    kind: "ses",
    from,
    region: isValidSesRegion(region) ? region : DEFAULT_SES_REGION,
    ...(envHasAwsCredentials(env)
      ? { credentials: { accessKeyId: trim(env.AWS_ACCESS_KEY_ID), secretAccessKey: trim(env.AWS_SECRET_ACCESS_KEY) } }
      : {}),
    source,
  };
}

/** A problem with an SMTP host/port pair as typed in the form, or null. */
export function validateSmtpPort(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 65536 ? null : "Port must be a number between 1 and 65535";
}

export function validateEmailAddress(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v) ? null : "Enter a valid email address";
}
