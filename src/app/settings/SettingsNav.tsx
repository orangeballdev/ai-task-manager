"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const tabs = [
  { href: "/settings/general", label: "General" },
  { href: "/settings/layout", label: "Layout" },
  { href: "/settings/ai", label: "AI" },
  { href: "/settings/git", label: "Git" },
  { href: "/settings/tools", label: "Agent Tools" },
  { href: "/settings/mcp-servers", label: "MCP Servers" },
  { href: "/settings/notifications", label: "Notifications" },
  { href: "/settings/integrations", label: "Integrations" },
  { href: "/settings/observability", label: "Observability" },
  { href: "/settings/api", label: "API" },
  { href: "/settings/mcp", label: "MCP" },
  { href: "/settings/data", label: "Data" },
  { href: "/settings/account", label: "Account" },
  { href: "/settings/security", label: "Security" },
  { href: "/settings/admin", label: "Admin" },
];

export default function SettingsNav() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 border-b border-border overflow-x-auto scrollbar-none">
      {tabs.map(({ href, label }) => {
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px shrink-0 ${
              active
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
