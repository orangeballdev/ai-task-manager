"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { searchSettings, type SettingsIndexEntry } from "./settings-index";

export default function SettingsSearch() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => searchSettings(query), [query]);

  // Every query change produces a new result set, so the highlight goes back
  // to the top result.
  function updateQuery(next: string) {
    setQuery(next);
    setActive(0);
  }

  // Close the dropdown when clicking outside.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  // "/" focuses the search box from anywhere on the settings pages.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "/" && document.activeElement !== inputRef.current) {
        const tag = (document.activeElement?.tagName ?? "").toLowerCase();
        if (tag === "input" || tag === "textarea") return;
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  function go(entry: SettingsIndexEntry) {
    const url = entry.anchor ? `${entry.href}#${entry.anchor}` : entry.href;
    router.push(url);
    setOpen(false);
    updateQuery("");
    inputRef.current?.blur();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const entry = results[active];
      if (entry) go(entry);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const showDropdown = open && query.trim().length > 0;

  return (
    <div ref={containerRef} className="relative mb-4">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            updateQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search settings…"
          aria-label="Search settings"
          className="w-full rounded-md border border-border bg-background py-2 pl-9 pr-9 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        {query && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              updateQuery("");
              inputRef.current?.focus();
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      {showDropdown && (
        <div className="absolute z-50 mt-1 max-h-80 w-full overflow-y-auto rounded-md border border-border bg-popover shadow-lg">
          {results.length === 0 ? (
            <div className="px-3 py-4 text-sm text-muted-foreground">
              No settings match &ldquo;{query}&rdquo;.
            </div>
          ) : (
            <ul role="listbox">
              {results.map((entry, i) => (
                <li key={`${entry.href}-${entry.anchor ?? i}`} role="option" aria-selected={i === active}>
                  <button
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onClick={() => go(entry)}
                    className={`flex w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors ${
                      i === active ? "bg-accent" : "hover:bg-accent/50"
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span className="text-sm font-medium">{entry.title}</span>
                      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {entry.section}
                      </span>
                    </span>
                    <span className="text-xs text-muted-foreground">{entry.description}</span>
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
