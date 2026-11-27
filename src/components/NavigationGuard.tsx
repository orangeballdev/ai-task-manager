"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { isDeleteInFlight, subscribeDeleteState } from "@/lib/delete-lock";

/**
 * Warns the user if they try to navigate away (clicking a link, closing the
 * tab, reloading) while a task delete is in flight. Deletes touch the DB and
 * clean up the workspace clone on disk, which can take a visible moment —
 * without this, clicking e.g. "New Task" mid-delete can look like the app
 * just isn't responding. Mounted once in the root layout.
 */
export function NavigationGuard() {
  const isDeletingRef = useRef(isDeleteInFlight());

  useEffect(() => subscribeDeleteState((value) => {
    isDeletingRef.current = value;
  }), []);

  // Hard navigation (reload / close tab / type a new URL) — the browser's
  // native "leave site?" prompt.
  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (!isDeletingRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  // In-app navigation (clicking a Link) — can't be blocked with a native
  // dialog, so surface a toast instead of leaving the click looking dead.
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (!isDeletingRef.current) return;
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = (e.target as HTMLElement | null)?.closest("a[href]") as HTMLAnchorElement | null;
      if (!link) return;
      const href = link.getAttribute("href");
      if (!href || href.startsWith("#")) return;
      if (link.target && link.target !== "_self") return;

      toast.info("Finishing a delete, navigation may be briefly delayed.", {
        id: "delete-nav-warning",
      });
    }
    document.addEventListener("click", handleClick, true);
    return () => document.removeEventListener("click", handleClick, true);
  }, []);

  return null;
}
