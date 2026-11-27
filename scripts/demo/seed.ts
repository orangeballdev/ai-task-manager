// Builds a self-contained demo database for marketing screenshots.
//
//   npm run demo:seed              # writes data/demo.db (gitignored)
//   DEMO_DB=/tmp/x.db npm run demo:seed
//
// It never touches the real database: the path is always DEMO_DB (default
// data/demo.db), the file is deleted and re-migrated from scratch on every run, and
// the script refuses to write to a path that looks like the live DB.
//
// Everything in it is fictional (an "acme" org, fake keys and logins). Provider
// credentials are placeholders, so never point the worker at this database: the
// screenshot script only runs the Next.js app against it.
import { execFileSync } from "child_process";
import { createHash, randomBytes } from "crypto";
import fs from "fs";
import path from "path";
import { DEMO_SESSION_TOKEN } from "./demo-constants";

const dbPath = path.resolve(process.env.DEMO_DB ?? "data/demo.db");
if (/\/(dev|prod)\.db$/.test(dbPath)) {
  console.error(`Refusing to seed ${dbPath}: that looks like a real database. Use a path like data/demo.db.`);
  process.exit(1);
}

// ---------- deterministic randomness, so re-seeding gives the same screenshots ----------
let seed = 42;
function rand(): number {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
const between = (lo: number, hi: number) => Math.round(lo + rand() * (hi - lo));

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW - ms);

