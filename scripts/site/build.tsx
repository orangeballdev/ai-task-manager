/* eslint-disable @next/next/no-img-element -- static HTML generator, not a Next.js page */
// Builds the public website (marketing page + docs) into site/dist as plain static HTML,
// ready for GitHub Pages (.github/workflows/pages.yml) or any static host.
//
//   npm run site:build      # writes site/dist
//   npm run site:preview    # builds, then serves it locally
//
// Sources:
//   site/content/docs/*.md        hand-written guides (front matter: title, description)
//   src/lib/docs-content/*        the in-app /docs reference pages (REST API, API proxy, MCP),
//                                 rendered here too so the two never drift apart
//   site/public/                  copied as-is (styles, screenshots from `npm run demo:screenshots`)
//
// Every link is written relative to the page, so the site works under a project path
// (orangeballdev.github.io/ai-task-manager/) as well as at a domain root. In markdown,
// write site links as root paths (`/docs/teams`, `/screenshots/board.png`); they're rewritten.
import fs from "fs";
import os from "os";
import path from "path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Home } from "./home";
import { Layout } from "./layout";
import { GITHUB_URL, IMAGE, PRODUCT_NAME, SITE_DESCRIPTION } from "./site-config";
import { PUBLIC_SITE_URL } from "../../src/lib/public-site";

const ROOT = path.resolve(__dirname, "../..");
const SITE = path.join(ROOT, "site");
const DIST = path.join(SITE, "dist");
/** The address the generated reference docs use in examples: a default local install. */
const EXAMPLE_ORIGIN = "http://localhost:3000";

interface DocPage {
  slug: string; // "" for the docs index
  title: string;
  description: string;
  markdown: string;
  group: "Guides" | "Reference";
}

// ---------- docs sources ----------

function readGuide(file: string): { title: string; description: string; body: string } {
  const raw = fs.readFileSync(path.join(SITE, "content/docs", file), "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
  const meta: Record<string, string> = {};
  for (const line of (m?.[1] ?? "").split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { title: meta.title ?? file, description: meta.description ?? "", body: m ? raw.slice(m[0].length) : raw };
}

/** Rewrites a reference topic's deployment-specific bits for a public page. */
function publicReference(markdown: string): string {
  return (
    markdown
      // Links to other docs pages → this site's pages.
      .replace(new RegExp(`\\]\\(${EXAMPLE_ORIGIN}/docs/?([^)\\s]*)\\)`, "g"), (_m, rest: string) => `](/docs/${rest || ""})`)
      // Links into the app (Settings → API, …) have nowhere to go on a public site: keep the label.
      .replace(new RegExp(`\\[([^\\]]+)\\]\\(${EXAMPLE_ORIGIN}/[^)\\s]*\\)`, "g"), "**$1**")
      .replace(/The URLs already point at this deployment\./g, `Swap \`${EXAMPLE_ORIGIN}\` for your own deployment's address.`)
  );
}

async function referencePages(): Promise<DocPage[]> {
  // tools.ts pulls in the Prisma client, which opens DATABASE_URL on import. Point it at a
  // throwaway file: the docs need the tool definitions, not the data.
  process.env.DATABASE_URL = `file:${path.join(fs.mkdtempSync(path.join(os.tmpdir(), "site-build-")), "unused.db")}`;
  const { DOCS_TOPICS, renderDocsTopic } = await import("../../src/lib/docs-content/index");
  const { MCP_TOOLS, MCP_PROMPTS } = await import("../../src/lib/mcp/tools");
  const titles: Record<string, string> = { "llm-gateway": "API proxy reference", api: "REST API", mcp: "MCP server" };
  return DOCS_TOPICS.map((t) => {
    const r = renderDocsTopic(t.id, EXAMPLE_ORIGIN, { tools: MCP_TOOLS, prompts: MCP_PROMPTS })!;
    return { slug: t.id, title: titles[t.id] ?? t.title, description: t.summary, markdown: publicReference(r.markdown), group: "Reference" as const };
  });
}

// ---------- rendering helpers ----------

/** "../" repeated for a page written at `outPath` (relative to dist). */
function prefixFor(outPath: string): string {
  return "../".repeat(outPath.split("/").length - 1);
}

/** Root-relative site link → page-relative link. Leaves external links and anchors alone. */
function relLink(href: string, prefix: string): string {
  if (!href.startsWith("/") || href.startsWith("//")) return href;
  const [p, hash] = href.split("#");
  const clean = p.replace(/^\/+/, "");
  const isFile = /\.[a-z0-9]+$/i.test(clean);
  const target = clean === "" ? "./" : isFile || clean.endsWith("/") ? clean : `${clean}/`;
  const out = target === "./" ? prefix || "./" : prefix + target;
  return hash !== undefined ? `${out}#${hash}` : out;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && "props" in node) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

function MarkdownBody({ markdown, prefix }: { markdown: string; prefix: string }) {
  const heading = (Tag: "h2" | "h3") =>
    function H({ children }: { children?: ReactNode }) {
      const id = slugify(textOf(children));
      return (
        <Tag id={id}>
          <a className="anchor" href={`#${id}`} aria-hidden="true">#</a>
          {children}
        </Tag>
      );
    };
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{
        h2: heading("h2"),
        h3: heading("h3"),
        a: ({ href, children }) => {
          const external = href?.startsWith("http");
          return (
            <a href={relLink(href ?? "", prefix)} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
              {children}
            </a>
          );
        },
        img: ({ src, alt }) => {
          const url = relLink(String(src ?? ""), prefix);
          return (
            <a className="shot" href={url} target="_blank" rel="noopener noreferrer">
              <img src={url} alt={alt ?? ""} loading="lazy" />
            </a>
          );
        },
        table: ({ children }) => (
          <div className="table-wrap">
            <table>{children}</table>
          </div>
        ),
      }}
    >
      {markdown}
    </Markdown>
  );
}

