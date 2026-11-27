// Search-engine and LLM plumbing for the public site: absolute URLs, JSON-LD, sitemap.xml,
// robots.txt and llms.txt. Everything absolute is built from PUBLIC_SITE_URL, so moving the
// site to a custom domain is a one-line change in src/lib/public-site.ts.
import { GITHUB_URL, OWNER_NAME, OWNER_URL, PRODUCT_NAME, SITE_DESCRIPTION } from "./site-config";
import { PUBLIC_SITE_URL } from "../../src/lib/public-site";

/** The image shared links show (PNG: not every link unfurler reads WebP). */
export const OG_IMAGE = "screenshots/board.png";

/** Absolute URL for a site-root-relative path ("" = home, "docs/mcp/"). */
export function absoluteUrl(rootPath: string): string {
  return `${PUBLIC_SITE_URL}/${rootPath.replace(/^\/+/, "")}`;
}

/** Serialises JSON-LD for a <script> tag (escapes "<" so content can't close the tag). */
export function jsonLdScript(data: object): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

const publisher = { "@type": "Organization", name: OWNER_NAME, url: OWNER_URL };

export function homeJsonLd(): object[] {
  return [
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: PRODUCT_NAME,
      url: absoluteUrl(""),
      description: SITE_DESCRIPTION,
      publisher,
    },
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: PRODUCT_NAME,
      description: SITE_DESCRIPTION,
      url: absoluteUrl(""),
      image: absoluteUrl(OG_IMAGE),
      screenshot: absoluteUrl(OG_IMAGE),
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Linux, macOS, Windows (Docker)",
      license: "https://opensource.org/licenses/MIT",
      isAccessibleForFree: true,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      downloadUrl: GITHUB_URL,
      softwareHelp: absoluteUrl("docs/"),
      author: publisher,
    },
  ];
}

export function docJsonLd(page: { title: string; description: string; rootPath: string }): object[] {
  const crumbs = [
    { name: PRODUCT_NAME, path: "" },
    { name: "Docs", path: "docs/" },
    ...(page.rootPath === "docs/" ? [] : [{ name: page.title, path: page.rootPath }]),
  ];
  return [
    {
      "@context": "https://schema.org",
      "@type": "TechArticle",
      headline: page.title,
      description: page.description,
      url: absoluteUrl(page.rootPath),
      image: absoluteUrl(OG_IMAGE),
      isPartOf: { "@type": "WebSite", name: PRODUCT_NAME, url: absoluteUrl("") },
      publisher,
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: crumbs.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.name, item: absoluteUrl(c.path) })),
    },
  ];
}

export function sitemapXml(rootPaths: string[]): string {
  const urls = rootPaths.map((p) => `  <url><loc>${absoluteUrl(p)}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/** Crawlers only read robots.txt at a host's root, so it relies on the site having its own domain. */
export function robotsTxt(): string {
  return `User-agent: *\nAllow: /\n\nSitemap: ${absoluteUrl("sitemap.xml")}\n`;
}

export interface LlmsDoc {
  title: string;
  description: string;
  /** Root-relative path of the page's markdown copy, e.g. "docs/mcp.md". */
  mdPath: string;
  group: "Guides" | "Reference";
}

/** llms.txt (https://llmstxt.org): what the project is, and links to every page as markdown. */
export function llmsTxt(docs: LlmsDoc[], installCommand: string): string {
  const list = (group: LlmsDoc["group"]) =>
    docs
      .filter((d) => d.group === group)
      .map((d) => `- [${d.title}](${absoluteUrl(d.mdPath)})${d.description ? `: ${d.description}` : ""}`)
      .join("\n");
  return [
    `# ${PRODUCT_NAME}`,
    "",
    `> ${SITE_DESCRIPTION}`,
    "",
    `${PRODUCT_NAME} is a self-hosted, MIT-licensed task queue that runs Claude Code and Codex agents against Git repositories. ` +
      "Agents run on Claude Pro/Max and ChatGPT subscriptions (or API keys), push branches and open pull requests. " +
      "It also exposes those connections as an OpenAI- and Anthropic-compatible API, and has an MCP server for driving tasks from other assistants.",
    "",
    `- Install (Docker): \`${installCommand}\``,
    `- Source: ${GITHUB_URL}`,
    `- Every docs page below in one file: ${absoluteUrl("llms-full.txt")}`,
    "",
    "## Guides",
    "",
    list("Guides"),
    "",
    "## Reference",
    "",
    list("Reference"),
    "",
    "## Optional",
    "",
    `- [docker-compose.yml](${absoluteUrl("docker-compose.yml")}): run the published image with Docker Compose`,
    `- [install.sh](${absoluteUrl("install.sh")}): the installer script`,
    `- [GitHub repository](${GITHUB_URL}): source code, issues and README`,
    "",
  ].join("\n");
}
