# Claude Task Manager

A self-hosted task queue that runs autonomous coding agents against your Git repositories. You describe a task, and a background worker clones the repo, runs an AI agent (Claude Code, Codex, or an API model), commits the result, pushes a branch and can open a pull request. You then review the logs and the diff from a kanban board.

## Features

- **Coding agents on your repos.** The worker clones your repos, runs the agent, commits, pushes a branch and can open a PR.
- **Use your existing subscription.** Runs the `claude` or `codex` CLI with your own login, so no API key is needed. Anthropic and OpenAI API keys work too.
- **Kanban board and live logs.** Watch agent output stream in real time, message a running agent, approve the result or request changes.
- **Scheduling.** Run a task once at a set time, or on a cron schedule (e.g. `0 9 * * 1` for every Monday at 9am).
- **Teams.** Chain several agents (e.g. Planner → Coder → Reviewer), with optional approval gates between them.
- **Triggers from anywhere.** Webhooks, a REST API (`/api/v1`), an MCP server for Claude Code/Cursor/VS Code, Slack and inbound email.
- **Per-repo defaults.** Set the branch, git mode, model, team and concurrency limit for each saved repo.
- **Built-in docs.** Open `/docs` in the app for the API, MCP and LLM-gateway reference.

---

## Quick start (Docker, recommended)

This is the easiest way to run it. You only need **Docker** with the Compose plugin. One command downloads the compose file and starts the prebuilt image:

```bash
curl -fsSL https://orangeballdev.github.io/ai-task-manager/install.sh | sh
```

It installs into `./ai-task-manager`, falls back to building from source if the image can't be pulled, and updates in place when you run it again. Or build from a clone:

```bash
git clone git@github.com:orangeballdev/ai-task-manager.git
cd ai-task-manager
docker compose up --build -d
```

The first build takes a few minutes. Compose runs the database migrations, then starts three containers:

