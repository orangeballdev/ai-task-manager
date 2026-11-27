"use client";
import { useEffect } from "react";
import { usePathname } from "next/navigation";

// When a settings page is opened with a hash (e.g. /settings/general#task-timeout),
// scroll to the matching setting and briefly highlight its card so the user can
// spot exactly which option the search sent them to.
export default function SettingHighlighter() {
  const pathname = usePathname();

  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!hash) return;

    let cancelled = false;
    // Wait a tick for the target page's cards to render/hydrate.
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      const target = document.getElementById(hash);
      if (!target) return;

      target.scrollIntoView({ behavior: "smooth", block: "start" });

      const card = (target.closest("[data-slot=card]") as HTMLElement) ?? target;
      card.classList.add(
        "ring-2",
        "ring-primary",
        "transition-shadow",
        "duration-500",
      );
      const clear = window.setTimeout(() => {
        card.classList.remove("ring-2", "ring-primary");
      }, 2200);
      // Store on the element so an unmount cleanup can clear it.
      (card as HTMLElement & { _hlTimer?: number })._hlTimer = clear;
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pathname]);

  return null;
}
