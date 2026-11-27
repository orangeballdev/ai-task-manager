"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, RotateCcw, PencilLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { AIProvider } from "@/lib/types";

export function RetryTaskButton({
  taskId,
  currentProviderId,
  description,
  context,
}: {
  taskId: string;
  currentProviderId?: string | null;
  description?: string;
  context?: string | null;
}) {
  const router = useRouter();
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [loading, setLoading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editedDescription, setEditedDescription] = useState(description ?? "");
  const [editedContext, setEditedContext] = useState(context ?? "");
  const panelRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Whether the open popup (options menu or edit panel) should hug the left
  // or right edge of its trigger. Recomputed on open so a trigger sitting
  // near the edge of a narrow (mobile) viewport doesn't render the popup
  // partly or fully off-screen.
  const [menuAlign, setMenuAlign] = useState<"left" | "right">("right");
  const [editAlign, setEditAlign] = useState<"left" | "right">("left");

  useEffect(() => {
    fetch("/api/providers")
      .then((r) => r.json())
      .then((data: AIProvider[]) => setProviders(data.filter((p) => p.isEnabled)))
      .catch(() => {});
  }, []);

  // Keep editable fields in sync when props change (e.g. page navigates).
  // Adjusted during render rather than in an effect, so there's no stale frame.
  const [syncedProps, setSyncedProps] = useState({ description, context });
  if (syncedProps.description !== description || syncedProps.context !== context) {
    setSyncedProps({ description, context });
    setEditedDescription(description ?? "");
    setEditedContext(context ?? "");
  }

  // Close panel when clicking outside
  useEffect(() => {
    if (!editMode) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setEditMode(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [editMode]);

  // Keep the options menu on-screen: it defaults to right-aligned (hugs the
  // chevron button), but on a narrow/mobile viewport a trigger near the left
  // edge would push most of the menu off-screen. Flip to left-aligned when
  // that would happen, and back if it would then overflow the right edge.
  useEffect(() => {
    if (!pickerOpen) return;
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.left < 0) {
      setMenuAlign("left");
    } else if (rect.right > window.innerWidth) {
      setMenuAlign("right");
    }
  }, [pickerOpen]);

  // Same idea for the "retry with edits" panel, which is much wider and so
  // is even more likely to run off the edge of a phone screen.
  useEffect(() => {
    if (!editMode) return;
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      setEditAlign("right");
    } else if (rect.left < 0) {
      setEditAlign("left");
    }
  }, [editMode]);

  async function retry(providerId?: string) {
    setLoading(true);
    setPickerOpen(false);
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "pending",
          nextRetryAt: null,
          retryCount: 1,
          ...(providerId !== undefined ? { aiProviderId: providerId } : {}),
        }),
      });
      if (res.ok) {
        router.refresh();
      }
    } finally {
      setLoading(false);
    }
  }

  async function retryWithEdits() {
    if (!editedDescription.trim()) return;
    setLoading(true);
    setEditMode(false);
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "pending",
          nextRetryAt: null,
          retryCount: 1,
          description: editedDescription.trim(),
          context: editedContext.trim() || null,
        }),
      });
      if (res.ok) {
        router.refresh();
      }
    } finally {
      setLoading(false);
    }
  }

  // Providers other than the current one
  const alternateProviders = providers.filter((p) => p.id !== currentProviderId);
  const hasDropdown = alternateProviders.length > 0 || description !== undefined;

  return (
    <div className="flex items-center gap-1">
      <Button variant="secondary" size="sm" disabled={loading} onClick={() => void retry()} aria-label="Retry task" title="Retry task, continuing from existing work">
        <RotateCcw />
        Retry
      </Button>

      {hasDropdown && (
        <div className="relative" ref={editMode ? panelRef : undefined}>
          <Button
            variant="ghost"
            size="sm"
            disabled={loading}
            onClick={() => { setPickerOpen((o) => !o); setEditMode(false); setMenuAlign("right"); }}
            title="More retry options"
            className="px-1.5"
          >
            <ChevronDown className="size-3.5" />
          </Button>
          {pickerOpen && !editMode && (
            <>
              {/* Backdrop */}
              <div
                className="fixed inset-0 z-40"
                onClick={() => setPickerOpen(false)}
              />
              <div
                ref={menuRef}
                className={`absolute top-full mt-1 z-50 bg-popover border border-border rounded-lg shadow-md py-1 min-w-[200px] max-w-[calc(100vw-1.5rem)] ${
                  menuAlign === "right" ? "right-0" : "left-0"
                }`}
              >
                <div className="max-h-[60vh] overflow-y-auto">
                {/* menu items */}
                {alternateProviders.length > 0 && (
                  <>
                    <p className="px-3 py-1.5 text-xs text-muted-foreground font-medium uppercase tracking-wide">
                      Retry with…
                    </p>
                    {alternateProviders.map((p) => (
                      <button
                        key={p.id}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-accent transition-colors flex items-center gap-2"
                        onMouseDown={(e) => { e.preventDefault(); void retry(p.id); }}
                      >
                        <RotateCcw className="size-3.5 text-muted-foreground shrink-0" />
                        <span className="truncate">{p.name}</span>
                        {p.isDefault && (
                          <span className="text-xs text-muted-foreground ml-auto shrink-0">default</span>
                        )}
                      </button>
                    ))}
                    {description !== undefined && (
                      <div className="border-t border-border my-1" />
                    )}
                  </>
                )}
                {description !== undefined && (
                  <button
                    className="w-full text-left px-3 py-2 text-sm hover:bg-accent transition-colors flex items-center gap-2"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setPickerOpen(false);
                      setEditAlign("left");
                      setEditMode(true);
                    }}
                  >
                    <PencilLine className="size-3.5 text-muted-foreground shrink-0" />
                    <span>Retry with edits…</span>
                  </button>
                )}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* Inline edit panel — shown below the button row when editMode is true */}
      {editMode && (
        <div
          ref={panelRef}
          className={`absolute mt-1 z-50 bg-popover border border-border rounded-lg shadow-lg p-4 w-[min(420px,calc(100vw-1.5rem))] flex flex-col gap-3 ${
            editAlign === "left" ? "left-0" : "right-0"
          }`}
          style={{ top: "calc(100% + 4px)" }}
        >
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Edit prompt, then retry
          </p>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Description</label>
            <Textarea
              value={editedDescription}
              onChange={(e) => setEditedDescription(e.target.value)}
              rows={5}
              className="text-sm resize-none"
              placeholder="What should the agent do?"
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Context (optional)</label>
            <Textarea
              value={editedContext}
              onChange={(e) => setEditedContext(e.target.value)}
              rows={3}
              className="text-sm resize-none"
              placeholder="Additional context, constraints, notes…"
            />
          </div>
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setEditMode(false)}
            >
              Cancel
            </button>
            <Button
              size="sm"
              disabled={loading || !editedDescription.trim()}
              onClick={() => void retryWithEdits()}
            >
              <RotateCcw className="size-3.5 mr-1.5" />
              {loading ? "Retrying…" : "Retry with edits"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
