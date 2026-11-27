import { simpleParser, type ParsedMail } from "mailparser";

// --- Subject cleanup -------------------------------------------------------

// Matches one leading "Fwd:", "Fw:", "Re:" (any casing, with or without a
// trailing colon-space) so repeated prefixes like "Re: Fwd: Re: Ship it" get
// fully stripped down to "Ship it".
const SUBJECT_PREFIX_RE = /^\s*(fwd?|re)\s*:\s*/i;

export function cleanSubject(subject: string | undefined | null): string {
  let s = (subject ?? "").trim();
  // Cap iterations so a pathological subject can't loop forever.
  for (let i = 0; i < 10; i++) {
    const next = s.replace(SUBJECT_PREFIX_RE, "");
    if (next === s) break;
    s = next.trim();
  }
  return s;
}

// --- Forwarded-message splitting --------------------------------------------

// Common markers mail clients insert at the start of a forwarded/quoted block.
// The first match wins — everything before it is the sender's own added
// message, everything from the marker onward is the original forwarded email.
const FORWARD_MARKERS: RegExp[] = [
  /-{3,}\s*Forwarded message\s*-{3,}/i, // Gmail
  /Begin forwarded message:/i, // Apple Mail
  /-{3,}\s*Original Message\s*-{3,}/i, // Outlook
  /On .{5,120} wrote:\s*$/im, // generic reply quoting ("On Mon, ... at ..., X wrote:")
  /^From:\s?.+\n(?:Sent|Date):\s?.+\n(?:To|Cc):\s?.+\n(?:Subject|Cc|Bcc):\s?.+$/im, // Outlook-style header block
];

export interface SplitEmailBody {
  /** Text the sender typed above the forwarded/quoted content, if any. */
  userPrompt: string;
  /** The forwarded/quoted content, including the marker line, if any was found. */
  forwardedBody: string;
  /** Whether a forward/quote marker was actually found. */
  hasForward: boolean;
}

export function splitForwardedEmail(text: string): SplitEmailBody {
  const body = (text ?? "").replace(/\r\n/g, "\n");

  let earliestIndex = -1;
  for (const marker of FORWARD_MARKERS) {
    const match = body.match(marker);
    if (match && match.index !== undefined) {
      if (earliestIndex === -1 || match.index < earliestIndex) {
        earliestIndex = match.index;
      }
    }
  }

  if (earliestIndex === -1) {
    return { userPrompt: body.trim(), forwardedBody: "", hasForward: false };
  }

  return {
    userPrompt: body.slice(0, earliestIndex).trim(),
    forwardedBody: body.slice(earliestIndex).trim(),
    hasForward: true,
  };
}

// --- Sender allow-list -------------------------------------------------------

/**
 * Checks an email address against an allow-list of exact addresses
 * ("sam@acme.dev") or whole-domain entries ("@acme.dev").
 * Case-insensitive. An empty allow-list denies everyone (safe default —
 * nobody can create tasks via email until senders are explicitly configured).
 */
export function isSenderAllowed(from: string | undefined | null, allowList: string[]): boolean {
  if (!from) return false;
  const address = from.trim().toLowerCase();
  const domain = address.split("@")[1] ?? "";

  return allowList.some((entry) => {
    const normalized = entry.trim().toLowerCase();
    if (!normalized) return false;
    if (normalized.startsWith("@")) return domain === normalized.slice(1);
    return address === normalized;
  });
}

export function parseAllowList(raw: string | undefined | null): string[] {
  return (raw ?? "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// --- MIME parsing ------------------------------------------------------------

export interface ParsedInboundEmail {
  fromAddress: string;
  fromName: string;
  subject: string;
  text: string;
  date: Date | null;
  attachmentNames: string[];
}

export async function parseRawEmail(raw: string | Buffer): Promise<ParsedInboundEmail> {
  const parsed: ParsedMail = await simpleParser(raw);

  const fromAddress = parsed.from?.value?.[0]?.address ?? "";
  const fromName = parsed.from?.value?.[0]?.name ?? "";
  const text = parsed.text ?? htmlToText(parsed.html || "");

  return {
    fromAddress,
    fromName,
    subject: parsed.subject ?? "",
    text,
    date: parsed.date ?? null,
    attachmentNames: (parsed.attachments ?? []).map((a) => a.filename || "attachment").filter(Boolean),
  };
}

function htmlToText(html: string | false): string {
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// --- Task field assembly -----------------------------------------------------

export interface EmailTaskFields {
  title: string;
  description: string;
  context: string;
}

const MAX_TITLE_LENGTH = 200;

export function buildTaskFieldsFromEmail(email: ParsedInboundEmail): EmailTaskFields {
  const title = (cleanSubject(email.subject) || "Task from email").slice(0, MAX_TITLE_LENGTH);
  const { userPrompt, forwardedBody, hasForward } = splitForwardedEmail(email.text);

  const description = userPrompt || (hasForward
    ? "Review the forwarded email below and complete the requested task."
    : "Complete the task described in the email below.");

  const contextParts: string[] = [];
  contextParts.push("## Source");
  contextParts.push(`This task was created by forwarding/sending an email to the AI task manager.`);
  contextParts.push(`From: ${email.fromName ? `${email.fromName} <${email.fromAddress}>` : email.fromAddress}`);
  if (email.date) contextParts.push(`Date: ${email.date.toISOString()}`);
  contextParts.push(`Subject: ${email.subject || "(no subject)"}`);
  if (email.attachmentNames.length > 0) {
    contextParts.push(`Attachments (not processed): ${email.attachmentNames.join(", ")}`);
  }

  if (hasForward) {
    contextParts.push("");
    contextParts.push("## Forwarded email content");
    contextParts.push(forwardedBody);
  } else if (!userPrompt) {
    contextParts.push("");
    contextParts.push("## Email content");
    contextParts.push(email.text.trim());
  }

  return { title, description, context: contextParts.join("\n") };
}
