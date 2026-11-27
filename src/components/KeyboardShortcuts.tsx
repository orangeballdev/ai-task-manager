"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/** Returns true when the user is focused on an editable element — shortcuts should be suppressed. */
function isTyping(): boolean {
  const tag = document.activeElement?.tagName ?? "";
  const editable = (document.activeElement as HTMLElement | null)?.isContentEditable;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!editable;
}

const SHORTCUTS: { keys: string; description: string }[] = [
  { keys: "n", description: "Create new task" },
  { keys: "⌘K", description: "Open search (searches the docs on /docs pages)" },
  { keys: "?", description: "Show keyboard shortcuts" },
  { keys: "Esc", description: "Close dialogs / clear search" },
];

/** Invisible component mounted once in the root layout — handles global keyboard shortcuts. */
export function KeyboardShortcuts() {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Never fire when ⌘/Ctrl is held (those are browser/OS shortcuts)
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "Escape") {
        setOpen(false);
        return;
      }

      if (e.key === "?") {
        // Allow ? even when typing — it might open in an input but we guard below
        if (isTyping()) return;
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }

      if (isTyping()) return;

      if (e.key === "n") {
        e.preventDefault();
        router.push("/tasks/new");
        return;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router]);

  if (!open) return null;

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={() => setOpen(false)}
    >
      {/* Modal */}
      <div
        className="bg-popover border border-border rounded-xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
      >
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="font-semibold text-sm">Keyboard Shortcuts</h2>
          <button
            onClick={() => setOpen(false)}
            className="text-muted-foreground hover:text-foreground transition-colors text-sm"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <ul className="divide-y divide-border">
          {SHORTCUTS.map(({ keys, description }) => (
            <li key={keys} className="flex items-center justify-between px-5 py-3 text-sm">
              <span className="text-muted-foreground">{description}</span>
              <kbd className="font-mono text-xs bg-muted px-2 py-1 rounded border border-border text-foreground">
                {keys}
              </kbd>
            </li>
          ))}
        </ul>
        <p className="px-5 py-3 text-xs text-muted-foreground border-t border-border">
          Shortcuts are disabled while typing in a text field.
        </p>
      </div>
    </div>
  );
}
