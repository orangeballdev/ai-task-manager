import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMAIL_SETTING_KEYS as K,
  MISSING_SENDER_REASON,
  NOT_CONFIGURED_REASON,
  resolveEmailTransport,
  validateEmailAddress,
  validateSmtpPort,
} from "../email-transport";

const FROM = { [K.from]: "bot@example.com" };
const AWS_ENV = { AWS_ACCESS_KEY_ID: "AKIAEXAMPLE", AWS_SECRET_ACCESS_KEY: "secret", AWS_REGION: "eu-west-2" };

test("nothing configured and no AWS env: email is off", () => {
  assert.deepEqual(resolveEmailTransport({}, {}), { kind: "none", reason: NOT_CONFIGURED_REASON });
  assert.deepEqual(resolveEmailTransport(FROM, {}), { kind: "none", reason: NOT_CONFIGURED_REASON });
});

test("never chosen + AWS env credentials: keeps using SES from the environment (older installs)", () => {
  const t = resolveEmailTransport(FROM, AWS_ENV);
  assert.deepEqual(t, {
    kind: "ses",
    from: "bot@example.com",
    region: "eu-west-2",
    credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" },
    source: "env",
  });
});

test("explicitly cleared method stays off even with AWS env credentials", () => {
  assert.equal(resolveEmailTransport({ ...FROM, [K.transport]: "" }, AWS_ENV).kind, "none");
});

test("a method without a sender address is off", () => {
  assert.deepEqual(resolveEmailTransport({ [K.transport]: "smtp", [K.smtpHost]: "smtp.example.com" }, {}), {
    kind: "none",
    reason: MISSING_SENDER_REASON,
  });
});

test("SMTP with STARTTLS defaults to port 587 and auth when a username is set", () => {
  const t = resolveEmailTransport(
    { ...FROM, [K.transport]: "smtp", [K.smtpHost]: " smtp.example.com ", [K.smtpUsername]: "me", [K.smtpPassword]: "pw" },
    AWS_ENV,
  );
  assert.deepEqual(t, {
    kind: "smtp",
    from: "bot@example.com",
    host: "smtp.example.com",
    port: 587,
    security: "starttls",
    auth: { user: "me", pass: "pw" },
  });
});

test("SMTP implicit TLS defaults to 465; explicit port wins; no username = no auth", () => {
  const base = { ...FROM, [K.transport]: "smtp", [K.smtpHost]: "mail.example.com", [K.smtpSecurity]: "tls" };
  const t1 = resolveEmailTransport(base, {});
  assert.equal(t1.kind === "smtp" && t1.port, 465);
  assert.equal(t1.kind === "smtp" && t1.auth, undefined);
  const t2 = resolveEmailTransport({ ...base, [K.smtpPort]: "2465" }, {});
  assert.equal(t2.kind === "smtp" && t2.port, 2465);
  const t3 = resolveEmailTransport({ ...base, [K.smtpPort]: "abc" }, {});
  assert.equal(t3.kind === "smtp" && t3.port, 465);
});

test("SMTP without a host is off with a reason naming it", () => {
  const t = resolveEmailTransport({ ...FROM, [K.transport]: "smtp" }, {});
  assert.equal(t.kind, "none");
  assert.match(t.kind === "none" ? t.reason : "", /SMTP host/);
});

test("SES with credentials entered in settings ignores the environment", () => {
  const t = resolveEmailTransport(
    {
      ...FROM,
      [K.transport]: "ses",
      [K.sesCredentialSource]: "settings",
      [K.sesAccessKeyId]: "AKIAUI",
      [K.sesSecretAccessKey]: "uisecret",
      [K.sesRegion]: "ap-southeast-2",
    },
    AWS_ENV,
  );
  assert.deepEqual(t, {
    kind: "ses",
    from: "bot@example.com",
    region: "ap-southeast-2",
    credentials: { accessKeyId: "AKIAUI", secretAccessKey: "uisecret" },
    source: "settings",
  });
});

test("SES from settings without a key is off", () => {
  const t = resolveEmailTransport({ ...FROM, [K.transport]: "ses", [K.sesCredentialSource]: "settings" }, AWS_ENV);
  assert.equal(t.kind, "none");
});

test("SES from env without keys falls back to the SDK default chain; bad region → us-east-1", () => {
  const t = resolveEmailTransport({ ...FROM, [K.transport]: "ses", [K.sesRegion]: "not-a-region" }, {});
  assert.deepEqual(t, { kind: "ses", from: "bot@example.com", region: "us-east-1", source: "env" });
});

test("form validation helpers", () => {
  assert.equal(validateSmtpPort(""), null);
  assert.equal(validateSmtpPort("587"), null);
  assert.match(validateSmtpPort("70000")!, /between/);
  assert.equal(validateEmailAddress("bot@example.com"), null);
  assert.match(validateEmailAddress("bot@localhost")!, /valid/);
});
