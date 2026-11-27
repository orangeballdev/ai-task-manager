"use client";

import { useState, useEffect } from "react";
import { Folder, ChevronRight, Home, ArrowLeft, Check, FileText, X, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { getFileIcon } from "@/lib/file-icons";
import type { TaskContextFile } from "@/lib/types";

export interface ContextFileSelectorRepo {
  url: string;
  alias: string;
  branch?: string;
}

interface ContextFileSelectorProps {
  /** Currently selected context files. */
  value: TaskContextFile[];
  onChange: (files: TaskContextFile[]) => void;
  /** Repos available to browse. */
  repos: ContextFileSelectorRepo[];
}

interface TreeEntry {
  name: string;
  type: "tree" | "blob";
}

/**
 * Lets the user pick files from one of the task's configured git repositories
 * to include as read-only context in the agent prompt. Uses the same
 * `/api/git/tree` endpoint the folder selector uses, but treats files as the
 * primary selectable entity rather than folders.
 *
 * Selected files are displayed as chips (repoAlias:path) with a remove button.
 * A dialog lets the user browse the repo tree and check files to include.
 */
export function ContextFileSelector({ value, onChange, repos }: ContextFileSelectorProps) {
  const [open, setOpen] = useState(false);
  const usableRepos = repos.filter((r) => r.url && r.url.trim());

  function removeFile(file: TaskContextFile) {
    onChange(value.filter((f) => !(f.repoAlias === file.repoAlias && f.path === file.path)));
  }

  return (
    <div className="flex flex-col gap-2">
      {value.length > 0 && (
        <ul className="flex flex-col gap-1">
          {value.map((file) => (
            <li
              key={`${file.repoAlias}:${file.path}`}
              className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/40 px-2 py-1.5 text-sm"
            >
              {getFileIcon({ name: file.path.split("/").pop() ?? file.path, type: "file" }, "size-3.5 shrink-0")}
              <div className="flex flex-col min-w-0 flex-1">
                <span className="truncate font-mono text-xs">{file.path}</span>
                {file.repoAlias && (
                  <span className="truncate text-[10px] text-muted-foreground uppercase tracking-wider">
                    {file.repoAlias}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => removeFile(file)}
                aria-label={`Remove ${file.path}`}
                className="text-muted-foreground hover:text-foreground shrink-0 p-0.5 rounded hover:bg-muted transition-colors"
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        disabled={usableRepos.length === 0}
        className="w-fit flex items-center gap-1.5"
        title={usableRepos.length === 0 ? "Add a repository first to browse for files" : "Browse repo files"}
      >
        <Plus size={13} />
        {value.length > 0 ? "Add another file" : "Add context file"}
      </Button>

      {usableRepos.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Add a git repository below to browse files from it.
        </p>
      )}

      {open && usableRepos.length > 0 && (
        <ContextFileBrowserDialog
          repos={usableRepos}
          alreadySelected={value}
          onClose={() => setOpen(false)}
          onConfirm={(files) => {
            // Merge in new selections, dedupe by (repoAlias, path)
            const merged = [...value];
            for (const f of files) {
              if (!merged.some((m) => m.repoAlias === f.repoAlias && m.path === f.path)) {
                merged.push(f);
              }
            }
            onChange(merged);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

function ContextFileBrowserDialog({
  repos,
  alreadySelected,
  onClose,
  onConfirm,
}: {
  repos: ContextFileSelectorRepo[];
  alreadySelected: TaskContextFile[];
  onClose: () => void;
  onConfirm: (files: TaskContextFile[]) => void;
}) {
  const [selectedRepoIdx, setSelectedRepoIdx] = useState(0);
  const repo = repos[selectedRepoIdx];
  const [currentPath, setCurrentPath] = useState<string>("");
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingFiles, setPendingFiles] = useState<TaskContextFile[]>([]);

  const segments = currentPath.split("/").filter(Boolean);

  useEffect(() => {
    if (!repo) return;
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
        setError(err instanceof Error ? err.message : "Failed to load files");
        setEntries([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [repo, currentPath]);

  function navigateInto(name: string) {
    const next = [currentPath, name].filter(Boolean).join("/");
    setCurrentPath(next);
  }

  function navigateTo(idx: number) {
    if (idx < 0) { setCurrentPath(""); return; }
    setCurrentPath(segments.slice(0, idx + 1).join("/"));
  }

  function goUp() {
    if (!segments.length) return;
    setCurrentPath(segments.slice(0, -1).join("/"));
  }

  function toggleFile(name: string) {
    if (!repo) return;
    const filePath = [currentPath, name].filter(Boolean).join("/");
    const entry: TaskContextFile = { repoAlias: repo.alias, path: filePath };
    const isPending = pendingFiles.some((f) => f.repoAlias === entry.repoAlias && f.path === entry.path);
    if (isPending) {
      setPendingFiles(pendingFiles.filter((f) => !(f.repoAlias === entry.repoAlias && f.path === entry.path)));
    } else {
      setPendingFiles([...pendingFiles, entry]);
    }
  }

  function isFilePending(name: string): boolean {
    if (!repo) return false;
    const filePath = [currentPath, name].filter(Boolean).join("/");
    return pendingFiles.some((f) => f.repoAlias === repo.alias && f.path === filePath);
  }

  function isFileAlreadySelected(name: string): boolean {
    if (!repo) return false;
    const filePath = [currentPath, name].filter(Boolean).join("/");
    return alreadySelected.some((f) => f.repoAlias === repo.alias && f.path === filePath);
  }

  const folderEntries = entries.filter((e) => e.type === "tree");
  const fileEntries = entries.filter((e) => e.type === "blob");

  return (
    <Dialog open={true} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent showClose={false} className="!max-w-xl !p-0 overflow-hidden">
        {/* Title bar */}
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
            Add Context Files
          </DialogTitle>
        </div>

        {/* Toolbar — back, breadcrumbs, repo picker */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-card">
          <button
            type="button"
            onClick={goUp}
            disabled={segments.length === 0}
            className="p-1 rounded hover:bg-accent disabled:opacity-30 disabled:cursor-not-allowed text-muted-foreground hover:text-foreground transition-colors"
            title="Go up one level"
          >
            <ArrowLeft size={14} />
          </button>

          <button
            type="button"
            onClick={() => navigateTo(-1)}
            className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
            title="Go to root"
          >
            <Home size={13} />
          </button>

          <div className="flex-1 flex items-center gap-1 px-2 py-1 rounded-md bg-muted/60 text-xs min-w-0 overflow-x-auto">
            <button
              type="button"
              onClick={() => navigateTo(-1)}
              className="flex items-center gap-1 text-foreground/80 hover:text-foreground"
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
                  className="text-foreground/80 hover:text-foreground truncate"
                >
                  {seg}
                </button>
              </div>
            ))}
          </div>

          {repos.length > 1 && (
            <select
              value={selectedRepoIdx}
              onChange={(e) => {
                setSelectedRepoIdx(Number(e.target.value));
                setCurrentPath("");
              }}
              className="text-xs rounded border border-input bg-background px-1.5 py-1 max-w-32"
            >
              {repos.map((r, i) => (
                <option key={r.url} value={i}>{r.alias || r.url}</option>
              ))}
            </select>
          )}
        </div>

        {/* Body — folder + file list */}
        <div className="min-h-72 max-h-96 overflow-y-auto bg-background">
          {loading ? (
            <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
              Loading files…
            </div>
          ) : (
            <div className="py-1">
              {error && (
                <div className="px-3 py-2 text-xs text-yellow-600 dark:text-yellow-400 bg-yellow-500/5 border-b border-border/50">
                  {error.length > 200 ? error.slice(0, 200) + "…" : error}
                </div>
              )}

              {entries.length === 0 && !error && (
                <div className="px-3 py-8 text-center text-xs text-muted-foreground">
                  This folder is empty.
                </div>
              )}

              {folderEntries.map((entry) => (
                <button
                  key={entry.name}
                  type="button"
                  onClick={() => navigateInto(entry.name)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent/60 transition-colors text-left"
                >
                  <Folder size={14} className="text-amber-500 shrink-0" fill="currentColor" fillOpacity={0.2} />
                  <span className="flex-1 truncate font-medium">{entry.name}</span>
                  <ChevronRight size={12} className="text-muted-foreground shrink-0" />
                </button>
              ))}

              {fileEntries.length > 0 && folderEntries.length > 0 && (
                <div className="border-t border-border/40 my-1" />
              )}

              {fileEntries.map((entry) => {
                const pending = isFilePending(entry.name);
                const already = isFileAlreadySelected(entry.name);
                return (
                  <button
                    key={entry.name}
                    type="button"
                    onClick={() => !already && toggleFile(entry.name)}
                    disabled={already}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors ${
                      already
                        ? "text-muted-foreground/60 cursor-not-allowed"
                        : pending
                        ? "bg-primary/10 text-foreground hover:bg-primary/15"
                        : "text-foreground/90 hover:bg-accent/60"
                    }`}
                    title={already ? "Already added" : pending ? "Click to unselect" : "Click to add"}
                  >
                    <span
                      className={`flex items-center justify-center size-4 rounded border shrink-0 ${
                        pending || already
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-muted-foreground/40 bg-background"
                      }`}
                    >
                      {(pending || already) && <Check size={10} strokeWidth={3} />}
                    </span>
                    {getFileIcon({ name: entry.name, type: "file" }, "size-3.5 shrink-0")}
                    <span className="flex-1 truncate">{entry.name}</span>
                    {already && (
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60 shrink-0">
                        added
                      </span>
                    )}
                  </button>
                );
              })}

              {folderEntries.length === 0 && fileEntries.length === 0 && !error && (
                <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                  <FileText size={16} className="mx-auto mb-1 opacity-50" />
                  No files here.
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-t border-border bg-muted/30">
          <span className="text-xs text-muted-foreground">
            {pendingFiles.length === 0
              ? "Click files to select them"
              : `${pendingFiles.length} file${pendingFiles.length === 1 ? "" : "s"} selected`}
          </span>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose} className="h-7 text-xs">
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => onConfirm(pendingFiles)}
              disabled={pendingFiles.length === 0}
              className="h-7 text-xs gap-1"
            >
              <Check size={12} />
              Add {pendingFiles.length > 0 ? `${pendingFiles.length} ` : ""}file{pendingFiles.length === 1 ? "" : "s"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
