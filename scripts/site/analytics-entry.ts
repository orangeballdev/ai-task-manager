// Bundled by build.tsx into site/dist/analytics/ (esbuild, ESM + code splitting) and loaded
// as a module script (deferred by default) on every page of the public site. Key and host are injected at build time from
// SITE_ANALYTICS in site-config.ts.
import { init } from "@obistack/user-analytics";

declare const __SITE_ANALYTICS__: { key: string; host: string };

try {
  // Pageviews, clicks and page leaves are captured automatically.
  const analytics = init(__SITE_ANALYTICS__);

  // The "Copy" buttons build.tsx adds to code blocks: which snippets people take away,
  // above all the install command.
  document.addEventListener("click", (e) => {
    const button = (e.target as Element | null)?.closest?.("pre > button.copy");
    if (!button) return;
    const code = button.parentElement?.textContent ?? "";
    analytics.capture("code_copied", {
      page: location.pathname,
      snippet: code.includes("install.sh") ? "install" : code.includes("docker-compose") ? "compose" : "other",
    });
  });
} catch (err) {
  console.warn(`[analytics] disabled: ${err instanceof Error ? err.message : String(err)}`);
}