async function main() {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(dbPath + suffix, { force: true });
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  process.env.DATABASE_URL = `file:${dbPath}`;
  console.log(`Migrating ${dbPath}…`);
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
  });

  // Imported after DATABASE_URL is set: db.ts opens the file at import time.
  const { prisma } = await import("../../src/lib/db");

  // ---------- sign-in: one demo account with a known session, no "change password" banner ----------
  await prisma.user.deleteMany({});
  const user = await prisma.user.create({
    data: { email: "alex@acme.dev", name: "Alex Rivera", mustChangePassword: false },
  });
  await prisma.session.create({
    data: {
      userId: user.id,
      tokenHash: createHash("sha256").update(DEMO_SESSION_TOKEN).digest("hex"),
      method: "passkey",
      expiresAt: new Date(NOW + 365 * DAY),
    },
  });

  // ---------- connections ----------
  const fakeClaudeLogin = (label: string) =>
    JSON.stringify({
      claudeAiOauth: {
        accessToken: `demo-${label}`,
        refreshToken: `demo-${label}`,
        expiresAt: NOW + 6 * HOUR,
        scopes: ["user:inference"],
        subscriptionType: "max",
      },
    });
  const providers = {
    maxPersonal: await prisma.aIProvider.create({
      data: { name: "Claude Max (personal)", type: "cli", isDefault: true, credentialsJson: fakeClaudeLogin("a"), configDir: "/home/app/.claude-personal", createdAt: ago(60 * DAY) },
    }),
    maxTeam: await prisma.aIProvider.create({
      data: { name: "Claude Max (team seat)", type: "cli", maxUsagePercent: 85, credentialsJson: fakeClaudeLogin("b"), configDir: "/home/app/.claude-team", createdAt: ago(55 * DAY) },
    }),
    codex: await prisma.aIProvider.create({
      data: { name: "ChatGPT Pro (Codex)", type: "codex-cli", model: "gpt-5.5", credentialsJson: JSON.stringify({ tokens: { access_token: "demo" } }), createdAt: ago(40 * DAY) },
    }),
    anthropic: await prisma.aIProvider.create({
      data: { name: "Anthropic API", type: "api", apiKey: "sk-ant-demo-000000000000", model: "claude-sonnet-5-5", createdAt: ago(30 * DAY) },
    }),
    openai: await prisma.aIProvider.create({
      data: { name: "OpenAI API", type: "openai", apiKey: "sk-demo-000000000000", model: "gpt-5.5", isEnabled: false, createdAt: ago(20 * DAY) },
    }),
  };

  // Cached health-check result, so the connections page shows signed-in accounts and their
  // plan usage without running a real check against the placeholder logins.
  const nextMondayish = new Date(NOW + 2 * DAY + 5 * HOUR).toISOString();
  const healthResults = [
    { p: providers.maxPersonal, usage: { five_hour: { utilization: 34, resets_at: new Date(NOW + 2 * HOUR + 12 * MIN).toISOString() }, seven_day: { utilization: 61, resets_at: nextMondayish } } },
    { p: providers.maxTeam, usage: { five_hour: { utilization: 12, resets_at: new Date(NOW + 4 * HOUR).toISOString() }, seven_day: { utilization: 47, resets_at: new Date(NOW + 5 * DAY).toISOString() } } },
    { p: providers.codex, usage: { five_hour: { utilization: 8, resets_at: new Date(NOW + 3 * HOUR).toISOString() }, seven_day: { utilization: 22, resets_at: new Date(NOW + 4 * DAY).toISOString() } } },
    { p: providers.anthropic },
  ].map(({ p, usage }) => ({
    providerId: p.id,
    providerName: p.name,
    providerType: p.type,
    isEnabled: true,
    authStatus: "ok",
    livenessStatus: "ok",
    healthy: true,
    checkedAt: ago(4 * MIN).toISOString(),
    ...(usage ? { usageMetrics: usage } : {}),
  }));

  // ---------- teams ----------
  const featureTeam = await prisma.team.create({
    data: {
      name: "Feature squad",
      isDefault: true,
      members: {
        create: [
          { name: "Planner", position: 0, requiresApproval: true, instructions: "Read the codebase and write a step-by-step implementation plan. List the files you'll touch and the risks. Don't write code." },
          { name: "Coder", position: 1, instructions: "Implement the approved plan. Keep changes focused and follow the repo's conventions in CLAUDE.md." },
          { name: "Tester", position: 2, instructions: "Add or update tests for the change, run the full suite and fix anything that fails." },
          { name: "Reviewer", position: 3, instructions: "Review the diff like a senior engineer: correctness, edge cases, naming. Fix real problems, then summarise for the PR." },
        ],
      },
    },
    include: { members: { orderBy: { position: "asc" } } },
  });
  const bugTeam = await prisma.team.create({
    data: {
      name: "Bug hunters",
      members: {
        create: [
          { name: "Investigator", position: 0, instructions: "Reproduce the bug with a failing test and find the root cause. Report what you found." },
          { name: "Fixer", position: 1, instructions: "Fix the root cause so the failing test passes. No unrelated refactors." },
          { name: "Verifier", position: 2, instructions: "Run the whole suite, try nearby edge cases, and confirm the fix holds." },
        ],
      },
    },
    include: { members: { orderBy: { position: "asc" } } },
  });
  await prisma.team.create({
    data: {
      name: "Docs crew",
      members: {
        create: [
          { name: "Writer", position: 0, instructions: "Write or update the docs for the change, with runnable examples." },
          { name: "Editor", position: 1, instructions: "Tighten the prose, check every example actually runs, fix broken links." },
        ],
      },
    },
  });

  // ---------- repos ----------
  const REPOS = {
    web: { alias: "web-app", url: "git@github.com:acme/web-app.git", branch: "main" },
    api: { alias: "api", url: "git@github.com:acme/api.git", branch: "main" },
    mobile: { alias: "mobile", url: "git@github.com:acme/mobile.git", branch: "develop" },
    docs: { alias: "docs", url: "git@github.com:acme/docs.git", branch: "main" },
    infra: { alias: "infra", url: "git@github.com:acme/infra.git", branch: "main" },
  };
  type RepoKey = keyof typeof REPOS;

  const settings: Record<string, string> = {
    auth_required: "false",
    task_board_enabled: "true",
    smart_provider_picker: "true",
    concurrent_tasks: "3",
    git_user_name: "Acme Bot",
    git_user_email: "bot@acme.dev",
    app_host: "tasks.acme.dev",
    health_check_enabled: "true",
    health_check_interval_minutes: "60",
    health_check_results: JSON.stringify({ results: healthResults, checkedAt: ago(4 * MIN).toISOString() }),
    saved_repo_presets: JSON.stringify([
      { ...REPOS.web, defaultTeamId: featureTeam.id, defaultGitMode: "pr", maxConcurrentTasks: 2 },
      { ...REPOS.api, defaultGitMode: "pr", defaultPriority: "high" },
      { ...REPOS.mobile, defaultGitMode: "branch" },
      { ...REPOS.docs, defaultGitMode: "main" },
      { ...REPOS.infra, defaultGitMode: "pr", maxConcurrentTasks: 1 },
    ]),
  };
  for (const [key, value] of Object.entries(settings)) {
    await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }

  // ---------- tasks ----------
  interface TaskSeed {
    title: string;
    description: string;
    repos: RepoKey[];
    status: string;
    reviewStatus?: string | null;
    priority?: string;
    labels?: string[];
    providerId?: string | null;
    model?: string | null;
    teamId?: string | null;
    teamProgress?: unknown;
    createdAgo: number;
    updatedAgo?: number;
    inputTokens?: number;
    outputTokens?: number;
    estimatedCost?: number | null;
    pr?: number;
    ciStatus?: string;
    scheduledIn?: number;
    position?: number;
    useSmartProvider?: boolean;
    logs?: { member?: string; level?: string; content: string; agoMs: number }[];
  }

  async function createTask(t: TaskSeed) {
    const repoUrl = REPOS[t.repos[0]].url.replace("git@github.com:", "https://github.com/").replace(/\.git$/, "");
    const slug = t.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
    const task = await prisma.task.create({
      data: {
        title: t.title,
        description: t.description,
        status: t.status,
        reviewStatus: t.reviewStatus ?? null,
        priority: t.priority ?? "normal",
        labels: t.labels ? JSON.stringify(t.labels) : null,
        aiProviderId: t.providerId === undefined ? providers.maxPersonal.id : t.providerId,
        useSmartProvider: t.useSmartProvider ?? false,
        model: t.model ?? null,
        teamId: t.teamId ?? null,
        teamProgress: t.teamProgress ? JSON.stringify(t.teamProgress) : null,
        createPR: t.pr !== undefined,
        prUrl: t.pr ? `${repoUrl}/pull/${t.pr}` : null,
        prNumber: t.pr ?? null,
        ciStatus: t.ciStatus ?? null,
        mergeableState: t.pr ? "mergeable" : null,
        branchName: t.status === "pending" ? null : `task/${slug}`,
        commitSha: ["completed", "no_changes"].includes(t.status) ? randomBytes(20).toString("hex") : null,
        inputTokens: t.inputTokens ?? null,
        outputTokens: t.outputTokens ?? null,
        estimatedCost: t.estimatedCost ?? null,
        scheduledFor: t.scheduledIn ? new Date(NOW + t.scheduledIn) : null,
        position: t.position ?? 0,
        createdAt: ago(t.createdAgo),
        updatedAt: ago(t.updatedAgo ?? Math.max(0, t.createdAgo - 20 * MIN)),
        repos: { create: t.repos.map((r) => ({ alias: REPOS[r].alias, url: REPOS[r].url, branch: REPOS[r].branch })) },
        logs: t.logs ? { create: t.logs.map((l) => ({ content: l.content, level: l.level ?? "info", member: l.member ?? null, createdAt: ago(l.agoMs) })) } : undefined,
      },
    });
    return task;
  }

  const stage = (m: { id: string; name: string; requiresApproval: boolean }, status: string, startedAgo: number | null, finishedAgo: number | null, extra: Record<string, unknown> = {}) => ({
    memberId: m.id,
    name: m.name,
    status,
    requiresApproval: m.requiresApproval,
    startedAt: startedAgo === null ? null : ago(startedAgo).toISOString(),
    finishedAt: finishedAgo === null ? null : ago(finishedAgo).toISOString(),
    note: null,
    ...extra,
  });
  const [planner, coder, tester, reviewer] = featureTeam.members;

  // The hero task: a team run in progress, Planner approved, Coder working.
  const plan = [
    "## Plan: saved searches on the orders page",
    "",
    "1. **Schema** — add `SavedSearch` (userId, name, query JSON) with a migration.",
    "2. **API** — `GET/POST/DELETE /api/saved-searches`, scoped to the signed-in user.",
    "3. **UI** — a \"Save search\" button next to the filters and a dropdown of saved searches.",
    "4. **Tests** — route tests for ownership checks; a component test for the dropdown.",
    "",
    "Risk: the filter state lives in the URL, so saved searches store the query string as-is.",
  ].join("\n");
  const heroTask = await createTask({
    title: "Add saved searches to the orders page",
    description: "Users keep re-entering the same filters on /orders. Let them save a filter set with a name and pick it from a dropdown.",
    repos: ["web", "api"],
    status: "running",
    priority: "high",
    labels: ["feature", "orders"],
    teamId: featureTeam.id,
    createdAgo: 52 * MIN,
    updatedAgo: 1 * MIN,
    inputTokens: 184_220,
    outputTokens: 21_480,
    teamProgress: {
      teamId: featureTeam.id,
      teamName: featureTeam.name,
      startedAt: ago(48 * MIN).toISOString(),
      finishedAt: null,
      stages: [
        stage(planner, "completed", 48 * MIN, 41 * MIN, { output: plan, approval: "approved", approvedAt: ago(30 * MIN).toISOString(), approvalNote: "Looks good. Keep the dropdown keyboard-accessible.", inputTokens: 61_200, outputTokens: 4_100 }),
        stage(coder, "running", 29 * MIN, null),
        stage(tester, "pending", null, null),
        stage(reviewer, "pending", null, null),
      ],
    },
    logs: [
      { agoMs: 48 * MIN, content: "Cloned acme/web-app (main) and acme/api (main) into the workspace" },
      { agoMs: 48 * MIN, content: "Running team \"Feature squad\": Planner → Coder → Tester → Reviewer" },
      { agoMs: 47 * MIN, member: "Planner", content: "Reading src/app/orders/page.tsx and the filter hooks" },
      { agoMs: 45 * MIN, member: "Planner", content: "Tool: Grep \"useOrderFilters\" — 6 matches" },
      { agoMs: 42 * MIN, member: "Planner", content: "Plan written: 4 steps, touches 2 repos" },
      { agoMs: 41 * MIN, member: "Planner", level: "system", content: "Waiting for approval before Coder runs" },
      { agoMs: 30 * MIN, level: "system", content: "Plan approved by Alex Rivera: \"Looks good. Keep the dropdown keyboard-accessible.\"" },
      { agoMs: 29 * MIN, member: "Coder", content: "Adding SavedSearch model to prisma/schema.prisma" },
      { agoMs: 26 * MIN, member: "Coder", content: "Tool: Bash npx prisma migrate dev --name saved_searches" },
      { agoMs: 21 * MIN, member: "Coder", content: "Created api/src/routes/saved-searches.ts (GET, POST, DELETE)" },
      { agoMs: 14 * MIN, member: "Coder", content: "Created web-app/src/components/SavedSearchMenu.tsx" },
      { agoMs: 6 * MIN, member: "Coder", content: "Wiring the menu into OrdersFilters with arrow-key navigation" },
      { agoMs: 2 * MIN, member: "Coder", content: "Tool: Bash npm run typecheck — no errors" },
      { agoMs: 1 * MIN, member: "Coder", content: "Updating the orders page snapshot" },
    ],
  });

  await createTask({
    title: "Rate-limit the public search endpoint",
    description: "Add a per-IP token bucket to GET /v1/search (60 req/min) and return 429 with Retry-After.",
    repos: ["api"],
    status: "awaiting_approval",
    priority: "urgent",
    labels: ["security"],
    teamId: featureTeam.id,
    createdAgo: 3 * HOUR,
    updatedAgo: 2 * HOUR,
    teamProgress: {
      teamId: featureTeam.id,
      teamName: featureTeam.name,
      startedAt: ago(2.5 * HOUR).toISOString(),
      finishedAt: null,
      stages: [
        stage(planner, "awaiting_approval", 2.5 * HOUR, 2 * HOUR, { output: "## Plan\n\n1. Add a Redis-backed token bucket middleware.\n2. Apply it to `/v1/search` only.\n3. Return 429 + `Retry-After`.\n4. Tests for the limit and the reset.", inputTokens: 48_000, outputTokens: 2_900 }),
        stage(coder, "pending", null, null),
        stage(tester, "pending", null, null),
        stage(reviewer, "pending", null, null),
      ],
    },
  });

  await createTask({
    title: "Fix flaky checkout e2e test",
    description: "checkout.spec.ts fails ~1 in 10 runs on CI with a timeout waiting for the payment iframe.",
    repos: ["web"],
    status: "running",
    labels: ["bug", "ci"],
    providerId: providers.codex.id,
    model: "gpt-5.5",
    createdAgo: 18 * MIN,
    updatedAgo: 1 * MIN,
  });

  // To Do
  await createTask({ title: "Migrate settings page to the new form components", description: "Replace the hand-rolled inputs in /settings with the shared Form primitives.", repos: ["web"], status: "pending", labels: ["refactor"], useSmartProvider: true, providerId: null, createdAgo: 2 * HOUR, position: 0 });
  await createTask({ title: "Add dark-mode screenshots to the docs", description: "Every docs page with a screenshot should have a dark-mode variant.", repos: ["docs"], status: "pending", priority: "low", labels: ["docs"], teamId: (await prisma.team.findFirst({ where: { name: "Docs crew" } }))!.id, createdAgo: 5 * HOUR, position: 1 });
  await createTask({ title: "Bump React Native to 0.82", description: "Upgrade, follow the upgrade helper, fix the iOS build.", repos: ["mobile"], status: "pending", labels: ["deps"], providerId: providers.maxTeam.id, createdAgo: 9 * HOUR, position: 2, scheduledIn: 9 * HOUR });
  await createTask({ title: "Terraform: tag every S3 bucket with an owner", description: "Add an owner tag to all aws_s3_bucket resources and a policy check in CI.", repos: ["infra"], status: "pending", priority: "high", labels: ["infra"], createdAgo: 26 * HOUR, position: 3 });

  // In Review
  await createTask({
    title: "Export orders as CSV",
    description: "Add an Export button to /orders that downloads the current filtered view as CSV.",
    repos: ["web", "api"],
    status: "completed",
    reviewStatus: "in_review",
    labels: ["feature", "orders"],
    teamId: featureTeam.id,
    createdAgo: 7 * HOUR,
    updatedAgo: 3 * HOUR,
    inputTokens: 412_000,
    outputTokens: 38_300,
    pr: 1284,
    ciStatus: "passing",
    teamProgress: {
      teamId: featureTeam.id,
      teamName: featureTeam.name,
      startedAt: ago(6.8 * HOUR).toISOString(),
      finishedAt: ago(3 * HOUR).toISOString(),
      stages: [
        stage(planner, "completed", 6.8 * HOUR, 6.5 * HOUR, { approval: "approved", approvedAt: ago(6 * HOUR).toISOString() }),
        stage(coder, "completed", 6 * HOUR, 4.6 * HOUR),
        stage(tester, "completed", 4.6 * HOUR, 3.7 * HOUR),
        stage(reviewer, "completed", 3.7 * HOUR, 3 * HOUR),
      ],
    },
  });
  await createTask({ title: "Null pointer in invoice PDF when VAT id is missing", description: "Sentry: TypeError in renderInvoice when customer.vatId is undefined.", repos: ["api"], status: "completed", reviewStatus: "in_review", priority: "high", labels: ["bug"], teamId: bugTeam.id, createdAgo: 11 * HOUR, updatedAgo: 9 * HOUR, inputTokens: 156_000, outputTokens: 9_800, pr: 1281, ciStatus: "pending" });
  await createTask({ title: "Write the v2 webhooks guide", description: "Document signature verification and retries for the v2 webhooks.", repos: ["docs"], status: "completed", reviewStatus: "in_review", labels: ["docs"], providerId: providers.anthropic.id, model: "claude-sonnet-5-5", createdAgo: 20 * HOUR, updatedAgo: 18 * HOUR, inputTokens: 88_000, outputTokens: 14_200, estimatedCost: 0.48, pr: 212, ciStatus: "passing" });

  // Recurring template
  await prisma.task.create({
    data: {
      title: "Weekly dependency updates",
      description: "Update minor/patch dependencies, run the tests, open a PR with a changelog summary.",
      isRecurringTemplate: true,
      cronExpression: "0 9 * * 1",
      status: "pending",
      createPR: true,
      aiProviderId: providers.maxTeam.id,
      runCount: 6,
      createdAt: ago(45 * DAY),
      lastScheduledAt: ago(3 * DAY),
      repos: { create: [{ alias: "web-app", url: REPOS.web.url, branch: "main" }] },
    },
  });

  // Done: a month of history, so /analytics and the Done column have something to show.
  const doneTitles = [
    "Add pagination to the customers API", "Cache product images at the edge", "Fix timezone bug in the scheduling widget",
    "Remove the legacy v1 auth middleware", "Add OpenAPI docs for /v1/orders", "Speed up the CI test job with sharding",
    "Accessibility pass on the checkout form", "Add retry with backoff to the email sender", "Convert utils/date.js to TypeScript",
    "Upgrade Next.js and fix the deprecations", "Add an audit log for admin actions", "Dedupe Sentry alerts for 404s",
    "Add a health endpoint for the load balancer", "Fix N+1 query on the dashboard", "Write onboarding docs for new engineers",
    "Translate the checkout flow to German", "Add feature flag for the new pricing page", "Lazy-load the analytics charts",
    "Fix push notifications on Android 15", "Add unit tests for the discount engine", "Rotate the staging database credentials",
    "Clean up unused CSS from the marketing site", "Add an index on orders.created_at", "Make the sidebar collapsible",
  ];
  const doneProviders = [providers.maxPersonal, providers.maxPersonal, providers.maxTeam, providers.codex, providers.anthropic];
  for (let i = 0; i < 64; i++) {
    const p = pick(doneProviders);
    const input = between(40_000, 520_000);
    const output = between(3_000, 45_000);
    const created = between(1, 30) * DAY + between(0, 20) * HOUR;
    const isTeam = rand() < 0.3;
    await createTask({
      title: doneTitles[i % doneTitles.length],
      description: "Done.",
      repos: [pick(["web", "api", "mobile", "docs", "infra"] as RepoKey[])],
      status: rand() < 0.08 ? "failed" : rand() < 0.1 ? "no_changes" : "completed",
      reviewStatus: "done",
      providerId: p.id,
      model: p.type === "api" ? "claude-sonnet-5-5" : null,
      teamId: isTeam ? pick([featureTeam.id, bugTeam.id]) : null,
      createdAgo: created,
      updatedAgo: created - between(10, 90) * MIN,
      inputTokens: input,
      outputTokens: output,
      // Subscription CLIs aren't billed per token, so only the metered API rows carry a cost.
      estimatedCost: p.type === "api" ? +(input * 3e-6 + output * 15e-6).toFixed(2) : null,
      pr: rand() < 0.7 ? 1100 + i : undefined,
      ciStatus: "passing",
    });
  }

  // ---------- API keys + LLM gateway traffic ----------
  const keys = [
    { name: "Cursor (Alex)", aiProviderId: providers.maxPersonal.id, weight: 5, format: "anthropic" },
    { name: "Support chatbot", useSmartProvider: true, weight: 4, format: "openai" },
    { name: "CI PR summariser", aiProviderId: providers.maxTeam.id, weight: 2, format: "anthropic" },
    { name: "Zed editor", aiProviderId: providers.codex.id, weight: 2, format: "openai" },
    { name: "Data notebooks", aiProviderId: providers.anthropic.id, weight: 1, format: "anthropic" },
  ];
  const keyRows = [];
  for (const k of keys) {
    const row = await prisma.apiKey.create({
      data: {
        name: k.name,
        keyPrefix: "tm_live_" + randomBytes(3).toString("hex"),
        keyHash: createHash("sha256").update(randomBytes(32)).digest("hex"),
        aiProviderId: k.aiProviderId ?? null,
        useSmartProvider: k.useSmartProvider ?? false,
        lastUsedAt: ago(between(1, 40) * MIN),
        createdAt: ago(between(20, 50) * DAY),
      },
    });
    keyRows.push({ ...k, row });
  }
  const weighted = keyRows.flatMap((k) => Array(k.weight).fill(k));
  const smartPool = [providers.maxPersonal, providers.maxTeam, providers.codex];
  const usageRows = [];
  for (let t = NOW - 30 * DAY; t < NOW; ) {
    const hour = new Date(t).getHours();
    // Busy in working hours, quiet at night, quieter at weekends.
    const weekend = [0, 6].includes(new Date(t).getDay());
    const rate = (hour >= 8 && hour <= 19 ? 40 : 6) * (weekend ? 0.3 : 1) * (t > NOW - 7 * DAY ? 1.4 : 1);
    t += (HOUR / rate) * (0.4 + rand() * 1.2);
    const k = pick(weighted);
    const p = k.row.useSmartProvider ? pick(smartPool) : Object.values(providers).find((x) => x.id === k.row.aiProviderId)!;
    const model = p.type === "codex-cli" ? "gpt-5.5" : pick(["claude-sonnet-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"]);
    const input = between(800, 24_000);
    const output = between(120, 3_200);
    const cacheRead = p.type === "codex-cli" ? 0 : Math.round(input * rand() * 0.8);
    const failed = rand() < 0.004;
    usageRows.push({
      apiKeyId: k.row.id,
      apiKeyName: k.row.name,
      format: k.format,
      providerId: p.id,
      providerName: p.name,
      providerType: p.type,
      model,
      inputTokens: failed ? 0 : input,
      outputTokens: failed ? 0 : output,
      cacheReadTokens: failed ? 0 : cacheRead,
      cacheCreationTokens: 0,
      estimatedCost: p.type === "api" && !failed ? +(input * 3e-6 + output * 15e-6).toFixed(4) : null,
      errorType: failed ? pick(["rate_limit", "timeout", "invalid_request"]) : null,
      durationMs: between(700, 14_000),
      createdAt: new Date(t),
    });
  }
  for (let i = 0; i < usageRows.length; i += 500) {
    await prisma.llmGatewayUsage.createMany({ data: usageRows.slice(i, i + 500) });
  }

  console.log(`Seeded ${dbPath}`);
  console.log(`  hero task: /tasks/${heroTask.id}`);
  console.log(`  gateway requests: ${usageRows.length}`);
  fs.writeFileSync(path.join(path.dirname(dbPath), "demo.json"), JSON.stringify({ heroTaskId: heroTask.id }, null, 2));
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
