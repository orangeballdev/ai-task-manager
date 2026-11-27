"use client";

import { useState, useEffect, useRef } from "react";
import { Folder, FolderOpen, ChevronRight, Home, ArrowLeft, Check, X, FileText, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";

export interface FolderSelectorRepo {
  url: string;
  alias: string;
  branch?: string;
}

interface FolderSelectorProps {
  /** Current selected folder path (relative to repo/workspace root). Empty / undefined == root. */
  value: string;
  onChange: (path: string) => void;
  /** Repos available to browse. The first non-empty one drives the folder tree. */
  repos?: FolderSelectorRepo[];
  /** Optional label shown in the picker dialog when no repo is available. */
  placeholder?: string;
}

interface TreeEntry {
  name: string;
  type: "tree" | "blob";
}

/**
 * Mac-Finder-style folder selector.
 *
 * The trigger is a styled "path bar" mirroring macOS's Finder location bar:
 * folder icons + chevron-separated breadcrumbs. Click it to open a dialog
 * that lets the user navigate the directory tree of the first configured
 * repo (or type a custom path).
 */
export function FolderSelector({ value, onChange, repos = [], placeholder }: FolderSelectorProps) {
  const [open, setOpen] = useState(false);

  const segments = value.split("/").filter(Boolean);
  const usableRepos = repos.filter((r) => r.url && r.url.trim());

  // If the stored path begins with one of the repo aliases, the first segment
  // is just navigation context — strip it for the trigger display so the
  // breadcrumb shows "docs / screenshots" rather than "my-repo / docs / screenshots".
  const matchingRepo = segments.length > 0
    ? usableRepos.find((r) => r.alias === segments[0])
    : undefined;
  const displaySegments = matchingRepo ? segments.slice(1) : segments;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group w-full flex items-center gap-1.5 rounded-md border border-input bg-background hover:bg-accent/40 transition-colors px-2.5 py-1.5 text-sm text-left min-h-9"
        title={value || "(repository root)"}
      >
        <FolderOpen size={14} className="text-muted-foreground shrink-0" />
        {segments.length === 0 ? (
          <span className="text-muted-foreground italic">{usableRepos.length > 0 ? "Repository root" : "Workspace root"}</span>
        ) : (
          <div className="flex items-center gap-1 flex-1 min-w-0 overflow-hidden">
            {matchingRepo && (
              <>
                <span className="truncate text-muted-foreground text-xs">{matchingRepo.alias}</span>
                {displaySegments.length > 0 && <ChevronRight size={11} className="text-muted-foreground/60 shrink-0" />}
              </>
            )}
            {displaySegments.map((seg, i) => (
              <div key={i} className="flex items-center gap-1 min-w-0">
                {i > 0 && <ChevronRight size={11} className="text-muted-foreground/60 shrink-0" />}
                <span className="truncate text-foreground/90 font-medium">{seg}</span>
              </div>
            ))}
            {!matchingRepo && displaySegments.length === 0 && (
              <span className="text-muted-foreground italic">Workspace root</span>
            )}
          </div>
        )}
        <span className="ml-auto text-[10px] uppercase tracking-wider text-muted-foreground/70 shrink-0 group-hover:text-foreground/80">
          Browse
        </span>
      </button>

      {open && (
        <FolderBrowserDialog
          initialValue={value}
          repos={repos}
          placeholder={placeholder}
          onClose={() => setOpen(false)}
          onConfirm={(path) => {
            onChange(path);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

function FolderBrowserDialog({
  initialValue,
  repos,
  placeholder,
  onClose,
  onConfirm,
}: {
  initialValue: string;
  repos: FolderSelectorRepo[];
  placeholder?: string;
  onClose: () => void;
  onConfirm: (path: string) => void;
}) {
  const usableRepos = repos.filter((r) => r.url && r.url.trim());

  // Strip any leading repo-alias segment from the stored path before seeding
  // the browser, so the picker shows the path relative to the repo root.
  const rawInitial = initialValue.replace(/^\/+|\/+$/g, "");
  const initialSegments = rawInitial.split("/").filter(Boolean);
  const matchingInitialRepoIdx = initialSegments.length > 0
    ? usableRepos.findIndex((r) => r.alias === initialSegments[0])
    : -1;
  const seedRepoIdx = matchingInitialRepoIdx >= 0 ? matchingInitialRepoIdx : 0;
  const seedPath = matchingInitialRepoIdx >= 0 ? initialSegments.slice(1).join("/") : rawInitial;

  const [selectedRepoIdx, setSelectedRepoIdx] = useState(seedRepoIdx);
  const repo = usableRepos[selectedRepoIdx];

  // `currentPath` is what the user is currently *browsing* (relative to repo root).
  // `selectedPath` is the folder they've decided to confirm.
  const [currentPath, setCurrentPath] = useState<string>(seedPath);
  const [selectedPath, setSelectedPath] = useState<string>(seedPath);
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualMode, setManualMode] = useState(!usableRepos.length);
  const [manualPath, setManualPath] = useState<string>(initialValue);
  const [newFolderInput, setNewFolderInput] = useState<string>("");
  const [showNewFolder, setShowNewFolder] = useState(false);
  const newFolderRef = useRef<HTMLInputElement>(null);

  const segments = currentPath.split("/").filter(Boolean);

  // Fetch the directory listing whenever the user changes folder or repo.
  // Uses an async runner inside the effect so we satisfy
  // react-hooks/set-state-in-effect: the initial state mutation happens
  // via Promise.resolve().then(...), not synchronously inside the effect body.
  useEffect(() => {
    if (manualMode || !repo) return;
    let cancelled = false;
    const params = new URLSearchParams({ url: repo.url, path: currentPath });
    if (repo.branch) params.set("branch", repo.branch);
    Promise.resolve().then(async () => {
      if (cancelled) return;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/git/tree?${params.toString()}`);
        const data = (await res.json()) as { entries?: TreeEntry[]; error?: string };
        if (cancelled) return;
        setEntries(data.entries ?? []);
        if (data.error && !data.entries?.length) {
          setError(data.error);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load folders");
        setEntries([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [manualMode, repo, currentPath]);

  useEffect(() => {
    if (showNewFolder) {
      // focus immediately after the input is mounted
      setTimeout(() => newFolderRef.current?.focus(), 30);
    }
  }, [showNewFolder]);

  function navigateInto(folderName: string) {
    const next = [currentPath, folderName].filter(Boolean).join("/");
    setCurrentPath(next);
    setSelectedPath(next);
  }

  function navigateTo(idx: number) {
    // -1 == root
    if (idx < 0) {
      setCurrentPath("");
      setSelectedPath("");
      return;
    }
    const next = segments.slice(0, idx + 1).join("/");
    setCurrentPath(next);
    setSelectedPath(next);
  }

  function goUp() {
    if (!segments.length) return;
    const next = segments.slice(0, -1).join("/");
    setCurrentPath(next);
    setSelectedPath(next);
  }

  function confirm() {
    if (manualMode) {
      onConfirm(manualPath.trim().replace(/^\/+|\/+$/g, ""));
      return;
    }
    const cleanedSelected = selectedPath.replace(/^\/+|\/+$/g, "");
    // Persist the chosen repo's alias as the path prefix so the worker (which
    // operates from the workspace root) can resolve the destination
    // unambiguously when multiple repos are attached.
    const finalPath = repo
      ? [repo.alias, cleanedSelected].filter(Boolean).join("/")
      : cleanedSelected;
    onConfirm(finalPath);
  }

  function addNewFolder() {
    const name = newFolderInput.trim().replace(/^\/+|\/+$/g, "");
    if (!name) return;
    // Treat the typed name as a possibly-nested path (e.g. "docs/screenshots")
    const next = [currentPath, name].filter(Boolean).join("/");
    setCurrentPath(next);
    setSelectedPath(next);
    setNewFolderInput("");
    setShowNewFolder(false);
  }

  const folderEntries = entries.filter((e) => e.type === "tree");
  const fileEntries = entries.filter((e) => e.type === "blob");

  return (
    <Dialog open={true} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent showClose={false} className="!max-w-xl !p-0 overflow-hidden">
        {/* Title bar — Mac-window style */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/40">
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={onClose}
              className="size-3 rounded-full bg-red-500/80 hover:bg-red-500 transition-colors"
              aria-label="Close"
            />
            <span className="size-3 rounded-full bg-yellow-500/60" />
            <span className="size-3 rounded-full bg-green-500/60" />
          </div>
          <DialogTitle className="text-xs font-medium text-foreground/80 mx-auto pr-12">
            Choose Folder
          </DialogTitle>
        </div>

        {/* Toolbar — back button, breadcrumb path, repo picker */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-card">
          <button
            type="button"
            onClick={goUp}
            disabled={manualMode || segments.length === 0}
            className="p-1 rounded hover:bg-accent disabled:opacity-30 disabled:cursor-not-allowed text-muted-foreground hover:text-foreground transition-colors"
            title="Go up one level"
          >
            <ArrowLeft size={14} />
          </button>

          <button
            type="button"
            onClick={() => navigateTo(-1)}
            disabled={manualMode}
            className="p-1 rounded hover:bg-accent disabled:opacity-30 disabled:cursor-not-allowed text-muted-foreground hover:text-foreground transition-colors"
            title="Go to root"
          >
            <Home size={13} />
          </button>

          {/* Breadcrumb path */}
          <div className="flex-1 flex items-center gap-1 px-2 py-1 rounded-md bg-muted/60 text-xs min-w-0 overflow-x-auto">
            <button
              type="button"
              onClick={() => navigateTo(-1)}
              disabled={manualMode}
              className="flex items-center gap-1 text-foreground/80 hover:text-foreground disabled:cursor-not-allowed"
            >
              <Folder size={11} className="text-amber-500" />
              <span className="font-medium">{repo?.alias || "root"}</span>
            </button>
            {segments.map((seg, i) => (
              <div key={i} className="flex items-center gap-1 min-w-0">
                <ChevronRight size={10} className="text-muted-foreground shrink-0" />
                <button
                  type="button"
                  onClick={() => navigateTo(i)}
                  disabled={manualMode}
                  className="text-foreground/80 hover:text-foreground disabled:cursor-not-allowed truncate"
                >
                  {seg}
                </button>
              </div>
            ))}
          </div>

          {usableRepos.length > 1 && (
            <select
              value={selectedRepoIdx}
              onChange={(e) => { setSelectedRepoIdx(Number(e.target.value)); setCurrentPath(""); setSelectedPath(""); }}
              className="text-xs rounded border border-input bg-background px-1.5 py-1 max-w-32"
            >
              {usableRepos.map((r, i) => (
                <option key={r.url} value={i}>{r.alias || r.url}</option>
              ))}
            </select>
          )}
        </div>

        {/* Body — folder list or manual entry */}
        <div className="min-h-72 max-h-96 overflow-y-auto bg-background">
          {manualMode ? (
            <div className="p-4 flex flex-col gap-3">
              <div className="text-xs text-muted-foreground">
                {usableRepos.length === 0
                  ? (placeholder ?? "No repository attached yet. Enter a folder path manually. Leave blank to use the workspace root.")
                  : "Enter a folder path manually. Leave blank to use the repository root."}
              </div>
              <Input
                value={manualPath}
                onChange={(e) => setManualPath(e.target.value)}
                placeholder="e.g. docs/screenshots"
                className="font-mono text-sm"
                autoFocus
              />
              <div className="text-[11px] text-muted-foreground/80 leading-relaxed">
                The folder will be created inside the workspace when the task runs if it doesn&apos;t already exist.
              </div>
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
              Loading folders…
            </div>
          ) : (
            <div className="py-1">
              {/* "Use current folder" indicator row */}
              <div className="px-3 py-1.5 flex items-center gap-2 border-b border-border/50 bg-muted/20">
                <Check size={12} className="text-primary" />
                <span className="text-xs text-muted-foreground">Selected: </span>
                <span className="text-xs font-mono font-medium text-foreground">
                  {selectedPath || "(repository root)"}
                </span>
              </div>

              {/* New folder input */}
              {showNewFolder ? (
                <div className="px-3 py-2 flex items-center gap-2 border-b border-border/50 bg-primary/5">
                  <Folder size={14} className="text-amber-500 shrink-0" />
                  <Input
                    ref={newFolderRef}
                    value={newFolderInput}
                    onChange={(e) => setNewFolderInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); addNewFolder(); }
                      else if (e.key === "Escape") { setShowNewFolder(false); setNewFolderInput(""); }
                    }}
                    placeholder="New folder name"
                    className="h-7 text-xs font-mono flex-1"
                  />
                  <button
                    type="button"
                    onClick={addNewFolder}
                    className="text-xs text-primary hover:text-primary/80 font-medium"
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowNewFolder(false); setNewFolderInput(""); }}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X size={12} />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowNewFolder(true)}
                  className="w-full px-3 py-1.5 flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors border-b border-border/50"
                >
                  <Plus size={12} />
                  <span>New folder here</span>
                </button>
              )}

              {error && (
                <div className="px-3 py-2 text-xs text-yellow-600 dark:text-yellow-400 bg-yellow-500/5 border-b border-border/50">
                  {error.length > 200 ? error.slice(0, 200) + "…" : error}
                </div>
              )}

              {entries.length === 0 && !loading && !error && (
                <div className="px-3 py-8 text-center text-xs text-muted-foreground">
                  This folder is empty.
                </div>
              )}

              {folderEntries.map((entry) => (
                <button
                  key={entry.name}
                  type="button"
                  onDoubleClick={() => navigateInto(entry.name)}
                  onClick={() => {
                    const next = [currentPath, entry.name].filter(Boolean).join("/");
                    setSelectedPath(next);
                  }}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent/60 transition-colors text-left ${
                    selectedPath === [currentPath, entry.name].filter(Boolean).join("/")
                      ? "bg-primary/10 text-foreground"
                      : "text-foreground/90"
                  }`}
                >
                  <Folder size={14} className="text-amber-500 shrink-0" fill="currentColor" fillOpacity={0.2} />
                  <span className="flex-1 truncate font-medium">{entry.name}</span>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); navigateInto(entry.name); }}
                    className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
                    title="Open folder"
                  >
                    <ChevronRight size={12} />
                  </button>
                </button>
              ))}

              {fileEntries.length > 0 && (
                <>
                  {folderEntries.length > 0 && <div className="border-t border-border/40 my-1" />}
                  {fileEntries.map((entry) => (
                    <div
                      key={entry.name}
                      className="w-full flex items-center gap-2 px-3 py-1 text-xs text-muted-foreground/60 select-none"
                    >
                      <FileText size={12} className="shrink-0" />
                      <span className="flex-1 truncate">{entry.name}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-t border-border bg-muted/30">
          <button
            type="button"
            onClick={() => setManualMode((m) => !m)}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {manualMode ? "← Browse folders" : "Type path manually →"}
          </button>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose} className="h-7 text-xs">
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={confirm} className="h-7 text-xs gap-1">
              <Check size={12} />
              Choose
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
