"use client";
import { usePathname } from "next/navigation";
import { findSettingsPage } from "./settings-sections";

// Title + one-line summary of the current settings page, so each page says
// what it's for without an "About …" card of its own.
export default function SettingsPageHeader() {
  const page = findSettingsPage(usePathname());
  if (!page) return null;
  return (
    <div className="mb-6 border-b border-border pb-4">
      <h2 className="text-lg font-semibold">{page.label}</h2>
      <p className="text-sm text-muted-foreground">{page.description}</p>
    </div>
  );
}
