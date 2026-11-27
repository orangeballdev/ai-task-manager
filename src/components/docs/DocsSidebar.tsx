"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { DOCS_NAV } from "@/lib/docs-nav";

export function DocsSidebar() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-6 text-sm">
      {DOCS_NAV.map((section) => (
        <div key={section.title} className="flex flex-col gap-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground px-2 mb-1">
            {section.title}
          </span>
          {section.items.map((item) => {
            const href = item.anchor ? `${item.href}#${item.anchor}` : item.href;
            const active = pathname === item.href;
            return (
              <Link
                key={href}
                href={href}
                className={`px-2 py-1.5 rounded-md transition-colors ${
                  active ? "bg-muted text-foreground font-medium" : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                }`}
              >
                {item.title}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
