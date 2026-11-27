// Takes the marketing/docs screenshots for the public site from the demo database.
//
//   npm run demo:seed          # (re)build data/demo.db
//   npm run demo:screenshots   # starts the app on :3100 against it, writes site/public/screenshots/
//
// Options (env):
//   DEMO_URL=http://localhost:3100   use an app that's already running against the demo DB
//                                    instead of starting one
//   DEMO_DB=data/demo.db             the demo database (must exist; see seed.ts)
//   SHOTS=board,teams                only take these shots
//
// The app is started with `next dev` in its own dist dir (.next-demo), so it can run beside
// a normal dev server. The worker is never started: the demo DB holds placeholder logins.
// Instead this script writes the worker heartbeat itself so the UI doesn't say
// "Worker offline".
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { chromium, type Page } from "playwright";
import { DEMO_SESSION_TOKEN } from "./demo-constants";

const ROOT = path.resolve(__dirname, "../..");
const DB = path.resolve(process.env.DEMO_DB ?? path.join(ROOT, "data/demo.db"));
const OUT = path.join(ROOT, "site/public/screenshots");
const PORT = 3100;
const BASE = (process.env.DEMO_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, "");

interface Shot {
  name: string;
  path: string | ((ids: DemoIds) => string);
  /** Waits for each of these texts before capturing, so client-fetched sections have rendered. */
  waitFor?: string[];
  /** Crop to the element matching this selector instead of the viewport. */
  clip?: string;
  /** Keep only this many CSS px from the top of the viewport. */
  crop?: number;
  /** Viewport height for this shot (default 900). */
  height?: number;
  /** Runs before capturing (scroll, click, …). */
  prepare?: (page: Page) => Promise<void>;
}

interface DemoIds {
  heroTaskId: string;
}

/** Scrolls the page so the first element with this text sits `offset` px below the top. */
async function scrollToText(page: Page, text: string, offset = 100) {
  await page.getByText(text, { exact: true }).first().evaluate((el, off) => {
    window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - off);
  }, offset);
}

const SHOTS: Shot[] = [
  { name: "board", path: "/tasks/kanban", waitFor: ["Add saved searches"] },
  // Tall viewport, cropped: keeps the sticky "Guide the agent" box below the captured area.
  { name: "task-team", path: (ids) => `/tasks/${ids.heroTaskId}`, waitFor: ["Team progress", "Wiring the menu"], height: 1900, crop: 1060 },
  {
    name: "teams",
    path: "/teams",
    waitFor: ["Feature squad"],
    crop: 640,
    prepare: async (page) => {
      await page.getByRole("button", { name: /Feature squad/ }).click();
      await page.locator("[aria-expanded=true]").first().waitFor();
    },
  },
  { name: "connections", path: "/settings/ai", waitFor: ["Claude Max (personal)"], crop: 1200, height: 1300, prepare: (page) => scrollToText(page, "AI Providers", 24) },
  {
    name: "plan-usage",
    path: "/tasks/kanban",
    waitFor: ["Add saved searches"],
    height: 1000,
    clip: "div.rounded-xl:has(h2:text-is('Provider Health'))",
    prepare: async (page) => {
      await page.getByLabel("Provider health status").click();
      await page.getByText("Provider Health").waitFor();
    },
  },
  { name: "gateway", path: "/analytics/gateway?range=7d", waitFor: ["Support chatbot"], height: 1000 },
  { name: "gateway-breakdown", path: "/analytics/gateway?range=7d", waitFor: ["Support chatbot"], height: 1000, prepare: (page) => scrollToText(page, "By Model", 40) },
  { name: "api-endpoint", path: "/settings/api", waitFor: ["Cursor (Alex)"], height: 1400, clip: "#llm-gateway" },
  { name: "api-keys", path: "/settings/api", waitFor: ["Cursor (Alex)"], height: 1600, clip: "#api-keys" },
  { name: "analytics", path: "/analytics?range=30d", height: 1000 },
];

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { redirect: "manual" });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function startApp(): Promise<ChildProcess> {
  console.log(`Starting the app on :${PORT} against ${path.relative(ROOT, DB)}…`);
  const child = spawn("npx", ["next", "dev", "--port", String(PORT)], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_URL: `file:${DB}`,
      NEXT_DIST_DIR: ".next-demo",
      NEXT_TELEMETRY_DISABLED: "1",
      // Keep a configured OTel export from shipping demo traffic anywhere.
      OTEL_SDK_DISABLED: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  // Inside the dist dir: a log anywhere else in the project is a watched file, and every
  // request writing to it would trigger a recompile and a page reload.
  fs.mkdirSync(path.join(ROOT, ".next-demo"), { recursive: true });
  const logFile = path.join(ROOT, ".next-demo", "demo-server.log");
  const log = fs.createWriteStream(logFile);
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`next dev exited early; see ${logFile}`);
    if (await reachable(`${BASE}/api/settings/worker-health`)) return child;
    await wait(1000);
  }
  throw new Error(`The app didn't come up on ${BASE} within 2 minutes; see ${logFile}`);
}