function DocsPageView({ page, pages, prefix }: { page: DocPage; pages: DocPage[]; prefix: string }) {
  const toc = [...page.markdown.matchAll(/^## (.+)$/gm)].map((m) => ({ text: m[1].replace(/`/g, ""), id: slugify(m[1]) }));
  const groups = ["Guides", "Reference"] as const;
  return (
    <div className="docs">
      <button className="docs-toggle" type="button">Menu</button>
      <aside className="docs-nav">
        {groups.map((g) => (
          <div key={g}>
            <p className="docs-nav-group">{g}</p>
            {pages
              .filter((p) => p.group === g)
              .map((p) => (
                <a key={p.slug} href={relLink(`/docs/${p.slug}`, prefix)} className={p.slug === page.slug ? "current" : undefined}>
                  {p.title}
                </a>
              ))}
          </div>
        ))}
      </aside>
      <main className="docs-main prose">
        <MarkdownBody markdown={page.markdown} prefix={prefix} />
      </main>
      {toc.length > 1 && (
        <aside className="docs-toc">
          <p className="docs-nav-group">On this page</p>
          {toc.map((h) => (
            <a key={h.id} href={`#${h.id}`}>{h.text}</a>
          ))}
        </aside>
      )}
    </div>
  );
}

// ---------- build ----------

/**
 * The docker-compose.yml the installer downloads: the repo's own compose file, switched
 * from building `ai-task-manager:local` to pulling the published image. Derived rather than
 * kept as a second copy, so the two can't drift; fails loudly if the source changes shape.
 */
function releaseCompose(): string {
  const src = fs.readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
  const count = (re: RegExp) => (src.match(re) ?? []).length;
  const services = count(/^ {4}image: ai-task-manager:local$/gm);
  if (services < 2 || count(/^ {4}build: \.$/gm) !== 1 || count(/^ {4}pull_policy: never$/gm) !== services - 1) {
    throw new Error("docker-compose.yml no longer matches what releaseCompose() expects; update it in scripts/site/build.tsx");
  }
  const body = src
    .replace(/^(#.*\n)+/, "")
    .replace(/^ {4}build: \.\n/gm, "")
    .replace(/^ {4}pull_policy: never\n/gm, "")
    // Multi-arch (amd64 + arm64, see images.yml), so Docker picks the host's platform.
    .replace(/^ {4}image: ai-task-manager:local$/gm, `    image: ${IMAGE}:\${AI_TASK_MANAGER_TAG:-latest}`);
  return [
    `# ${PRODUCT_NAME}: run the published image with Docker Compose.`,
    `#`,
    `#   docker compose up -d          # then open http://localhost:3000`,
    `#`,
    `# Or let the installer do it: curl -fsSL ${PUBLIC_SITE_URL}/install.sh | sh`,
    `# Generated from ${GITHUB_URL}/blob/main/docker-compose.yml by scripts/site/build.tsx.`,
    `# Env: AI_TASK_MANAGER_PORT (default 3000), AI_TASK_MANAGER_TAG (default latest).`,
    body,
  ].join("\n");
}

function installScript(): string {
  return fs
    .readFileSync(path.join(SITE, "install.sh"), "utf8")
    .replace(/__SITE_URL__/g, PUBLIC_SITE_URL)
    .replace(/__REPO_URL__/g, `${GITHUB_URL}.git`);
}

function write(outPath: string, element: ReactNode) {
  const file = path.join(DIST, outPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "<!doctype html>" + renderToStaticMarkup(element as React.ReactElement));
}

function copyDir(from: string, to: string) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else fs.copyFileSync(src, dest);
  }
}

async function main() {
  fs.rmSync(DIST, { recursive: true, force: true });
  copyDir(path.join(SITE, "public"), DIST);
  fs.copyFileSync(path.join(ROOT, "src/app/icon.svg"), path.join(DIST, "icon.svg"));
  fs.writeFileSync(path.join(DIST, ".nojekyll"), "");
  fs.writeFileSync(path.join(DIST, "docker-compose.yml"), releaseCompose());
  fs.writeFileSync(path.join(DIST, "install.sh"), installScript(), { mode: 0o755 });

  const guide = (file: string, slug: string): DocPage => {
    const g = readGuide(file);
    return { slug, title: g.title, description: g.description, markdown: g.body, group: "Guides" };
  };
  const pages: DocPage[] = [
    guide("getting-started.md", ""),
    guide("connections.md", "connections"),
    guide("teams.md", "teams"),
    guide("api-proxy.md", "api-proxy"),
    ...(await referencePages()),
  ];

  // Fail the build on a link to a docs page or screenshot that doesn't exist.
  const slugs = new Set(pages.map((p) => p.slug));
  for (const p of pages) {
    for (const m of p.markdown.matchAll(/\]\((\/[^)\s#]*)/g)) {
      const target = m[1];
      const ok = target.startsWith("/docs")
        ? slugs.has(target.replace(/^\/docs\/?/, "").replace(/\/$/, ""))
        : fs.existsSync(path.join(DIST, target));
      if (!ok) throw new Error(`Broken link in docs/${p.slug || "index"}: ${target}`);
    }
  }

  write("index.html", <Home prefix="" />);
  for (const page of pages) {
    const out = page.slug ? `docs/${page.slug}/index.html` : "docs/index.html";
    const prefix = prefixFor(out);
    write(
      out,
      <Layout title={`${page.title} · ${PRODUCT_NAME}`} description={page.description || SITE_DESCRIPTION} prefix={prefix} active="docs">
        <DocsPageView page={page} pages={pages} prefix={prefix} />
      </Layout>,
    );
  }
  console.log(`Built ${pages.length + 1} pages into ${path.relative(ROOT, DIST)}/`);
  process.exit(0); // the Prisma client imported for the MCP tool list keeps the loop alive
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
