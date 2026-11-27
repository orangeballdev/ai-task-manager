"use client";

import { Fragment, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { FileText, Hash, Search } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { searchDocs, type DocsSearchEntry, type DocsSearchResult } from "@/lib/docs-search";

/** Wraps every occurrence of the query's terms in <mark>. */
function highlight(text: string, query: string): ReactNode {
  const terms = query.trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (terms.length === 0) return text;
  const re = new RegExp(`(${terms.join("|")})`, "gi");
  return text.split(re).map((part, i) =>
    i % 2 === 1
      ? <mark key={i} className="bg-primary/20 text-foreground rounded-sm">{part}</mark>
      : <Fragment key={i}>{part}</Fragment>,
  );
}

/**
 * Search box for the /docs pages. Opens with ⌘K / Ctrl+K anywhere under /docs (taking over from
 * the global task search in the nav, which ignores the shortcut once this has handled it).
 * The index is built on the server by docsSearchIndex() and searched in the browser.
 */
export function DocsSearch({ index }: { index: DocsSearchEntry[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // Set while closing to follow a result: focus then stays put instead of returning to the
  // trigger, which on narrow screens sits at the top of the page and would undo the jump.
  const navigatingRef = useRef(false);
  const deferredQuery = useDeferredValue(query);
  const results = useMemo(() => searchDocs(index, deferredQuery), [index, deferredQuery]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        // Listening on document (not window) runs this before NavSearch's window listener,
        // which skips events that are already handled.
        e.preventDefault();
        navigatingRef.current = false;
        setOpen(true);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Keep the highlighted result in view while moving through the list with the arrow keys.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  function setOpenState(next: boolean) {
    setOpen(next);
    if (next) {
      navigatingRef.current = false;
    } else {
      setQuery("");
      setSelected(0);
    }
  }

  function go(result: DocsSearchResult) {
    navigatingRef.current = true;
    setOpenState(false);
    router.push(result.href);
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((i) => Math.max(0, Math.min(i + 1, results.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = results[selected];
      if (hit) go(hit);
    }
  }

  const trimmed = deferredQuery.trim();

  return (
    <>
      <button
        type="button"
        onClick={() => setOpenState(true)}
        className="w-full flex items-center gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
        aria-label="Search docs (⌘K)"
      >
        <Search className="size-3.5 shrink-0" />
        <span className="flex-1 text-left">Search docs…</span>
        <kbd className="text-[10px] bg-muted px-1.5 py-0.5 rounded font-mono leading-none">⌘K</kbd>
      </button>

      <Dialog open={open} onOpenChange={setOpenState}>
        <DialogContent
          showClose={false}
          initialFocus={inputRef}
          finalFocus={() => !navigatingRef.current}
          className="top-[15%] translate-y-0 max-w-xl p-0 gap-0 overflow-hidden"
        >
          <DialogTitle className="sr-only">Search docs</DialogTitle>
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <Search className="size-4 text-muted-foreground shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setSelected(0); }}
              onKeyDown={onInputKeyDown}
              placeholder="Search the docs…"
              className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
              role="combobox"
              aria-expanded={results.length > 0}
              aria-controls="docs-search-results"
              aria-activedescendant={results[selected] ? `docs-search-result-${selected}` : undefined}
              autoComplete="off"
              spellCheck={false}
            />
            <kbd className="text-[10px] bg-muted px-1.5 py-0.5 rounded font-mono leading-none text-muted-foreground">Esc</kbd>
          </div>

          <div className="max-h-[60vh] overflow-y-auto">
            {!trimmed && (
              <p className="px-4 py-6 text-sm text-muted-foreground text-center">
                Search the API reference, MCP server and OpenAI / Anthropic-compatible API docs.
              </p>
            )}
            {trimmed && results.length === 0 && (
              <p className="px-4 py-6 text-sm text-muted-foreground text-center">
                No results for &quot;{trimmed}&quot;
              </p>
            )}
            {results.length > 0 && (
              <ul ref={listRef} id="docs-search-results" role="listbox" className="py-1">
                {results.map((r, i) => (
                  <li
                    key={`${r.href}-${r.entry.title}-${i}`}
                    id={`docs-search-result-${i}`}
                    data-index={i}
                    role="option"
                    aria-selected={i === selected}
                  >
                    <button
                      type="button"
                      tabIndex={-1}
                      onClick={() => go(r)}
                      onMouseMove={() => setSelected(i)}
                      className={`w-full text-left px-4 py-2.5 flex items-start gap-3 transition-colors ${i === selected ? "bg-muted" : ""}`}
                    >
                      {r.entry.title !== r.entry.page
                        ? <Hash className="size-4 mt-0.5 text-muted-foreground shrink-0" />
                        : <FileText className="size-4 mt-0.5 text-muted-foreground shrink-0" />}
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-muted-foreground truncate">
                          {[r.entry.page, ...r.entry.breadcrumbs].join(" › ")}
                        </div>
                        <div className="text-sm font-medium text-foreground truncate">
                          {highlight(r.entry.title, trimmed)}
                        </div>
                        {r.snippet && (
                          <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
                            {highlight(r.snippet, trimmed)}
                          </p>
                        )}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
