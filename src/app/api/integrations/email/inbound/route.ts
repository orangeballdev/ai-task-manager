import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  parseRawEmail,
  buildTaskFieldsFromEmail,
  isSenderAllowed,
  parseAllowList,
  type ParsedInboundEmail,
} from "@/lib/email-inbound";
import { sendEmailTaskCreatedConfirmation, getAppHost, getNotificationSettings } from "@/lib/notifications";
import { gitFieldsForMode, resolveRepoBranch, resolveRepoDefaults } from "@/lib/repos";
import { existingTeamId } from "@/lib/teams";
import { normalizePriority } from "@/lib/priority";

interface EmailIntegrationConfig {
  inboundToken?: string;
  allowedSenders?: string;
  repoUrl?: string;
  repoAlias?: string;
  topicArn?: string;
}

// SES's "Deliver to SNS topic" receipt action, when configured to include the
// original message, publishes an SNS Notification whose Message body is this
// shape. `content` is the raw base64-encoded MIME email (present for messages
// under SES's inline size limit).
interface SesReceivedNotification {
  notificationType?: string;
  mail?: {
    commonHeaders?: { from?: string[]; subject?: string; date?: string };
  };
  content?: string;
}

interface SnsEnvelope {
  Type?: string;
  TopicArn?: string;
  Message?: string;
  SubscribeURL?: string;
  MessageId?: string;
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status });
}

/**
 * SNS's SubscriptionConfirmation handshake requires fetching a one-time
 * confirmation URL. Only ever fetch AWS-hosted URLs — never anything an
 * attacker-supplied payload could point at arbitrary hosts (SSRF).
 */
function isTrustedAwsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && /(^|\.)amazonaws\.com$/.test(parsed.hostname);
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const integration = await prisma.integration.findUnique({ where: { id: "email" } });
  if (!integration || !integration.isEnabled) {
    return jsonResponse({ error: "Email integration not enabled" }, 404);
  }

  const config: EmailIntegrationConfig = integration.config ? JSON.parse(integration.config as string) : {};

  const token = req.nextUrl.searchParams.get("token");
  if (!config.inboundToken || token !== config.inboundToken) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  // SNS posts JSON but typically sets Content-Type: text/plain — read raw text
  // and parse manually rather than relying on req.json().
  let envelope: SnsEnvelope;
  try {
    const raw = await req.text();
    envelope = JSON.parse(raw) as SnsEnvelope;
  } catch {
    return jsonResponse({ error: "Invalid request body" }, 400);
  }

  if (config.topicArn && envelope.TopicArn && envelope.TopicArn !== config.topicArn) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  // --- SNS subscription handshake ---
  if (envelope.Type === "SubscriptionConfirmation") {
    if (!envelope.SubscribeURL || !isTrustedAwsUrl(envelope.SubscribeURL)) {
      return jsonResponse({ error: "Missing or untrusted SubscribeURL" }, 400);
    }
    try {
      await fetch(envelope.SubscribeURL);
    } catch (err) {
      console.error("[email-inbound] Failed to confirm SNS subscription:", err);
      return jsonResponse({ error: "Failed to confirm subscription" }, 500);
    }
    return jsonResponse({ confirmed: true });
  }

  if (envelope.Type !== "Notification" || !envelope.Message) {
    // Unsubscribe confirmations etc. — nothing to do.
    return jsonResponse({ ok: true });
  }

  let sesEvent: SesReceivedNotification;
  try {
    sesEvent = JSON.parse(envelope.Message) as SesReceivedNotification;
  } catch {
    return jsonResponse({ error: "Invalid SES notification payload" }, 400);
  }

  if (sesEvent.notificationType && sesEvent.notificationType !== "Received") {
    // Bounce/complaint notifications on a shared topic — not our concern here.
    return jsonResponse({ ok: true });
  }

  let email: ParsedInboundEmail;
  if (sesEvent.content) {
    try {
      const raw = Buffer.from(sesEvent.content, "base64");
      email = await parseRawEmail(raw);
    } catch (err) {
      console.error("[email-inbound] Failed to parse raw email:", err);
      return jsonResponse({ error: "Failed to parse email" }, 400);
    }
  } else {
    // No inline content (message exceeded SES's size limit for the SNS
    // action) — fall back to whatever headers SES did give us.
    const headers = sesEvent.mail?.commonHeaders;
    email = {
      fromAddress: (headers?.from?.[0] ?? "").replace(/^.*<([^>]+)>.*$/, "$1"),
      fromName: "",
      subject: headers?.subject ?? "",
      text: "(Email body unavailable: the message was too large to deliver inline. Check your inbox directly.)",
      date: headers?.date ? new Date(headers.date) : null,
      attachmentNames: [],
    };
  }

  const allowList = parseAllowList(config.allowedSenders);
  if (!isSenderAllowed(email.fromAddress, allowList)) {
    console.warn(`[email-inbound] Rejected email from disallowed sender: ${email.fromAddress || "(unknown)"}`);
    return jsonResponse({ ok: true, created: false, reason: "sender not allowed" });
  }

  const fields = buildTaskFieldsFromEmail(email);

  const [providerSetting, modelSetting] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "provider_mode" } }),
    prisma.setting.findUnique({ where: { key: "anthropic_model" } }),
  ]);

  const maxPos = await prisma.task.aggregate({ _max: { position: true } });
  const position = (maxPos._max.position ?? -1) + 1;

  const repoAlias = config.repoUrl
    ? (config.repoAlias || config.repoUrl.split("/").pop()?.replace(/\.git$/, "") || "repo")
    : null;
  // Inbound emails have no priority of their own, so fall back to the target
  // repo's default priority (set on the Repositories page) when configured.
  // Same for the repo's default branch and "after task completes" mode.
  const repoDefaults = await resolveRepoDefaults([config.repoUrl]);
  const priority = normalizePriority(repoDefaults.defaultPriority);
  const gitFields = repoDefaults.defaultGitMode
    ? gitFieldsForMode(repoDefaults.defaultGitMode, repoDefaults.defaultTargetBranch)
    : {};

  let task;
  try {
    task = await prisma.task.create({
      data: {
        title: fields.title,
        description: fields.description,
        context: fields.context,
        provider: providerSetting?.value ?? "cli",
        model: modelSetting?.value || null,
        // No per-integration AI provider override here — emailed tasks always use
        // the platform's default provider configuration (Settings > AI Providers).
        position,
        priority,
        sourceEmail: email.fromAddress || null,
        ...gitFields,
        teamId: await existingTeamId(repoDefaults.defaultTeamId),
        repos: config.repoUrl
          ? { create: [{ alias: repoAlias!, url: config.repoUrl, branch: resolveRepoBranch(null, repoDefaults.defaultBranch) }] }
          : undefined,
      },
      include: { repos: true },
    });
  } catch (err) {
    console.error("[email-inbound] Failed to create task:", err);
    return jsonResponse({ error: "Failed to create task" }, 500);
  }

  if (email.fromAddress) {
    try {
      const appHost = await getAppHost(prisma);
      const { transport } = await getNotificationSettings(prisma);
      await sendEmailTaskCreatedConfirmation(email.fromAddress, task, appHost, transport);
    } catch (err) {
      // Confirmation email is a nicety, never let it fail the request.
      console.error("[email-inbound] Failed to send confirmation email:", err);
    }
  }

  return jsonResponse({ ok: true, created: true, taskId: task.id });
}
