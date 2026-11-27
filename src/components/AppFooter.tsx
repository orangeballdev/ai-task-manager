/* eslint-disable @next/next/no-img-element -- tiny static SVG, no optimisation needed */
// The app's copyright footer, matching the public site's (scripts/site/layout.tsx).
import { GITHUB_URL, OWNER_NAME, OWNER_URL, PUBLIC_DOCS_URL } from "@/lib/public-site";

export function AppFooter() {
  return (
    <footer className="border-t border-border px-3 sm:px-6 py-3 shrink-0 text-xs text-muted-foreground/70 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <a
        href={OWNER_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 hover:text-muted-foreground transition-colors"
      >
        <img src="/orangeball.svg" alt="" width={16} height={16} />
        <span>© {new Date().getFullYear()} {OWNER_NAME}</span>
      </a>
      <span>
        <a href={PUBLIC_DOCS_URL} target="_blank" rel="noopener noreferrer" className="hover:text-muted-foreground transition-colors">Docs</a>
        {" · "}
        <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="hover:text-muted-foreground transition-colors">GitHub</a>
      </span>
    </footer>
  );
}
