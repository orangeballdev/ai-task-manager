import Link from "next/link";

const TABS = [
  { key: "overview", label: "Overview", href: "/analytics" },
  { key: "gateway", label: "API Proxy", href: "/analytics/gateway" },
  { key: "admin", label: "Admin", href: "/analytics/admin" },
] as const;

export type AnalyticsTabKey = (typeof TABS)[number]["key"];

/** Tab strip shared by the /analytics pages. `range` is carried across tabs that use it. */
export function AnalyticsTabs({ active, range }: { active: AnalyticsTabKey; range?: string }) {
  return (
    <nav className="flex items-center gap-1 border-b border-border" aria-label="Analytics sections">
      {TABS.map((t) => {
        const href = range && t.key !== "admin" ? `${t.href}?range=${range}` : t.href;
        const isActive = t.key === active;
        return (
          <Link
            key={t.key}
            href={href}
            aria-current={isActive ? "page" : undefined}
            className={`px-3 py-2 text-sm font-medium -mb-px border-b-2 transition-colors ${
              isActive ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
