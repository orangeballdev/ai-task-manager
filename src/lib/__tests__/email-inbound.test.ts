/**
 * Unit tests for the inbound-email task-creation helpers (see
 * src/app/api/integrations/email/inbound/route.ts, which forwards SES/SNS
 * notifications here).
 *
 * Run with:
 *   npm test
 *   # or directly:
 *   npx tsx --test src/lib/__tests__/email-inbound.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  cleanSubject,
  splitForwardedEmail,
  isSenderAllowed,
  parseAllowList,
  buildTaskFieldsFromEmail,
  type ParsedInboundEmail,
} from "../email-inbound";

describe("cleanSubject", () => {
  it("strips a single Fwd:/Re: prefix", () => {
    assert.equal(cleanSubject("Fwd: Ship the release"), "Ship the release");
    assert.equal(cleanSubject("Re: Ship the release"), "Ship the release");
    assert.equal(cleanSubject("FW: Ship the release"), "Ship the release");
  });

  it("strips repeated/mixed prefixes", () => {
    assert.equal(cleanSubject("Re: Fwd: Re: Ship the release"), "Ship the release");
  });

  it("leaves a subject with no prefix untouched", () => {
    assert.equal(cleanSubject("Ship the release"), "Ship the release");
  });

  it("falls back gracefully for empty/missing subjects", () => {
    assert.equal(cleanSubject(""), "");
    assert.equal(cleanSubject(undefined), "");
    assert.equal(cleanSubject(null), "");
  });
});

describe("splitForwardedEmail", () => {
  it("splits Gmail-style forwarded content from the sender's added prompt", () => {
    const body = [
      "Please turn this into a task and fix the bug described below.",
      "",
      "---------- Forwarded message ---------",
      "From: Alice <alice@example.com>",
      "Subject: Bug in checkout flow",
      "",
      "The checkout page crashes on Safari.",
    ].join("\n");

    const result = splitForwardedEmail(body);
    assert.equal(result.hasForward, true);
    assert.equal(result.userPrompt, "Please turn this into a task and fix the bug described below.");
    assert.match(result.forwardedBody, /^---------- Forwarded message ---------/);
    assert.match(result.forwardedBody, /checkout page crashes on Safari/);
  });

  it("recognizes Outlook-style 'Original Message' markers", () => {
    const body = "Take a look at this.\n\n-----Original Message-----\nFrom: bob@example.com\n\nDetails here.";
    const result = splitForwardedEmail(body);
    assert.equal(result.hasForward, true);
    assert.equal(result.userPrompt, "Take a look at this.");
  });

  it("treats a plain (non-forwarded) email as having no forward marker", () => {
    const body = "Please research competitor pricing for our product and summarize findings.";
    const result = splitForwardedEmail(body);
    assert.equal(result.hasForward, false);
    assert.equal(result.userPrompt, body);
    assert.equal(result.forwardedBody, "");
  });
});

describe("parseAllowList", () => {
  it("splits on commas and newlines and trims whitespace", () => {
    assert.deepEqual(parseAllowList("sam@acme.dev, @acme.com\nbob@example.com"), [
      "sam@acme.dev",
      "@acme.com",
      "bob@example.com",
    ]);
  });

  it("returns an empty list for empty/missing input", () => {
    assert.deepEqual(parseAllowList(""), []);
    assert.deepEqual(parseAllowList(undefined), []);
    assert.deepEqual(parseAllowList(null), []);
  });
});

describe("isSenderAllowed", () => {
  it("matches an exact address case-insensitively", () => {
    assert.equal(isSenderAllowed("Sam@Acme.dev", ["sam@acme.dev"]), true);
    assert.equal(isSenderAllowed("mallory@evil.com", ["sam@acme.dev"]), false);
  });

  it("matches a whole-domain entry", () => {
    assert.equal(isSenderAllowed("anyone@acme.com", ["@acme.com"]), true);
    assert.equal(isSenderAllowed("anyone@other.com", ["@acme.com"]), false);
  });

  it("denies everyone when the allow-list is empty (safe default)", () => {
    assert.equal(isSenderAllowed("sam@acme.dev", []), false);
  });

  it("denies a missing/empty sender address", () => {
    assert.equal(isSenderAllowed("", ["sam@acme.dev"]), false);
    assert.equal(isSenderAllowed(undefined, ["sam@acme.dev"]), false);
  });
});

describe("buildTaskFieldsFromEmail", () => {
  function makeEmail(overrides: Partial<ParsedInboundEmail> = {}): ParsedInboundEmail {
    return {
      fromAddress: "sam@acme.dev",
      fromName: "Sam",
      subject: "Fwd: Bug in checkout flow",
      text: "Please fix this.\n\n---------- Forwarded message ---------\nFrom: Alice\n\nCheckout crashes on Safari.",
      date: new Date("2026-07-28T12:00:00Z"),
      attachmentNames: [],
      ...overrides,
    };
  }

  it("uses the cleaned subject as the title and the added prompt as the description", () => {
    const fields = buildTaskFieldsFromEmail(makeEmail());
    assert.equal(fields.title, "Bug in checkout flow");
    assert.equal(fields.description, "Please fix this.");
    assert.match(fields.context, /## Forwarded email content/);
    assert.match(fields.context, /Checkout crashes on Safari/);
    assert.match(fields.context, /From: Sam <sam@acme.dev>/);
  });

  it("falls back to a generic description when the sender added no text above the forward", () => {
    const fields = buildTaskFieldsFromEmail(makeEmail({
      text: "---------- Forwarded message ---------\nFrom: Alice\n\nCheckout crashes on Safari.",
    }));
    assert.match(fields.description, /Review the forwarded email/);
  });

  it("uses the whole body as the description when there's no forward marker at all", () => {
    const fields = buildTaskFieldsFromEmail(makeEmail({
      subject: "Research request",
      text: "Please research competitor pricing and summarize findings.",
    }));
    assert.equal(fields.title, "Research request");
    assert.equal(fields.description, "Please research competitor pricing and summarize findings.");
    // No forward block to preserve separately — the description already carries the full text.
    assert.doesNotMatch(fields.context, /## Forwarded email content/);
    assert.doesNotMatch(fields.context, /## Email content/);
  });

  it("falls back to a placeholder title when the subject is empty", () => {
    const fields = buildTaskFieldsFromEmail(makeEmail({ subject: "" }));
    assert.equal(fields.title, "Task from email");
  });

  it("notes attachment names without processing them", () => {
    const fields = buildTaskFieldsFromEmail(makeEmail({ attachmentNames: ["invoice.pdf"] }));
    assert.match(fields.context, /Attachments \(not processed\): invoice\.pdf/);
  });
});
