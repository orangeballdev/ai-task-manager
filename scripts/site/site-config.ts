// Names and links shared by the public site's pages. The site's own URL, the
// copyright holder and the GitHub link live in src/lib/public-site.ts, because the
// app's nav and footer use them too.
export { GITHUB_URL, OWNER_NAME, OWNER_URL } from "../../src/lib/public-site";
export const PRODUCT_NAME = "AI Task Manager";
/** Published by .github/workflows/images.yml on every push to main. */
export const IMAGE = "ghcr.io/orangeballdev/ai-task-manager";
export const SITE_DESCRIPTION =
  "Self-hosted coding agents that run on the Claude and ChatGPT subscriptions you already pay for, plus an OpenAI- and Anthropic-compatible API proxy for them.";
/**
 * ObiStack user analytics for the public site (pageviews, clicks, page leaves, web vitals,
 * errors). The key is a public, write-only ingest key, so it's fine in the page.
 * Empty key = no analytics script. The app's own monitoring is configured separately,
 * in Settings → Observability.
 */
export const SITE_ANALYTICS = { key: "obi_ingest_b5781c16f9e7f05f461eca7e08d0deba", host: "https://ingest.obistack.com" };
