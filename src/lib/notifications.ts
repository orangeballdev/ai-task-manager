import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import nodemailer from "nodemailer";
import { DEFAULT_APP_HOST } from "./app-host";
import { resolveEmailTransport, type EmailTransportConfig } from "./email-transport";

function buildHtmlEmail(params: {
  event: "completed" | "failed";
  taskTitle: string;
  taskUrl: string;
  lastMessage?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCost?: number;
  provider?: string;
  model?: string;
}): string {
  const { event, taskTitle, taskUrl, lastMessage, inputTokens, outputTokens, estimatedCost, provider, model } = params;
  const isCompleted = event === "completed";
  const statusColor = isCompleted ? "#22c55e" : "#ef4444";
  const statusText = isCompleted ? "Completed" : "Failed";
  const statusBg = isCompleted ? "#052e16" : "#2d0a0a";

  const lastMessageHtml = lastMessage
    ? `
      <div style="margin:24px 0 0;padding:16px;background:#1e293b;border-left:3px solid #38bdf8;border-radius:4px;">
        <p style="margin:0 0 8px;font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#94a3b8;">Last AI Message</p>
        <p style="margin:0;font-size:14px;line-height:1.6;color:#cbd5e1;white-space:pre-wrap;">${escapeHtml(lastMessage)}</p>
      </div>`
    : "";

  const detailsHtml =
    isCompleted && (inputTokens !== undefined || outputTokens !== undefined || estimatedCost !== undefined || provider || model)
      ? `
      <div style="margin:24px 0 0;padding:16px;background:#1e293b;border-radius:4px;">
        <p style="margin:0 0 12px;font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#94a3b8;">Task Details</p>
        <table style="width:100%;border-collapse:collapse;">
          ${inputTokens !== undefined ? `<tr style="border-bottom:1px solid #334155;"><td style="padding:8px 0;font-size:13px;color:#94a3b8;">Input Tokens</td><td style="padding:8px 0;text-align:right;font-size:13px;color:#cbd5e1;font-weight:600;">${inputTokens.toLocaleString()}</td></tr>` : ""}
          ${outputTokens !== undefined ? `<tr style="border-bottom:1px solid #334155;"><td style="padding:8px 0;font-size:13px;color:#94a3b8;">Output Tokens</td><td style="padding:8px 0;text-align:right;font-size:13px;color:#cbd5e1;font-weight:600;">${outputTokens.toLocaleString()}</td></tr>` : ""}
          ${estimatedCost !== undefined ? `<tr style="border-bottom:1px solid #334155;"><td style="padding:8px 0;font-size:13px;color:#94a3b8;">Estimated Cost</td><td style="padding:8px 0;text-align:right;font-size:13px;color:#cbd5e1;font-weight:600;">$${estimatedCost.toFixed(4)}</td></tr>` : ""}
          ${provider ? `<tr style="border-bottom:1px solid #334155;"><td style="padding:8px 0;font-size:13px;color:#94a3b8;">Provider</td><td style="padding:8px 0;text-align:right;font-size:13px;color:#cbd5e1;font-weight:600;">${escapeHtml(provider)}</td></tr>` : ""}
          ${model ? `<tr><td style="padding:8px 0;font-size:13px;color:#94a3b8;">Model</td><td style="padding:8px 0;text-align:right;font-size:13px;color:#cbd5e1;font-weight:600;">${escapeHtml(model)}</td></tr>` : ""}
        </table>
      </div>`
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Task ${statusText}</title>
</head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;min-height:100vh;">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
          <!-- Header -->
          <tr>
            <td style="padding:0 0 24px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <table cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td valign="middle" style="padding-right:8px;">
                          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#E8865A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" style="display:block;">
                            <path d="M12 8V4H8"/>
                            <rect width="16" height="12" x="4" y="8" rx="2"/>
                            <path d="M2 14h2"/>
                            <path d="M20 14h2"/>
                            <path d="M15 13v2"/>
                            <path d="M9 13v2"/>
                          </svg>
                        </td>
                        <td valign="middle">
                          <span style="font-size:18px;font-weight:700;color:#f8fafc;letter-spacing:-0.02em;">AI Task Manager</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                  <td align="right">
                    <span style="display:inline-block;padding:4px 12px;border-radius:9999px;font-size:12px;font-weight:600;background:${statusBg};color:${statusColor};border:1px solid ${statusColor}33;">
                      ${statusText}
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Card -->
          <tr>
            <td style="background:#1e293b;border-radius:12px;border:1px solid #334155;overflow:hidden;">
              <div style="padding:28px 32px;">
                <p style="margin:0 0 6px;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;">
                  Task ${statusText}
                </p>
                <h1 style="margin:0 0 20px;font-size:22px;font-weight:700;color:#f8fafc;line-height:1.3;">
                  ${escapeHtml(taskTitle)}
                </h1>
                <p style="margin:0;font-size:15px;color:#94a3b8;line-height:1.6;">
                  ${isCompleted
                    ? "Your task has been completed successfully by the AI agent."
                    : "Your task encountered an error and could not be completed."}
                </p>
                ${lastMessageHtml}
                ${detailsHtml}
                <div style="margin:28px 0 0;">
                  <a href="${taskUrl}" style="display:inline-block;padding:12px 24px;background:#0ea5e9;color:#ffffff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600;">
                    View Task →
                  </a>
                </div>
              </div>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:24px 0 0;">
              <p style="margin:0;font-size:12px;color:#475569;text-align:center;">
                Sent by <a href="${taskUrl.split("/tasks/")[0]}" style="color:#64748b;text-decoration:none;">AI Task Manager</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Sends one email with the delivery method from Settings → Notifications → Email
 * delivery (`resolveEmailTransport()`). Throws a plain-language error when email
 * isn't set up, so the test button and task logs say what to fix.
 */
export async function sendEmail(
  to: string,
  subject: string,
  body: string,
  htmlBody: string | undefined,
  transport: EmailTransportConfig,
): Promise<void> {
  if (transport.kind === "none") throw new Error(transport.reason);

  if (transport.kind === "smtp") {
    const mailer = nodemailer.createTransport({
      host: transport.host,
      port: transport.port,
      secure: transport.security === "tls",
      requireTLS: transport.security === "starttls",
      ignoreTLS: transport.security === "none",
      ...(transport.auth ? { auth: transport.auth } : {}),
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
    try {
      await mailer.sendMail({ from: transport.from, to, subject, text: body, ...(htmlBody ? { html: htmlBody } : {}) });
    } finally {
      mailer.close();
    }
    return;
  }

  const client = new SESClient({
    region: transport.region,
    ...(transport.credentials ? { credentials: transport.credentials } : {}),
  });
  const command = new SendEmailCommand({
    Source: transport.from,
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject, Charset: "UTF-8" },
      Body: {
        Text: { Data: body, Charset: "UTF-8" },
        ...(htmlBody ? { Html: { Data: htmlBody, Charset: "UTF-8" } } : {}),
      },
    },
  });
  await client.send(command);
}

interface NotificationSettings {
  emailEnabled: boolean;
  emailAddress: string;
  /** How to deliver email; `kind: "none"` (with the reason) until it's set up. */
  transport: EmailTransportConfig;
  onCompleted: boolean;
  onFailed: boolean;
  onProviderAuthFailed: boolean;
  onLowUsageWarning: boolean;
  onFileDeletion: boolean;
}

export async function getAppHost(
  prisma: { setting: { findMany: () => Promise<{ key: string; value: string }[]> } }
): Promise<string> {
  const settings = await prisma.setting.findMany();
  const map: Record<string, string> = {};
  for (const s of settings) map[s.key] = s.value;
  return map.app_host || DEFAULT_APP_HOST;
}

export async function getNotificationSettings(
  prisma: { setting: { findMany: () => Promise<{ key: string; value: string }[]> } }
): Promise<NotificationSettings> {
  const settings = await prisma.setting.findMany();
  const map: Record<string, string> = {};
  for (const s of settings) map[s.key] = s.value;
  return {
    emailEnabled: map.notification_email_enabled === "true",
    emailAddress: map.notification_email_address ?? "",
    transport: resolveEmailTransport(map, process.env),
    onCompleted: (map.notification_on_completed ?? "true") === "true",
    onFailed: (map.notification_on_failed ?? "true") === "true",
    onProviderAuthFailed: (map.notification_on_provider_auth_failed ?? "true") === "true",
    onLowUsageWarning: (map.notification_on_low_usage_warning ?? "false") === "true",
    onFileDeletion: (map.notification_on_file_deletion ?? "true") === "true",
  };
}

export type NotificationResult =
  | { sent: true }
  | { sent: false; reason: string };

export async function sendTaskNotification(
  notif: NotificationSettings,
  event: "completed" | "failed",
  task: {
    id: string;
    title: string;
    description: string;
    inputTokens?: number | null;
    outputTokens?: number | null;
    estimatedCost?: number | null;
    provider?: string;
    model?: string | null;
  },
  lastAIMessage?: string,
  appHost?: string
): Promise<NotificationResult> {
  if (!notif.emailEnabled) return { sent: false, reason: "Email notifications are disabled in settings" };
  if (!notif.emailAddress) return { sent: false, reason: "No notification email address configured in settings" };
  if (notif.transport.kind === "none") return { sent: false, reason: notif.transport.reason };
  if (event === "completed" && !notif.onCompleted) return { sent: false, reason: "Notifications for completed tasks are disabled in settings" };
  if (event === "failed" && !notif.onFailed) return { sent: false, reason: "Notifications for failed tasks are disabled in settings" };

  const subject =
    event === "completed"
      ? `Task completed: ${task.title}`
      : `Task failed: ${task.title}`;

  const baseUrl = `http://${appHost || DEFAULT_APP_HOST}`.replace(/\/$/, "");
  const taskUrl = `${baseUrl}/tasks/${task.id}`;

  const plainText =
    event === "completed"
      ? `Your task "${task.title}" has completed successfully.\n${lastAIMessage ? `\nAI summary:\n${lastAIMessage}\n` : ""}\nView task: ${taskUrl}`
      : `Your task "${task.title}" has failed.\n${lastAIMessage ? `\nLast message:\n${lastAIMessage}\n` : ""}\nView task: ${taskUrl}`;

  const htmlBody = buildHtmlEmail({
    event,
    taskTitle: task.title,
    taskUrl,
    lastMessage: lastAIMessage,
    inputTokens: task.inputTokens ?? undefined,
    outputTokens: task.outputTokens ?? undefined,
    estimatedCost: task.estimatedCost ?? undefined,
    provider: task.provider,
    model: task.model ?? undefined,
  });

  await sendEmail(notif.emailAddress, subject, plainText, htmlBody, notif.transport);
  return { sent: true };
}

function buildProviderAuthFailureHtml(params: {
  providerName: string;
  errorMessage: string;
  settingsUrl: string;
}): string {
  const { providerName, errorMessage, settingsUrl } = params;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Provider Authentication Failed</title>
</head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;min-height:100vh;">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
          <tr>
            <td style="padding:0 0 24px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <table cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td valign="middle" style="padding-right:8px;">
                          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#E8865A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" style="display:block;">
                            <path d="M12 8V4H8"/>
                            <rect width="16" height="12" x="4" y="8" rx="2"/>
                            <path d="M2 14h2"/>
                            <path d="M20 14h2"/>
                            <path d="M15 13v2"/>
                            <path d="M9 13v2"/>
                          </svg>
                        </td>
                        <td valign="middle">
                          <span style="font-size:18px;font-weight:700;color:#f8fafc;letter-spacing:-0.02em;">AI Task Manager</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                  <td align="right">
                    <span style="display:inline-block;padding:4px 12px;border-radius:9999px;font-size:12px;font-weight:600;background:#2d0a0a;color:#ef4444;border:1px solid #ef444433;">
                      Auth Failed
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="background:#1e293b;border-radius:12px;border:1px solid #334155;overflow:hidden;">
              <div style="padding:28px 32px;">
                <p style="margin:0 0 6px;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;">
                  Provider Authentication Failed
                </p>
                <h1 style="margin:0 0 20px;font-size:22px;font-weight:700;color:#f8fafc;line-height:1.3;">
                  ${escapeHtml(providerName)}
                </h1>
                <p style="margin:0 0 20px;font-size:15px;color:#94a3b8;line-height:1.6;">
                  The credentials for this provider have expired and could not be automatically refreshed. Tasks using this provider will fail until credentials are updated.
                </p>
                <div style="padding:16px;background:#1e293b;border-left:3px solid #ef4444;border-radius:4px;margin:0 0 24px;">
                  <p style="margin:0 0 8px;font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#94a3b8;">Error</p>
                  <p style="margin:0;font-size:13px;line-height:1.6;color:#fca5a5;font-family:monospace;white-space:pre-wrap;">${escapeHtml(errorMessage)}</p>
                </div>
                <a href="${settingsUrl}" style="display:inline-block;padding:12px 24px;background:#0ea5e9;color:#ffffff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600;">
                  Update Credentials →
                </a>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 0 0;">
              <p style="margin:0;font-size:12px;color:#475569;text-align:center;">
                Sent by <a href="${settingsUrl.split("/settings")[0]}" style="color:#64748b;text-decoration:none;">AI Task Manager</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export async function sendProviderAuthFailureNotification(
  notif: NotificationSettings,
  providerName: string,
  errorMessage: string,
  appHost?: string,
): Promise<NotificationResult> {
  if (!notif.emailEnabled) return { sent: false, reason: "Email notifications are disabled in settings" };
  if (!notif.emailAddress) return { sent: false, reason: "No notification email address configured in settings" };
  if (notif.transport.kind === "none") return { sent: false, reason: notif.transport.reason };
  if (!notif.onProviderAuthFailed) return { sent: false, reason: "Provider auth failure notifications are disabled in settings" };

  const baseUrl = `http://${appHost || DEFAULT_APP_HOST}`.replace(/\/$/, "");
  const settingsUrl = `${baseUrl}/settings/providers`;

  const subject = `Authentication failed: ${providerName}`;
  const plainText = `The credentials for provider "${providerName}" have expired and could not be automatically refreshed.\n\nError: ${errorMessage}\n\nUpdate credentials: ${settingsUrl}`;
  const htmlBody = buildProviderAuthFailureHtml({ providerName, errorMessage, settingsUrl });

  await sendEmail(notif.emailAddress, subject, plainText, htmlBody, notif.transport);
  return { sent: true };
}

function buildFileDeletionHtml(params: {
  fileNames: string[];
  retentionDays: number;
  filesUrl: string;
}): string {
  const { fileNames, retentionDays, filesUrl } = params;

  const fileListHtml = fileNames
    .map(
      (name) =>
        `<li style="padding:6px 0;font-size:13px;line-height:1.6;color:#cbd5e1;font-family:monospace;border-bottom:1px solid #334155;">${escapeHtml(name)}</li>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Files About to Be Deleted</title>
</head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;min-height:100vh;">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
          <tr>
            <td style="padding:0 0 24px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <table cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td valign="middle" style="padding-right:8px;">
                          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#E8865A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" style="display:block;">
                            <path d="M12 8V4H8"/>
                            <rect width="16" height="12" x="4" y="8" rx="2"/>
                            <path d="M2 14h2"/>
                            <path d="M20 14h2"/>
                            <path d="M15 13v2"/>
                            <path d="M9 13v2"/>
                          </svg>
                        </td>
                        <td valign="middle">
                          <span style="font-size:18px;font-weight:700;color:#f8fafc;letter-spacing:-0.02em;">AI Task Manager</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                  <td align="right">
                    <span style="display:inline-block;padding:4px 12px;border-radius:9999px;font-size:12px;font-weight:600;background:#7c2d12;color:#fb923c;border:1px solid #fb923c33;">
                      Files Deleted
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="background:#1e293b;border-radius:12px;border:1px solid #334155;overflow:hidden;">
              <div style="padding:28px 32px;">
                <p style="margin:0 0 6px;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;">
                  Automatic File Cleanup
                </p>
                <h1 style="margin:0 0 20px;font-size:22px;font-weight:700;color:#f8fafc;line-height:1.3;">
                  ${fileNames.length} file${fileNames.length === 1 ? "" : "s"} about to be deleted
                </h1>
                <p style="margin:0 0 20px;font-size:15px;color:#94a3b8;line-height:1.6;">
                  These files are older than ${retentionDays} day${retentionDays === 1 ? "" : "s"} and will be permanently removed by the automatic file retention cleanup. Mark a file or folder as protected in the Files browser to exempt it from future cleanups.
                </p>
                <div style="margin:0 0 24px;padding:16px;background:#1e293b;border-left:3px solid #fb923c;border-radius:4px;">
                  <p style="margin:0 0 8px;font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#94a3b8;">Files</p>
                  <ul style="margin:0;padding:0;list-style:none;">
                    ${fileListHtml}
                  </ul>
                </div>
                <a href="${filesUrl}" style="display:inline-block;padding:12px 24px;background:#0ea5e9;color:#ffffff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600;">
                  View Files →
                </a>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 0 0;">
              <p style="margin:0;font-size:12px;color:#475569;text-align:center;">
                Sent by <a href="${filesUrl.split("/files")[0]}" style="color:#64748b;text-decoration:none;">AI Task Manager</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export async function sendFileDeletionNotification(
  notif: NotificationSettings,
  fileNames: string[],
  retentionDays: number,
  appHost?: string,
): Promise<NotificationResult> {
  if (!notif.emailEnabled) return { sent: false, reason: "Email notifications are disabled in settings" };
  if (!notif.emailAddress) return { sent: false, reason: "No notification email address configured in settings" };
  if (notif.transport.kind === "none") return { sent: false, reason: notif.transport.reason };
  if (!notif.onFileDeletion) return { sent: false, reason: "File deletion notifications are disabled in settings" };
  if (fileNames.length === 0) return { sent: false, reason: "No files to notify about" };

  const baseUrl = `http://${appHost || DEFAULT_APP_HOST}`.replace(/\/$/, "");
  const filesUrl = `${baseUrl}/files`;

  const subject = `${fileNames.length} file${fileNames.length === 1 ? "" : "s"} about to be deleted`;
  const plainText =
    `The following file${fileNames.length === 1 ? "" : "s"} ${fileNames.length === 1 ? "is" : "are"} older than ${retentionDays} day${retentionDays === 1 ? "" : "s"} and will be permanently removed by the automatic file retention cleanup:\n\n` +
    fileNames.map((name) => `- ${name}`).join("\n") +
    `\n\nView files: ${filesUrl}`;
  const htmlBody = buildFileDeletionHtml({ fileNames, retentionDays, filesUrl });

  await sendEmail(notif.emailAddress, subject, plainText, htmlBody, notif.transport);
  return { sent: true };
}

// --- Inbound-email integration replies --------------------------------------
//
// These reply directly to whoever emailed the task manager (see
// src/app/api/integrations/email/inbound/route.ts and Task.sourceEmail),
// independent of the admin's global notification-settings address above.

function buildEmailConfirmationHtml(params: { taskTitle: string; taskUrl: string }): string {
  const { taskTitle, taskUrl } = params;
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>Task Created</title></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;min-height:100vh;">
    <tr><td align="center" style="padding:40px 16px;">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
        <tr><td style="background:#1e293b;border-radius:12px;border:1px solid #334155;overflow:hidden;">
          <div style="padding:28px 32px;">
            <p style="margin:0 0 6px;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;">Task Created</p>
            <h1 style="margin:0 0 20px;font-size:22px;font-weight:700;color:#f8fafc;line-height:1.3;">${escapeHtml(taskTitle)}</h1>
            <p style="margin:0;font-size:15px;color:#94a3b8;line-height:1.6;">
              Got your email, a task has been queued and the agent will start on it shortly. You'll get another email here when it's done.
            </p>
            <div style="margin:28px 0 0;">
              <a href="${taskUrl}" style="display:inline-block;padding:12px 24px;background:#0ea5e9;color:#ffffff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600;">View Task →</a>
            </div>
          </div>
        </td></tr>
        <tr><td style="padding:24px 0 0;"><p style="margin:0;font-size:12px;color:#475569;text-align:center;">Sent by <a href="${taskUrl.split("/tasks/")[0]}" style="color:#64748b;text-decoration:none;">AI Task Manager</a></p></td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Confirms receipt of an inbound email by replying to the sender right after
 * the task is created. Best-effort — callers should swallow errors so a
 * flaky mail server never prevents the task itself from being created.
 */
export async function sendEmailTaskCreatedConfirmation(
  to: string,
  task: { id: string; title: string },
  appHost: string | undefined,
  transport: EmailTransportConfig,
): Promise<void> {
  if (transport.kind === "none") return; // email isn't set up; the task was still created
  const baseUrl = `http://${appHost || DEFAULT_APP_HOST}`.replace(/\/$/, "");
  const taskUrl = `${baseUrl}/tasks/${task.id}`;
  const subject = `Task created: ${task.title}`;
  const plainText = `Got your email, a task has been queued:\n\n${task.title}\n\nYou'll get another email here when it's done.\n\nView task: ${taskUrl}`;
  const htmlBody = buildEmailConfirmationHtml({ taskTitle: task.title, taskUrl });
  await sendEmail(to, subject, plainText, htmlBody, transport);
}

/**
 * Replies to the original sender of an inbound-email task once it reaches a
 * terminal state, reusing the same completed/failed template as the admin
 * notification email. Unlike sendTaskNotification, this is not gated by the
 * global notification settings — the presence of Task.sourceEmail is itself
 * the opt-in signal (the sender asked for this task by emailing it in).
 */
export async function sendEmailTaskResultReply(
  to: string,
  event: "completed" | "failed",
  task: {
    id: string;
    title: string;
    description: string;
    inputTokens?: number | null;
    outputTokens?: number | null;
    estimatedCost?: number | null;
    provider?: string;
    model?: string | null;
  },
  lastAIMessage: string | undefined,
  appHost: string | undefined,
  transport: EmailTransportConfig,
): Promise<NotificationResult> {
  if (transport.kind === "none") return { sent: false, reason: transport.reason };
  const subject = event === "completed" ? `Task completed: ${task.title}` : `Task failed: ${task.title}`;
  const baseUrl = `http://${appHost || DEFAULT_APP_HOST}`.replace(/\/$/, "");
  const taskUrl = `${baseUrl}/tasks/${task.id}`;

  const plainText =
    event === "completed"
      ? `Your task "${task.title}" has completed.\n${lastAIMessage ? `\nAI summary:\n${lastAIMessage}\n` : ""}\nView task: ${taskUrl}`
      : `Your task "${task.title}" has failed.\n${lastAIMessage ? `\nLast message:\n${lastAIMessage}\n` : ""}\nView task: ${taskUrl}`;

  const htmlBody = buildHtmlEmail({
    event,
    taskTitle: task.title,
    taskUrl,
    lastMessage: lastAIMessage,
    inputTokens: task.inputTokens ?? undefined,
    outputTokens: task.outputTokens ?? undefined,
    estimatedCost: task.estimatedCost ?? undefined,
    provider: task.provider,
    model: task.model ?? undefined,
  });

  await sendEmail(to, subject, plainText, htmlBody, transport);
  return { sent: true };
}

function buildLowUsageWarningHtml(params: {
  providerName: string;
  utilizationPercent: number;
  hoursUntilReset: number;
  resetsAt: string;
  healthUrl: string;
}): string {
  const { providerName, utilizationPercent, hoursUntilReset, resetsAt, healthUrl } = params;
  const availablePercent = 100 - utilizationPercent;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Usage Warning</title>
</head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;min-height:100vh;">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
          <tr>
            <td style="padding:0 0 24px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <table cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td valign="middle" style="padding-right:8px;">
                          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#E8865A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" style="display:block;">
                            <path d="M12 8V4H8"/>
                            <rect width="16" height="12" x="4" y="8" rx="2"/>
                            <path d="M2 14h2"/>
                            <path d="M20 14h2"/>
                            <path d="M15 13v2"/>
                            <path d="M9 13v2"/>
                          </svg>
                        </td>
                        <td valign="middle">
                          <span style="font-size:18px;font-weight:700;color:#f8fafc;letter-spacing:-0.02em;">AI Task Manager</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                  <td align="right">
                    <span style="display:inline-block;padding:4px 12px;border-radius:9999px;font-size:12px;font-weight:600;background:#7c2d12;color:#fb923c;border:1px solid #fb923c33;">
                      Usage Warning
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="background:#1e293b;border-radius:12px;border:1px solid #334155;overflow:hidden;">
              <div style="padding:28px 32px;">
                <p style="margin:0 0 6px;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;">
                  Usage Limit Warning
                </p>
                <h1 style="margin:0 0 20px;font-size:22px;font-weight:700;color:#f8fafc;line-height:1.3;">
                  Limited quota renewal approaching
                </h1>
                <p style="margin:0 0 20px;font-size:15px;color:#94a3b8;line-height:1.6;">
                  Your ${escapeHtml(providerName)} subscription has ${availablePercent.toFixed(1)}% quota remaining and resets in ${hoursUntilReset} hours.
                </p>
                <div style="padding:16px;background:#1e293b;border-left:3px solid #fb923c;border-radius:4px;margin:0 0 24px;">
                  <p style="margin:0 0 12px;font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#94a3b8;">Current Status</p>
                  <table style="width:100%;border-collapse:collapse;">
                    <tr style="border-bottom:1px solid #334155;">
                      <td style="padding:8px 0;font-size:13px;color:#94a3b8;">Used</td>
                      <td style="padding:8px 0;text-align:right;font-size:13px;color:#cbd5e1;font-weight:600;">${utilizationPercent.toFixed(1)}%</td>
                    </tr>
                    <tr style="border-bottom:1px solid #334155;">
                      <td style="padding:8px 0;font-size:13px;color:#94a3b8;">Available</td>
                      <td style="padding:8px 0;text-align:right;font-size:13px;color:#cbd5e1;font-weight:600;">${availablePercent.toFixed(1)}%</td>
                    </tr>
                    <tr>
                      <td style="padding:8px 0;font-size:13px;color:#94a3b8;">Resets</td>
                      <td style="padding:8px 0;text-align:right;font-size:13px;color:#cbd5e1;font-weight:600;">${escapeHtml(resetsAt)}</td>
                    </tr>
                  </table>
                </div>
                <a href="${healthUrl}" style="display:inline-block;padding:12px 24px;background:#0ea5e9;color:#ffffff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600;">
                  View Provider Health →
                </a>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 0 0;">
              <p style="margin:0;font-size:12px;color:#475569;text-align:center;">
                Sent by <a href="${healthUrl.split("/settings")[0]}" style="color:#64748b;text-decoration:none;">AI Task Manager</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export async function sendLowUsageWarningNotification(
  notif: NotificationSettings,
  providerName: string,
  utilizationPercent: number,
  hoursUntilReset: number,
  resetsAt: string,
  appHost?: string,
): Promise<NotificationResult> {
  if (!notif.emailEnabled) return { sent: false, reason: "Email notifications are disabled in settings" };
  if (!notif.emailAddress) return { sent: false, reason: "No notification email address configured in settings" };
  if (notif.transport.kind === "none") return { sent: false, reason: notif.transport.reason };
  if (!notif.onLowUsageWarning) return { sent: false, reason: "Low usage warning notifications are disabled in settings" };

  const baseUrl = `http://${appHost || DEFAULT_APP_HOST}`.replace(/\/$/, "");
  const healthUrl = `${baseUrl}/settings/ai`;

  const subject = `Usage warning: ${providerName} quota running low`;
  const availablePercent = 100 - utilizationPercent;
  const plainText = `Your ${providerName} subscription has ${availablePercent.toFixed(1)}% quota remaining and resets in ${hoursUntilReset} hours (${resetsAt}).\n\nView provider health: ${healthUrl}`;
  const htmlBody = buildLowUsageWarningHtml({
    providerName,
    utilizationPercent,
    hoursUntilReset,
    resetsAt,
    healthUrl,
  });

  await sendEmail(notif.emailAddress, subject, plainText, htmlBody, notif.transport);
  return { sent: true };
}
