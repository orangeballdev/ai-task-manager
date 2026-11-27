---
title: Getting started
description: Install AI Task Manager with Docker, connect a subscription, and run your first task.
---

# Getting started

AI Task Manager is a self-hosted task queue for coding agents. You describe a task, and a background worker clones the repo, runs an agent (Claude Code, Codex, or an API model), commits the result, pushes a branch and can open a pull request. You review the logs and the diff on a kanban board.

It runs on the subscriptions you already have. Connect your Claude Pro/Max or ChatGPT login and the agents use it, with no API key needed. The same logins can also serve an [OpenAI- and Anthropic-compatible API](/docs/api-proxy) for your other tools.

![The task board](/screenshots/board.png)

## Install with Docker

You need Docker with the Compose plugin, and Docker running. Then:

```bash
curl -fsSL https://orangeballdev.github.io/ai-task-manager/install.sh | sh
```

The installer creates an `ai-task-manager` folder, downloads a [docker-compose.yml](/docker-compose.yml) into it, pulls the prebuilt image and starts the app on http://localhost:3000. If the image can't be pulled, it clones the repo and builds it instead. Run it again to update; your data is kept. For another port, put the variable on the `sh` side: `curl -fsSL …/install.sh | AI_TASK_MANAGER_PORT=8080 sh`. [Read the script](/install.sh) before running it if you prefer.

Or do the same by hand:

```bash
mkdir ai-task-manager && cd ai-task-manager
curl -fsSLO https://orangeballdev.github.io/ai-task-manager/docker-compose.yml
docker compose up -d
```

Either way, Compose runs the database migrations and starts three containers:

| Container | What it does |
| --- | --- |
| `app` | Web UI and API on http://localhost:3000 |
| `worker` | Picks up tasks and runs the agents |
| `integrations` | Slack bot and inbound email (idles if you don't set them up) |

The database, the cloned workspaces and the CLI logins live in Docker volumes, so they survive restarts and updates. `docker compose logs -f worker` follows the agents' output, and `docker compose down` stops everything (add `-v` to delete the data too).

The `worker` container mounts `~/.ssh` read-only, so it clones and pushes with your SSH keys. Check that `ssh -T git@github.com` works on the host first. If you use HTTPS remotes, add a Git token in **Settings → Git**.

The prebuilt image runs natively on x86-64 and ARM (including Apple Silicon). To build it from source instead:

```bash
git clone https://github.com/orangeballdev/ai-task-manager.git
cd ai-task-manager
docker compose up --build -d
```

## First steps

1. **Connect an AI provider.** Open **Settings → AI providers** and add a connection. For a Claude subscription, click **Sign in with Claude**, open the link, log in and paste the code back. For ChatGPT, paste your Codex `auth.json`. API keys work too. See [Connections](/docs/connections).
2. **Set up Git.** In **Settings → Git**, set the commit name and email. Add a GitHub token if you want pull requests opened for you.
3. **Save a repo.** On **Repositories**, add the repo URL and its default branch. You can also give it defaults: git mode, model, team and a concurrency limit.
4. **Create a task.** Click **New Task**, pick the repo, describe the work, and choose what happens afterwards (new branch, pull request, push to a branch). The worker picks it up within about five seconds. Open the task to watch the live log, or send the agent a message while it works.
5. **Review.** Finished tasks move to **In Review**. Look at the diff or the PR, then **Approve** it, or **Request changes** to send the agent back with your feedback.

> Put repo-specific guidance for the agent in a `CLAUDE.md` at the root of the repo. The agent reads it on every run.

## Turn on sign-in before exposing it

Out of the box the web UI has no login. That's fine on your own machine or a private network. Before you put it on the internet:

```bash
docker compose exec app npx tsx scripts/reset-password.ts you@example.com 'a-strong-password'
```

Sign in at `/login`, then switch on **Settings → Security → Require sign-in**. You can add a passkey in **Settings → Account**. Behind a reverse proxy, forward `Host`, `X-Forwarded-Proto` and `X-Forwarded-For`. Passkeys need HTTPS.

## Running without Docker

You need Node.js 20+, Git, and the `claude` and/or `codex` CLI on your `PATH`.

```bash
git clone https://github.com/orangeballdev/ai-task-manager.git
cd ai-task-manager
npm install
cp .env.example .env
npm run db:migrate
npm run dev        # web app, worker and integrations together
```

The worker must be running for tasks to execute, so use `npm run dev` rather than `next dev` on its own.

## Where to next

- [Connections](/docs/connections): subscriptions, API keys, smart picking and usage caps
- [Teams](/docs/teams): run a task through Planner → Coder → Tester → Reviewer
- [API proxy](/docs/api-proxy): use your subscription from any OpenAI or Anthropic client, and watch what it spends
- [MCP server](/docs/mcp): drive tasks from Claude Code, Cursor or VS Code

## Troubleshooting

- **Tasks stay in "pending".** The worker isn't running. In Docker, check `docker compose logs worker`.
- **"Claude CLI not found" / "Codex CLI not found".** The binary isn't on the worker's `PATH`. Set `CLAUDE_PATH` / `CODEX_PATH`. The Docker image includes both.
- **A login expired.** **Settings → AI providers** shows a **Sign in** button on the affected connection, and the health indicator in the top bar shows each provider's status.
- **Push fails with "Permission denied (publickey)".** The worker can't see an SSH key with access to the repo.
- **No pull request was opened.** Add a GitHub token in **Settings → Git**. The task log says why.