function stopApp(child: ChildProcess) {
  try {
    if (child.pid) process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

async function main() {
  if (!fs.existsSync(DB)) {
    console.error(`${DB} doesn't exist. Run \`npm run demo:seed\` first.`);
    process.exit(1);
  }
  const ids: DemoIds = JSON.parse(fs.readFileSync(path.join(path.dirname(DB), "demo.json"), "utf8"));
  const only = process.env.SHOTS?.split(",").map((s) => s.trim());
  const shots = only ? SHOTS.filter((s) => only.includes(s.name)) : SHOTS;
  fs.mkdirSync(OUT, { recursive: true });

  // Fake worker heartbeat, written straight to the demo DB (never the real one).
  const db = new Database(DB);
  const beat = () =>
    db.prepare("INSERT INTO Setting (key, value) VALUES ('worker_last_seen', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(new Date().toISOString());
  beat();
  const heartbeat = setInterval(beat, 10_000);

  const app = process.env.DEMO_URL ? null : await startApp();
  const browser = await chromium.launch();
  try {
    // The app is dark-only, so one pass covers it.
    {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
      await context.addCookies([{ name: "tm_session", value: DEMO_SESSION_TOKEN, url: BASE }]);
      // Hide Next's dev-mode indicator and toasts on every page load (dev can reload mid-visit).
      await context.addInitScript(() => {
        document.addEventListener("DOMContentLoaded", () => {
          const style = document.createElement("style");
          style.textContent = "nextjs-portal, [data-sonner-toaster] { display: none !important; }";
          document.head.appendChild(style);
        });
      });
      const page = await context.newPage();

      for (const shot of shots) {
        const url = BASE + (typeof shot.path === "function" ? shot.path(ids) : shot.path);
        await page.setViewportSize({ width: 1440, height: shot.height ?? 900 });
        // The first visit compiles the route in dev; give it time.
        await page.goto(url, { waitUntil: "load", timeout: 180_000 });
        for (const text of shot.waitFor ?? []) await page.getByText(text).first().waitFor({ timeout: 60_000 });
        await shot.prepare?.(page);
        await wait(1500); // charts animate in; polling widgets settle
        const file = path.join(OUT, `${shot.name}.png`);
        if (shot.clip) await page.locator(shot.clip).first().screenshot({ path: file });
        else await page.screenshot({ path: file, clip: shot.crop ? { x: 0, y: 0, width: 1440, height: shot.crop } : undefined });
        console.log(`  ${path.relative(ROOT, file)}`);
      }
      await context.close();
    }
  } finally {
    await browser.close();
    clearInterval(heartbeat);
    db.close();
    if (app) stopApp(app);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
