// The public website (marketing page + docs), built from site/ by scripts/site/build.tsx
// and hosted on GitHub Pages by .github/workflows/pages.yml.
//
// The in-app /docs pages still exist: they render the same content with this
// deployment's own URLs, and the MCP `get_docs` tool serves them. The nav's "Docs"
// link points at the public site, which also has the getting-started and feature guides.
export const PUBLIC_SITE_URL = "https://orangeballdev.github.io/ai-task-manager";
export const PUBLIC_DOCS_URL = `${PUBLIC_SITE_URL}/docs/`;

/** Copyright holder, shown in the footer of the app and the public site. Matches LICENSE. */
export const OWNER_NAME = "orangeball.dev";
export const OWNER_URL = "https://orangeball.dev";
export const GITHUB_URL = "https://github.com/orangeballdev/ai-task-manager";
