/* eslint-disable @next/next/no-img-element -- static HTML generator, not a Next.js page */
// The marketing page (site/dist/index.html). Screenshots come from `npm run demo:screenshots`.
import type { ReactNode } from "react";
import { Layout } from "./layout";
import { GITHUB_URL, PRODUCT_NAME, SITE_DESCRIPTION } from "./site-config";
import { PUBLIC_SITE_URL } from "../../src/lib/public-site";

function Shot({ prefix, name, alt, className }: { prefix: string; name: string; alt: string; className?: string }) {
  const src = `${prefix}screenshots/${name}.png`;
  return (
    <a className={`shot ${className ?? ""}`} href={src} target="_blank" rel="noopener noreferrer">
      <img src={src} alt={alt} loading="lazy" />
    </a>
  );
}

function Feature({
  id,
  eyebrow,
  title,
  children,
  media,
  flip,
}: {
  id?: string;
  eyebrow: string;
  title: string;
  children: ReactNode;
  media: ReactNode;
  flip?: boolean;
}) {
  return (
    <section id={id} className={`feature ${flip ? "flip" : ""}`}>
      <div className="feature-text">
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
        {children}
      </div>
      <div className="feature-media">{media}</div>
    </section>
  );
}

const PROXY_SNIPPET = `from openai import OpenAI

# Any OpenAI client, running on your Claude Max login
client = OpenAI(
    base_url="https://tasks.example.com/api/llm/v1",
    api_key="tm_live_…",
)
client.chat.completions.create(
    model="claude-sonnet-5-5",
    messages=[{"role": "user", "content": "Review this diff"}],
)`;

const INSTALL_SNIPPET = `curl -fsSL ${PUBLIC_SITE_URL}/install.sh | sh`;

const MORE = [
  { title: "Kanban board & live logs", body: "Watch agents work in real time, message them mid-task, then approve the result or request changes." },
  { title: "Branches & pull requests", body: "Every task ends in a pushed branch, a PR, or a commit to the branch you choose. Pushes are verified." },
  { title: "Schedules", body: "Run a task once at a set time, or on a cron schedule, with an optional cap on the number of runs." },
  { title: "MCP server", body: "Create, watch and review tasks from Claude Code, Claude Desktop, Cursor or VS Code over OAuth." },
  { title: "Slack, email & webhooks", body: "Propose tasks from a Slack thread, forward an email, or trigger from CI with a REST API." },
  { title: "Per-repo defaults", body: "Branch, git mode, model, team and a concurrency limit for each saved repository." },
  { title: "Tools for agents", body: "Grant the GitHub CLI and your own MCP servers per task, with credentials kept out of the repo." },
  { title: "OpenTelemetry", body: "Traces, metrics and logs with GenAI conventions: every agent run, tool call and proxy request." },
];

