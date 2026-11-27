"use client";

/**
 * Copy text to the clipboard.
 *
 * Always use this instead of calling `navigator.clipboard` directly:
 * `navigator.clipboard` is only defined in secure contexts (HTTPS or
 * localhost), so on a self-hosted install served over plain HTTP it is
 * `undefined` and `navigator.clipboard.writeText` throws a TypeError. In that
 * case we fall back to the legacy `document.execCommand("copy")` route.
 *
 * Rejects if neither method succeeds.
 */
export async function copyToClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to execCommand fallback (e.g. permission denied)
    }
  }
  if (!legacyCopy(text)) throw new Error("Copy failed");
}

function legacyCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const previouslyFocused = document.activeElement as HTMLElement | null;
  const el = document.createElement("textarea");
  el.value = text;
  // readonly stops iOS from popping up the keyboard; keep it on-screen (but
  // invisible) so Safari is willing to select its contents.
  el.setAttribute("readonly", "");
  el.style.cssText =
    "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;pointer-events:none";
  document.body.appendChild(el);
  let ok = false;
  try {
    el.focus();
    el.select();
    // iOS Safari ignores select() on a textarea; an explicit range works.
    el.setSelectionRange(0, text.length);
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  } finally {
    document.body.removeChild(el);
    previouslyFocused?.focus?.();
  }
  return ok;
}
