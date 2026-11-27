"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  Folder,
  FolderOpen,
  ChevronRight,
  LayoutList,
  LayoutGrid,
  ArrowLeft,
  RefreshCw,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { FileContentView } from "@/components/FileContentView";
import {
  useFilesViewMode,
  setFilesViewMode,
} from "@/lib/use-layout-preferences";
import { getFileIcon } from "@/lib/file-icons";

interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  ext?: string;
  modifiedAt?: string;
}

interface FileBrowserProps {
  taskId: string;
  taskTitle: string;
  initialPath?: string;
}

function formatSize(bytes?: number): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso?: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

type ViewState =
  | { mode: "directory"; path: string }
  | { mode: "file"; path: string };

function FileViewer({ taskId, filePath }: { taskId: string; filePath: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [ext, setExt] = useState<string>("");

  // Keyed by task + path in the parent, so each file starts from a fresh
  // loading state and this only has to fetch.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/tasks/${taskId}/files/content?path=${encodeURIComponent(filePath)}`)
      .then((r) => r.json())
      .then((data: { content?: string; error?: string; ext?: string }) => {
        if (cancelled) return;
        if (data.error) {
          setError(data.error);
        } else {
          setContent(data.content ?? "");
          setExt(data.ext ?? "");
        }
      })
      .catch(() => { if (!cancelled) setError("Failed to load file"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [taskId, filePath]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground text-sm p-4">
        <RefreshCw className="size-4 animate-spin mr-2" />
        Loading file…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 py-8 px-6 text-sm text-destructive">
        <AlertCircle className="size-4 shrink-0" />
        {error}
      </div>
    );
  }

  if (content === null) return null;

  const fileName = filePath.split("/").pop() ?? "";

  return <FileContentView content={content} fileName={fileName} ext={ext} showLabel={false} />;
}

export function FileBrowser({ taskId, taskTitle, initialPath = "" }: FileBrowserProps) {
  const viewMode = useFilesViewMode();
  const [viewState, setViewState] = useState<ViewState>({
    mode: "directory",
    path: initialPath,
  });
  // The last directory listing, tagged with the task + path it belongs to.
  // While a different directory is being fetched the old entries stay put
  // (behind the loading state) and any old error is hidden.
  const [listing, setListing] = useState<{ key: string; entries: FileEntry[]; error: string | null } | null>(null);
  const dirKey = viewState.mode === "directory" ? `${taskId}:${viewState.path}` : null;
  const loading = dirKey !== null && listing?.key !== dirKey;
  const entries = listing?.entries ?? [];
  const error = loading ? null : listing?.error ?? null;

  useEffect(() => {
    if (viewState.mode !== "directory") return;
    const key = `${taskId}:${viewState.path}`;
    let cancelled = false;
    fetch(`/api/tasks/${taskId}/files?path=${encodeURIComponent(viewState.path)}`)
      .then(async (res) => {
        const data = (await res.json()) as { entries?: FileEntry[]; error?: string };
        if (cancelled) return;
        if (!res.ok || data.error) {
          setListing({ key, entries: [], error: data.error ?? "Failed to load directory" });
        } else {
          setListing({ key, entries: data.entries ?? [], error: null });
        }
      })
      .catch(() => {
        if (!cancelled) setListing((prev) => ({ key, entries: prev?.entries ?? [], error: "Failed to load directory" }));
      });
    return () => { cancelled = true; };
  }, [taskId, viewState]);

  function navigateTo(entry: FileEntry) {
    if (entry.type === "directory") {
      setViewState({ mode: "directory", path: entry.path });
    } else {
      setViewState({ mode: "file", path: entry.path });
    }
  }

  function navigateUp() {
    const currentPath = viewState.path;
    if (!currentPath) return;
    const parts = currentPath.split("/").filter(Boolean);
    parts.pop();
    const parentPath = parts.join("/");
    setViewState({ mode: "directory", path: parentPath });
  }

  // Build breadcrumb segments from current path
  const currentPath = viewState.path;
  const pathParts = currentPath.split("/").filter(Boolean);

  // Current file/directory name (last segment)
  const currentName = pathParts[pathParts.length - 1] ?? null;
  const isRoot = pathParts.length === 0;
  const isFile = viewState.mode === "file";

  // For the file view, the parent directory path
  const parentPath = isFile
    ? pathParts.slice(0, -1).join("/")
    : pathParts.slice(0, -1).join("/");

  return (
    <div className="flex flex-col gap-4">
      {/* Breadcrumbs + view toggle */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5 min-w-0">
          {/* Breadcrumb row */}
          <nav className="flex items-center flex-wrap gap-1 text-sm text-muted-foreground">
            <Link
              href={`/tasks/${taskId}`}
              className="hover:text-foreground transition-colors shrink-0"
            >
              {taskTitle}
            </Link>
            <ChevronRight className="size-3.5 shrink-0" />
            <button
              onClick={() => setViewState({ mode: "directory", path: "" })}
              className="hover:text-foreground transition-colors shrink-0"
            >
              Files
            </button>
            {pathParts.slice(0, isFile ? -1 : undefined).map((part, idx) => {
              const partPath = pathParts.slice(0, idx + 1).join("/");
              const isLastDir = !isFile && idx === pathParts.length - 1;
              return (
                <span key={idx} className="flex items-center gap-1">
                  <ChevronRight className="size-3.5 shrink-0" />
                  {isLastDir ? (
                    <span className="text-foreground font-medium">{part}</span>
                  ) : (
                    <button
                      onClick={() => setViewState({ mode: "directory", path: partPath })}
                      className="hover:text-foreground transition-colors"
                    >
                      {part}
                    </button>
                  )}
                </span>
              );
            })}
            {isFile && pathParts.length > 0 && (
              <span className="flex items-center gap-1">
                <ChevronRight className="size-3.5 shrink-0" />
              </span>
            )}
          </nav>

          {/* File/dir name on its own line for spacing */}
          {(isFile || (!isRoot && !isFile)) && currentName && (
            <div className="mt-1">
              {isFile ? (
                <div className="flex items-center gap-2">
                  {getFileIcon({ name: currentName, type: "file" }, "size-4")}
                  <h1 className="text-lg font-semibold text-foreground">{currentName}</h1>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <FolderOpen className="size-4 text-yellow-400" />
                  <h1 className="text-lg font-semibold text-foreground">{currentName}</h1>
                </div>
              )}
            </div>
          )}
          {isRoot && (
            <h1 className="text-lg font-semibold text-foreground mt-1">Workspace Files</h1>
          )}
        </div>

        {/* View toggle — only show on directory views */}
        {!isFile && (
          <div className="flex items-center gap-1 shrink-0 mt-1">
            <Button
              size="sm"
              variant={viewMode === "list" ? "default" : "ghost"}
              className="h-7 w-7 p-0"
              onClick={() => setFilesViewMode("list")}
              title="List view"
            >
              <LayoutList className="size-3.5" />
            </Button>
            <Button
              size="sm"
              variant={viewMode === "icons" ? "default" : "ghost"}
              className="h-7 w-7 p-0"
              onClick={() => setFilesViewMode("icons")}
              title="Icon view"
            >
              <LayoutGrid className="size-3.5" />
            </Button>
          </div>
        )}
      </div>

      {/* Back button for file view */}
      {isFile && (
        <Button
          variant="ghost"
          size="sm"
          className="self-start -ml-1 gap-1.5 text-muted-foreground hover:text-foreground"
          onClick={() => setViewState({ mode: "directory", path: parentPath })}
        >
          <ArrowLeft className="size-3.5" />
          Back
        </Button>
      )}

      {/* Content area */}
      {isFile ? (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <FileViewer key={`${taskId}:${viewState.path}`} taskId={taskId} filePath={viewState.path} />
        </div>
      ) : loading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
          <RefreshCw className="size-4 animate-spin mr-2" />
          Loading…
        </div>
      ) : error ? (
        <div className="flex items-center gap-2 py-8 text-sm text-destructive">
          <AlertCircle className="size-4 shrink-0" />
          {error}
        </div>
      ) : entries.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          This directory is empty.
        </div>
      ) : viewMode === "list" ? (
        /* List view */
        <div className="rounded-lg border border-border overflow-hidden">
          {/* Header */}
          <div className="grid grid-cols-[1fr_auto_auto] gap-4 px-4 py-2 bg-muted/30 border-b border-border text-xs text-muted-foreground font-medium uppercase tracking-wide">
            <span>Name</span>
            <span className="text-right">Size</span>
            <span className="text-right w-24">Modified</span>
          </div>
          {/* Back entry */}
          {!isRoot && (
            <button
              onClick={navigateUp}
              className="w-full grid grid-cols-[1fr_auto_auto] gap-4 px-4 py-2.5 hover:bg-muted/30 transition-colors border-b border-border/50 text-left items-center"
            >
              <span className="flex items-center gap-2.5 text-sm text-muted-foreground">
                <Folder className="size-4 text-yellow-400/60 shrink-0" />
                ..
              </span>
              <span />
              <span className="w-24" />
            </button>
          )}
          {entries.map((entry) => (
            <button
              key={entry.path}
              onClick={() => navigateTo(entry)}
              className="w-full grid grid-cols-[1fr_auto_auto] gap-4 px-4 py-2.5 hover:bg-muted/30 transition-colors border-b border-border/50 last:border-b-0 text-left items-center"
            >
              <span className="flex items-center gap-2.5 text-sm text-card-foreground truncate">
                {getFileIcon(entry, "size-4")}
                <span className="truncate">{entry.name}</span>
                {entry.type === "directory" && (
                  <span className="text-xs text-muted-foreground/60">/</span>
                )}
              </span>
              <span className="text-xs text-muted-foreground text-right tabular-nums">
                {entry.type === "file" ? formatSize(entry.size) : ""}
              </span>
              <span className="text-xs text-muted-foreground text-right w-24 whitespace-nowrap">
                {formatDate(entry.modifiedAt)}
              </span>
            </button>
          ))}
        </div>
      ) : (
        /* Icon view */
        <div className="flex flex-col gap-2">
          {!isRoot && (
            <button
              onClick={navigateUp}
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors self-start"
            >
              <ArrowLeft className="size-3.5" />
              Up
            </button>
          )}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(100px,1fr))] sm:grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2">
            {entries.map((entry) => (
              <button
                key={entry.path}
                onClick={() => navigateTo(entry)}
                className="flex flex-col items-center gap-2 p-3 rounded-lg border border-border hover:border-foreground/30 hover:bg-muted/40 transition-all text-center group"
              >
                <div className="flex items-center justify-center w-12 h-12">
                  {entry.type === "directory" ? (
                    <Folder className="size-10 text-yellow-400" />
                  ) : (
                    getFileIcon(entry, "size-10")
                  )}
                </div>
                <span className="text-xs text-card-foreground truncate w-full px-1 group-hover:text-foreground transition-colors leading-tight">
                  {entry.name}
                </span>
                {entry.type === "file" && entry.size != null && (
                  <span className="text-[10px] text-muted-foreground/60">
                    {formatSize(entry.size)}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
