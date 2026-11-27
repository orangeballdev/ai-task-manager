"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { SETTINGS_GROUPS, findSettingsPage } from "./settings-sections";

// Grouped settings navigation: a sticky sidebar on wide screens, a single
// grouped <select> on narrow ones (instead of a long horizontally-scrolling
// tab strip).
export default function SettingsNav() {
  const pathname = usePathname();
  const router = useRouter();
  const current = findSettingsPage(pathname);

  return (
    <>
      <div className="md:hidden">
        <label htmlFor="settings-page" className="sr-only">
          Settings page
        </label>
        <select
          id="settings-page"
          value={current?.href ?? ""}
          onChange={(e) => router.push(e.target.value)}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
        >
          {!current && <option value="">Choose a page…</option>}
          {SETTINGS_GROUPS.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.pages.map((page) => (
                <option key={page.href} value={page.href}>
                  {page.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      <nav aria-label="Settings" className="hidden md:flex md:flex-col md:gap-5 md:sticky md:top-20">
        {SETTINGS_GROUPS.map((group) => (
          <div key={group.label} className="flex flex-col gap-0.5">
            <span className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground/70">
              {group.label}
            </span>
            {group.pages.map((page) => {
              const active = current?.href === page.href;
              return (
                <Link
                  key={page.href}
                  href={page.href}
                  aria-current={active ? "page" : undefined}
                  className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                    active
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                  }`}
                >
                  {page.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
    </>
  );
}
