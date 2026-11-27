// Must stay first: patches `http` before any HTTP client loads (see the module).
import "../lib/otel-preload";
import "dotenv/config";
import { App } from "@slack/bolt";
import { registerSlackHandlers, startNotificationPoller } from "./slack";
import { prisma } from "./db";
import { isRestartPending, restartForRestore } from "../lib/restart-signal";
import { initTelemetry } from "../lib/otel";

interface SlackTokens {
  botToken: string;
  appToken: string;
}

async function getSlackTokens(): Promise<SlackTokens | null> {
  try {
    const integration = await prisma.integration.findUnique({ where: { id: "slack" } });
    if (integration) {
      if (!integration.isEnabled) return null;
      const config = integration.config ? JSON.parse(integration.config as string) : {};
      const botToken = (config.botToken as string | undefined) || process.env.SLACK_BOT_TOKEN;
      const appToken = (config.appToken as string | undefined) || process.env.SLACK_APP_TOKEN;
      if (botToken && appToken) return { botToken, appToken };
      return null;
    }
  } catch (err) {
    console.error("[integrations] Failed to read integration config from DB:", err);
  }

  // Fall back to env vars when no DB record exists yet
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;
  if (botToken && appToken) return { botToken, appToken };
  return null;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// Hot-reload state
let currentBotToken: string | null = null;
let currentAppToken: string | null = null;
let currentApp: App | null = null;
let stopPoller: (() => void) | null = null;

async function stopCurrentApp() {
  if (stopPoller) { stopPoller(); stopPoller = null; }
  if (currentApp) {
    try { await currentApp.stop(); } catch { /* ignore */ }
    currentApp = null;
  }
  currentBotToken = null;
  currentAppToken = null;
}

async function reconcile() {
  const tokens = await getSlackTokens();

  if (!tokens) {
    if (currentApp) {
      console.log("[integrations] Slack integration disabled or unconfigured — stopping bot");
      await stopCurrentApp();
    }
    return;
  }

  // No change — nothing to do
  if (tokens.botToken === currentBotToken && tokens.appToken === currentAppToken) return;

  // Tokens changed (or first start) — (re)start
  if (currentApp) {
    console.log("[integrations] Slack credentials changed — restarting bot…");
    await stopCurrentApp();
  } else {
    console.log("[integrations] Starting Slack bot…");
  }

  currentBotToken = tokens.botToken;
  currentAppToken = tokens.appToken;

  const app = new App({
    token: tokens.botToken,
    appToken: tokens.appToken,
    socketMode: true,
  });

  registerSlackHandlers(app);
  await app.start();
  currentApp = app;
  stopPoller = startNotificationPoller(app.client);
  console.log("[integrations] Slack bot connected via Socket Mode");
}

async function main() {
  // OpenTelemetry export (Settings → Observability); re-reads its settings on its own.
  await initTelemetry({
    role: "integrations",
    loadSettings: async () => {
      const rows: { key: string; value: string }[] = await prisma.setting.findMany();
      return Object.fromEntries(rows.map((r) => [r.key, r.value]));
    },
  });

  // Initial connect (may loop until configured)
  while (true) {
    // A backup restore swaps out the SQLite file this process has open — this
    // process has no in-flight work of its own, so it's always safe to restart
    // as soon as we notice.
    if (isRestartPending()) restartForRestore("Detected a completed database restore");

    try {
      await reconcile();
    } catch (err) {
      console.error("[integrations] reconcile error:", err);
    }
    if (currentApp) break;
    console.log("[integrations] Slack not configured or disabled — checking again in 30s");
    await sleep(30_000);
  }

  // Poll for config changes every 30s
  setInterval(async () => {
    if (isRestartPending()) restartForRestore("Detected a completed database restore");

    try {
      await reconcile();
    } catch (err) {
      console.error("[integrations] reconcile error:", err);
    }
  }, 30_000);
}

main().catch((err) => {
  console.error("[integrations] Fatal error:", err);
  process.exit(1);
});