export function Home({ prefix }: { prefix: string }) {
  return (
    <Layout title={`${PRODUCT_NAME}: coding agents on the subscriptions you already have`} description={SITE_DESCRIPTION} prefix={prefix} active="home">
      <main>
        <section className="hero">
          <p className="pill">Self-hosted · Claude Code · Codex · MIT</p>
          <h1>
            Put your Claude and ChatGPT subscriptions <span className="accent">to work</span>.
          </h1>
          <p className="lede">
            {PRODUCT_NAME} queues coding tasks against your Git repos and runs Claude Code and Codex agents on the plans you already pay for. It
            pushes branches, opens pull requests, and turns the same logins into an OpenAI- and Anthropic-compatible API.
          </p>
          <div className="cta">
            <a className="button primary" href={`${prefix}docs/`}>Get started</a>
            <a className="button" href={GITHUB_URL} target="_blank" rel="noopener noreferrer">View on GitHub</a>
          </div>
          <Shot prefix={prefix} name="board" alt="The task board: tasks moving from To Do through In Progress and In Review to Done" className="hero-shot" />
        </section>

        <section className="strip" aria-label="Works with">
          <span>Works with</span>
          <b>Claude Pro &amp; Max</b>
          <b>ChatGPT / Codex</b>
          <b>Anthropic API</b>
          <b>OpenAI &amp; compatible</b>
          <b>Self-hosted Claude gateways</b>
        </section>

        <div id="features" className="features">
          <Feature
            eyebrow="CLI-only subscriptions"
            title="No API key? Use the plan you already have."
            media={<Shot prefix={prefix} name="plan-usage" alt="Plan usage per subscription: 5-hour and weekly windows" className="narrow" />}
          >
            <p>
              Claude Pro/Max and ChatGPT plans only work through their own CLIs. {PRODUCT_NAME} runs <code>claude</code> and <code>codex</code> for
              you, so a subscription becomes a worker that clears your backlog.
            </p>
            <ul>
              <li>Sign in with Claude from the browser: no terminal, works in Docker.</li>
              <li>See each plan&apos;s 5-hour and weekly usage and when it resets.</li>
              <li>Cap usage at, say, 85% so the rest of your plan stays yours.</li>
            </ul>
            <a className="more" href={`${prefix}docs/connections/`}>How connections work →</a>
          </Feature>

          <Feature
            flip
            eyebrow="Connections"
            title="Every account you have, working as one pool."
            media={<Shot prefix={prefix} name="connections" alt="AI provider connections: two Claude Max accounts, ChatGPT Pro, Anthropic and OpenAI API keys" />}
          >
            <p>
              Add several Claude accounts, a ChatGPT login and API keys side by side. The smart picker chooses a connection for each task, and
              runs keep going when one runs out.
            </p>
            <ul>
              <li>Spends the subscription whose weekly window resets soonest, so capacity isn&apos;t wasted.</li>
              <li>Subscriptions first, metered API keys only when you need them.</li>
              <li>Rate limit or expired login? The task moves to another connection and resumes in the same workspace.</li>
            </ul>
          </Feature>

          <Feature
            eyebrow="Teams"
            title="A planner, a coder, a tester and a reviewer."
            media={
              <div className="stack">
                <Shot prefix={prefix} name="task-team" alt="A team task: Planner finished and approved, Coder working, with per-member activity log" />
              </div>
            }
          >
            <p>
              Run a task through a pipeline of agents instead of one. Each member has its own instructions and builds on the previous member&apos;s
              output.
            </p>
            <ul>
              <li>Approval gates: read the plan and approve it, or send it back, before any code is written.</li>
              <li>Live progress per stage, with tokens and timings, and a log you can filter by member.</li>
              <li>Give a repo a default team, and every task on it gets the full treatment.</li>
            </ul>
            <a className="more" href={`${prefix}docs/teams/`}>Build a team →</a>
          </Feature>

          <Feature
            flip
            eyebrow="API proxy"
            title="Your subscription, behind the OpenAI and Anthropic APIs."
            media={
              <div className="code-card">
                <div className="code-card-bar">
                  <span />
                  <span />
                  <span />
                  <em>any OpenAI or Anthropic client</em>
                </div>
                <pre>
                  <code>{PROXY_SNIPPET}</code>
                </pre>
              </div>
            }
          >
            <p>
              Point Cursor, Zed, a chatbot or a script at <code>/api/llm/v1</code> with a task-manager key. Requests run on the connection you pick
              for that key, including a CLI-only subscription.
            </p>
            <ul>
              <li>OpenAI chat completions and Anthropic messages, translated both ways.</li>
              <li>Streaming, tool calls, images, web search and your MCP servers.</li>
              <li>One key per service, each pinned to its own account or the smart picker.</li>
            </ul>
            <a className="more" href={`${prefix}docs/api-proxy/`}>Set up the proxy →</a>
          </Feature>

          <Feature
            eyebrow="API proxy monitoring"
            title="See every request, token and dollar."
            media={
              <div className="stack two">
                <Shot prefix={prefix} name="gateway" alt="API proxy analytics: requests, tokens, estimated cost and hourly usage" />
                <Shot prefix={prefix} name="gateway-breakdown" alt="Usage by model and by API key" />
              </div>
            }
          >
            <p>Every proxy request is recorded, so you always know which service is spending what.</p>
            <ul>
              <li>Tokens per hour and per day, busiest hours, failures and latency.</li>
              <li>Breakdowns by model and by API key, plus every request with cache hits.</li>
              <li>Billed cost next to what subscription traffic would cost at API prices.</li>
              <li>A kill switch that pauses the proxy for an hour, a day, or until you say so.</li>
            </ul>
          </Feature>
        </div>

        <section className="more-grid">
          <h2>And everything around it</h2>
          <div className="grid">
            {MORE.map((m) => (
              <div key={m.title} className="card">
                <h3>{m.title}</h3>
                <p>{m.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="install">
          <div>
            <h2>Running in two minutes</h2>
            <p>
              One command, with Docker running: it downloads the compose file, starts the web app, the worker and the integrations on{" "}
              <code>localhost:3000</code>. Then sign in to a subscription from Settings, add a repo, and queue your first task.
            </p>
            <a className="button primary" href={`${prefix}docs/`}>Read the guide</a>
          </div>
          <div className="install-cmd">
            <pre>
              <code>{INSTALL_SNIPPET}</code>
            </pre>
            <p className="install-alt">
              Rather not pipe to a shell? Download <a href={`${prefix}docker-compose.yml`} download>docker-compose.yml</a> and run{" "}
              <code>docker compose up -d</code>, or read <a href={`${prefix}install.sh`}>the script</a> first.
            </p>
          </div>
        </section>
      </main>
    </Layout>
  );
}