| Container | What it does |
|-----------|--------------|
| `app` | Web UI and API on http://localhost:3000 |
| `worker` | Picks up tasks and runs the agents |
| `integrations` | Slack bot and email (idles harmlessly if you don't set them up) |

The database, cloned workspaces and the Claude login are kept in Docker volumes, so they survive restarts and rebuilds.

Then open **http://localhost:3000** and continue with [Getting started](#getting-started) below.

### Private repos over SSH

The `worker` container mounts `~/.ssh` read-only, so it clones and pushes with your SSH keys. Make sure your key works for GitHub on the host first (`ssh -T git@github.com`). If you use HTTPS remotes instead, add a Git personal access token in **Settings → Git**.

### Useful Docker commands

```bash
docker compose logs -f worker      # follow the worker's output
docker compose up --build -d       # rebuild after pulling new code
docker compose down                # stop (data is kept)
docker compose down -v             # stop AND delete all data
```

---

## Getting started

Once the app is running:

1. **Connect an AI provider.** Go to **Settings → AI** and add a connection:
   - **Claude CLI (subscription)**: click **Sign in with Claude**, open the link it shows, log in, then paste the code back. Works the same in Docker and locally.
   - **Codex CLI (ChatGPT)**: run `codex login` on any machine, then paste the contents of `~/.codex/auth.json` into the form.
   - **Anthropic API** / **OpenAI**: paste an API key (a custom Base URL is optional).
2. **Set up Git.** In **Settings → Git**, set the commit name and email. Add a GitHub token if you want the agent to open pull requests or you use HTTPS remotes. SSH keys handle cloning and pushing on their own.
3. **Run the Setup Guide** (optional). Open http://localhost:3000/setup (also linked from the About dialog). It checks each step and can queue a small test task for you.
4. **Save a repo (optional but handy).** On **Repositories**, add your repo URL and its default branch. It then shows up as a one-click choice on the new-task form, and you can set per-repo defaults there.
5. **Create your first task.** Click **New Task**, pick the repo, describe what you want done, and choose what happens afterwards (new branch, open a PR, push to a branch…). The task appears on the board, and once the worker picks it up (within ~5 seconds) you can open it to watch the live log.
6. **Review.** When the agent finishes, the task moves to **In Review**. Look at the diff or PR, then **Approve** it or **Request changes** to send the agent back with feedback.

Tip: put repo-specific guidance for the agent in a `CLAUDE.md` at the root of your repo. The agent reads it automatically on every run.

### Email

Email is off until you set it up in **Settings → Notifications → Email delivery**. It's used for task notifications, provider alerts and replies to tasks created by email. Choose one:

- **SMTP:** host, port, security (STARTTLS or TLS/SSL), username and password. Works with any mail service, e.g. Gmail or Fastmail with an app password, Resend, Postmark or Mailgun.
- **Amazon SES:** credentials either come from the server environment (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`) or are entered on the page.

Set a sender address your service allows, then use **Send test** to check it works. Passwords and secret keys are stored in the app's database and never shown again in the UI.

### Signing in

Out of the box the web UI has **no login**. That's fine on your own machine or a private network. **Before you expose it to the internet**, turn sign-in on:

1. Create your own account from a shell on the host:
   ```bash
   # Docker
   docker compose exec app npx tsx scripts/reset-password.ts you@example.com 'a-strong-password'
   # Local
   npx tsx scripts/reset-password.ts you@example.com 'a-strong-password'
   ```
2. Sign in at `/login` with it, set a new password when prompted, then go to **Settings → Security** and switch on **Require sign-in**.

The same command resets the password if you ever get locked out. You can also add a passkey in **Settings → Account**. Sign-ups are off by default, and every account can see and change everything (it's a single-team tool).

Behind a reverse proxy, forward `Host`/`X-Forwarded-Host`, `X-Forwarded-Proto` and `X-Forwarded-For`. Passkeys need HTTPS (or `http://localhost`).

---

## Running locally without Docker (for development)

### Prerequisites

- **Node.js 20+** and npm
- **Git**
- At least one agent CLI on your `PATH` if you want subscription mode:
  - [Claude Code](https://docs.claude.com/en/docs/claude-code): `npm install -g @anthropic-ai/claude-code`
  - [Codex CLI](https://developers.openai.com/codex/cli/): `npm install -g @openai/codex`
- Optional: the [GitHub CLI](https://cli.github.com/) (`gh`), if you want agents to be able to use it

### Setup

```bash
git clone git@github.com:orangeballdev/ai-task-manager.git
cd ai-task-manager
npm install                # also generates the Prisma client
cp .env.example .env       # the defaults work as-is
npm run db:migrate         # creates prisma/dev.db
npm run dev
```

`npm run dev` starts the web app (port 3000), the worker and the integrations process together. **The worker must be running for tasks to execute**, so don't start `next dev` on its own.

Open http://localhost:3000 and follow [Getting started](#getting-started).

### Environment variables

All optional. Set them in `.env` (local) or in a `.env` next to `docker-compose.yml` (Docker).

| Variable | Local default | Description |
|----------|---------------|-------------|
| `DATABASE_URL` | `file:./prisma/dev.db` | SQLite database file |
| `WORKSPACES_PATH` | `/workspaces` (`.env.example` uses `/tmp/claude-task-manager-workspaces`) | Where repos are cloned for each task |
| `ATTACHMENTS_PATH` | `./data/attachments` | Images attached to tasks. The app and worker must both be able to read it |
| `CLAUDE_PATH` | (unset) | Directory containing the `claude` binary, if it's not on `PATH` |
| `CODEX_PATH` | (unset) | Directory containing the `codex` binary, if it's not on `PATH` |
| `GH_PATH` | (unset) | Path to the `gh` binary, if it's not in a standard location |
| `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` | (unset) | Slack bot tokens. Usually set in **Settings → Integrations** instead |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` | (unset) | Only for Amazon SES email with credentials from the environment (see [Email](#email)) |

Docker Compose already sets the paths to its volumes (`/data/dev.db`, `/workspaces`, `/data/attachments`), so you normally don't need a `.env` there.

### Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Web app + worker + integrations (development) |
| `npm run build` / `npm start` | Production build / start web app + worker |
| `npm run worker` | Worker only |
| `npm run integrations` | Slack/email integrations only |
| `npm test` | Unit tests |
| `npm run lint` | ESLint |
| `npx tsc --noEmit` | Type check |
| `npm run db:migrate` | Apply/create Prisma migrations (after schema changes) |
| `npm run db:generate` | Regenerate the Prisma client |

---

## How it works

Two processes share one SQLite database:

```
┌─────────────────────────────────┐     ┌──────────────────────────────────┐
│         Next.js app             │     │             Worker               │
│  (dashboard + REST/MCP API)     │     │  (polls the DB every 5s)         │
│                                 │     │                                  │
│  • Create / review tasks        │     │  • Clones repos                  │
│  • Live logs (SSE)              │◄───►│  • Runs the AI agent             │
│  • Webhooks, API keys, MCP      │ DB  │  • Commits, pushes, opens PRs    │
│  • Settings & setup guide       │     │  • Cron schedules & retries      │
└─────────────────────────────────┘     └──────────────────────────────────┘
```

**Task lifecycle:** `pending` → `running` → `completed` | `failed` | `paused` (rate-limited, retries automatically) | `awaiting_approval` (a team stage is waiting on you).

If a subscription hits its usage limit, the task pauses and resumes later, or moves to another enabled provider if you have one. Retries reuse the existing workspace, so the agent continues where it left off.

For a deeper tour of the codebase, see [CLAUDE.md](CLAUDE.md).

---

## Other deployment options

- **Kubernetes:** a Helm chart is in [charts/ai-task-manager](charts/ai-task-manager/README.md).
- **Auto-deploy on push to `main`** (single self-hosted box): `scripts/deploy-on-main-update.sh` fetches `origin/main` and, if it moved, fast-forwards and runs `docker compose up --build -d`. Run it from a dedicated deploy clone with a systemd timer or cron job every few minutes.

---

## Troubleshooting

- **Tasks stay in "pending".** The worker isn't running. Locally, use `npm run dev` (not `next dev`). In Docker, check `docker compose logs worker`.
- **"Claude CLI not found" / "Codex CLI not found".** The binary isn't on the worker's `PATH`. Set `CLAUDE_PATH` / `CODEX_PATH`. The Docker image already includes both.
- **Claude login expired.** **Settings → AI** shows a **Sign in** button on the affected connection. The health indicator in the nav shows the status of each provider.
- **Clone or push fails with "Permission denied (publickey)".** Your SSH key isn't available to the worker, or doesn't have access to the repo. Check `ssh -T git@github.com` on the host.
- **The PR wasn't created.** Add a GitHub token in **Settings → Git**. The task's log says why.

---

## Contributing

1. Create a feature branch.
2. Follow [Running locally](#running-locally-without-docker-for-development).
3. Run `npm run lint`, `npx tsc --noEmit` and `npm test` before opening a PR.
4. Open a pull request describing what changed and why.

## License

MIT
