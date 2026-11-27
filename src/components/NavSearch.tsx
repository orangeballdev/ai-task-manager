"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Search, X, Repeat, Zap } from "lucide-react";
import { StatusBadge } from "./StatusBadge";
import { getDisplayStatus } from "@/lib/types";
import type { Task } from "@/lib/types";

export function NavSearch() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // The latest search answer and the query it answers; derived below so
  // clearing the query (Escape, outside click, close) needs no extra resets.
  const [search, setSearch] = useState<{ q: string; results: Task[] } | null>(null);
  const trimmedQuery = query.trim();
  const results = trimmedQuery ? search?.results ?? [] : [];
  const loading = trimmedQuery !== "" && search?.q !== trimmedQuery;
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        // Already handled, e.g. by the docs search, which owns ⌘K on /docs pages.
        if (e.defaultPrevented) return;
        e.preventDefault();
        setOpen(true);
      }
      if (e.key === "Escape") {
        setOpen(false);
        setQuery("");
        setSelectedIdx(-1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      let found: Task[] | null = null;
      try {
        const res = await fetch(`/api/tasks?q=${encodeURIComponent(q)}`);
        if (res.ok) {
          const data: Task[] = await res.json();
          found = data.slice(0, 8);
        }
      } catch {
        // ignore
      }
      // On failure keep showing the previous results, but stop "searching".
      if (!cancelled) setSearch((prev) => ({ q, results: found ?? prev?.results ?? [] }));
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  // Close when clicking outside
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
        setSelectedIdx(-1);
      }
    }
    if (open) document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setSelectedIdx(-1);
  }, []);

  const navigate = useCallback((task: Task) => {
    router.push(`/tasks/${task.id}`);
    close();
  }, [router, close]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (selectedIdx >= 0 && results[selectedIdx]) navigate(results[selectedIdx]);
    }
  }

  function taskTypeIcon(task: Task) {
    if (task.isRecurringTemplate || task.recurringTemplateId) return <Repeat className="size-3 text-sky-400 shrink-0" />;
    if (task.cronExpression) return <Repeat className="size-3 text-sky-400 shrink-0" />;
    return <Zap className="size-3 text-muted-foreground shrink-0" />;
  }

  return (
    <div ref={containerRef} className="relative">
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className="text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5 text-sm shrink-0"
          aria-label="Search tasks (⌘K)"
        >
          <Search size={16} />
          <span className="hidden lg:inline text-muted-foreground">Search</span>
          <kbd className="hidden lg:inline text-[10px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground font-mono leading-none">⌘K</kbd>
        </button>
      ) : (
        <div className="flex items-center gap-1.5 border-b border-foreground/40 pb-0.5">
          <Search size={14} className="text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelectedIdx(-1); }}
            onKeyDown={onKeyDown}
            placeholder="Search tasks…"
            className="w-44 sm:w-56 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
          />
          <button onClick={close} className="text-muted-foreground hover:text-foreground shrink-0 transition-colors" aria-label="Close search">
            <X size={14} />
          </button>
        </div>
      )}

      {open && query.trim() && (
        <div className="absolute top-full right-0 mt-2 w-80 bg-popover border border-border rounded-lg shadow-xl z-50 overflow-hidden">
          {loading && (
            <div className="px-4 py-3 text-sm text-muted-foreground">Searching…</div>
          )}
          {!loading && results.length === 0 && (
            <div className="px-4 py-3 text-sm text-muted-foreground">No tasks found for &quot;{query}&quot;</div>
          )}
          {!loading && results.length > 0 && (
            <ul role="listbox">
              {results.map((task, i) => (
                <li key={task.id} role="option" aria-selected={i === selectedIdx}>
                  <button
                    onClick={() => navigate(task)}
                    className={`w-full text-left px-4 py-2.5 flex items-start gap-2.5 text-sm transition-colors hover:bg-muted ${i === selectedIdx ? "bg-muted" : ""}`}
                  >
                    <span className="mt-0.5">{taskTypeIcon(task)}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                        <span className="font-medium text-foreground truncate">{task.title}</span>
                        <StatusBadge status={getDisplayStatus({ status: task.status, isEnabled: task.isEnabled ?? true })} />
                      </div>
                      {task.description && (
                        <p className="text-muted-foreground text-xs truncate">{task.description}</p>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
