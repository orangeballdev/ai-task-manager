"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Folder,
  FolderOpen,
  Upload,
  FolderPlus,
  Trash2,
  Download,
  ChevronRight,
  Home,
  AlertCircle,
  RefreshCw,
  Search,
  X,
  PanelLeft,
  ListPlus,
  Shield,
  ShieldOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { getFileIcon, getFileExt } from "@/lib/file-icons";
import { useIsMobile } from "@/hooks/useIsMobile";

interface FileEntry {
  id: string;
  name: string;
  isFolder: boolean;
  mimeType?: string | null;
  size?: number | null;
  taskId: string | null;
  task: { id: string; title: string } | null;
  protected: boolean;
  updatedAt: string;
}

interface FolderNode {
  id: string;
  name: string;
  children: FolderNode[];
}

interface Breadcrumb {
  id: string;
  name: string;
}

function formatSize(bytes?: number | null): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isImageFile(entry: FileEntry): boolean {
  return (entry.mimeType ?? "").startsWith("image/");
}

interface FolderTreeItemProps {
  node: FolderNode;
  currentFolder: string | null;
  onNavigate: (id: string) => void;
  dragOverFolder: string | null;
  onDragOver: (id: string) => void;
  onDragLeave: () => void;
  onDrop: (targetFolderId: string) => void;
  level?: number;
}

function FolderTreeItem({
  node,
  currentFolder,
  onNavigate,
  dragOverFolder,
  onDragOver,
  onDragLeave,
  onDrop,
  level = 0,
}: FolderTreeItemProps) {
  const [expanded, setExpanded] = useState(false);
  const isActive = currentFolder === node.id;
  const isDragOver = dragOverFolder === node.id;

  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-1.5 px-2 py-1 rounded-md cursor-pointer text-sm transition-colors group select-none",
          isActive
            ? "bg-primary/10 text-primary"
            : "text-muted-foreground hover:text-foreground hover:bg-muted",
          isDragOver && "bg-blue-500/20 text-blue-400 ring-1 ring-blue-400/40",
        )}
        style={{ paddingLeft: `${(level + 1) * 12}px` }}
        onClick={() => {
          onNavigate(node.id);
          if (node.children.length > 0) setExpanded((v) => !v);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onDragOver(node.id);
        }}
        onDragLeave={(e) => {
          e.stopPropagation();
          onDragLeave();
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onDrop(node.id);
        }}
      >
        {node.children.length > 0 ? (
          <ChevronRight
            className={cn(
              "size-3 shrink-0 transition-transform text-muted-foreground/60",
              expanded && "rotate-90",
            )}
          />
        ) : (
          <span className="size-3 shrink-0" />
        )}
        {expanded && node.children.length > 0 ? (
          <FolderOpen className="size-4 shrink-0 text-amber-400" />
        ) : (
          <Folder className="size-4 shrink-0 text-amber-400" />
        )}
        <span className="truncate">{node.name}</span>
      </div>
      {expanded && node.children.length > 0 && (
        <div>
          {node.children.map((child) => (
            <FolderTreeItem
              key={child.id}
              node={child}
              currentFolder={currentFolder}
              onNavigate={onNavigate}
              dragOverFolder={dragOverFolder}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              level={level + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

async function fetchFolderListing(folderId: string | null): Promise<{ entries: FileEntry[]; breadcrumbs: Breadcrumb[] }> {
  const url = folderId ? `/api/files?parentId=${encodeURIComponent(folderId)}` : "/api/files";
  const res = await fetch(url);
  if (!res.ok) {
    const data = await res.json() as { error: string };
    throw new Error(data.error ?? "Failed to load files");
  }
  return await res.json() as { entries: FileEntry[]; breadcrumbs: Breadcrumb[] };
}

async function fetchFolderTree(folderId: string | null = null): Promise<FolderNode[]> {
  const url = folderId ? `/api/files?parentId=${encodeURIComponent(folderId)}` : "/api/files";
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json() as { entries: FileEntry[] };
  const folders = data.entries.filter((f) => f.isFolder);
  const nodes: FolderNode[] = [];
  for (const folder of folders) {
    const children = await fetchFolderTree(folder.id);
    nodes.push({ id: folder.id, name: folder.name, children });
  }
  return nodes;
}

export function FolderBrowser({ initialFolderId = null }: { initialFolderId?: string | null }) {
  const isMobile = useIsMobile();
  const router = useRouter();
  const [currentFolder, setCurrentFolder] = useState<string | null>(initialFolderId);
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([]);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [folderTree, setFolderTree] = useState<FolderNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Sidebar visibility — closed by default on mobile (acts as an overlay
  // drawer), open by default on desktop. The user can toggle it on either
  // platform, and their desktop choice is persisted to localStorage so the
  // sidebar stays where they left it across reloads.
  const SIDEBAR_STORAGE_KEY = "folderBrowser:sidebarOpen";
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Track previous mobile state so we only reset on a real breakpoint cross,
  // not every render — otherwise a manual toggle would be wiped out on resize.
  const prevIsMobileRef = useRef<boolean | null>(null);

  useEffect(() => {
    const prev = prevIsMobileRef.current;
    prevIsMobileRef.current = isMobile;

    const readDesktopDefault = () => {
      try {
        const stored = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
        return stored === null ? true : stored === "true";
      } catch {
        return true;
      }
    };

    if (prev === null) {
      setSidebarOpen(isMobile ? false : readDesktopDefault());
      return;
    }
    if (prev !== isMobile) {
      setSidebarOpen(isMobile ? false : readDesktopDefault());
    }
  }, [isMobile]);

  useEffect(() => {
    if (isMobile || prevIsMobileRef.current === null) return;
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarOpen));
    } catch {
      // ignore quota / privacy errors
    }
  }, [sidebarOpen, isMobile]);


  // Search across all files (ignores current folder while active)
  const [query, setQuery] = useState("");
  // The latest search answer and the query it answers. Results stay visible
  // while a newer query is in flight; clearing the query drops them.
  const [search, setSearch] = useState<{ q: string; entries: FileEntry[] | null } | null>(null);
  const trimmedQuery = query.trim();
  if (!trimmedQuery && search) setSearch(null);
  const searchResults = trimmedQuery ? search?.entries ?? null : null;
  const searching = trimmedQuery !== "" && search?.q !== trimmedQuery;

  // Drag state
  const [draggingItem, setDraggingItem] = useState<FileEntry | null>(null);
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  const [isDragOverDropZone, setIsDragOverDropZone] = useState(false);

  // Modals
  const [showNewFolderDialog, setShowNewFolderDialog] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Upload
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Context menu
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    entry: FileEntry;
  } | null>(null);

  const loadFiles = useCallback(async (folderId: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchFolderListing(folderId);
      setEntries(data.entries);
      setBreadcrumbs(data.breadcrumbs);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load files");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadFolderTree = useCallback(async () => {
    setFolderTree(await fetchFolderTree());
  }, []);

  // Opening another folder shows the loading state straight away (adjusted
  // during render, so the previous folder's error never flashes).
  const [listedFolder, setListedFolder] = useState(currentFolder);
  if (listedFolder !== currentFolder) {
    setListedFolder(currentFolder);
    setLoading(true);
    setError(null);
  }

  useEffect(() => {
    let cancelled = false;
    fetchFolderListing(currentFolder)
      .then((data) => {
        if (cancelled) return;
        setEntries(data.entries);
        setBreadcrumbs(data.breadcrumbs);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load files");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [currentFolder]);

  useEffect(() => {
    let cancelled = false;
    fetchFolderTree().then((tree) => {
      if (!cancelled) setFolderTree(tree);
    });
    return () => { cancelled = true; };
  }, []);

  // Debounced global search
  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    let cancelled = false;
    const handle = setTimeout(() => {
      fetch(`/api/files?q=${encodeURIComponent(q)}`)
        .then((r) => r.json() as Promise<{ entries: FileEntry[] }>)
        .then((data) => {
          if (!cancelled) setSearch({ q, entries: data.entries });
        })
        .catch(() => {
          if (cancelled) return;
          toast.error("Search failed");
          setSearch((prev) => ({ q, entries: prev?.entries ?? null }));
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query]);

  const navigate = useCallback((folderId: string | null) => {
    setCurrentFolder(folderId);
    setQuery("");
    // On mobile the sidebar is an overlay drawer — dismiss it once the user
    // has picked a folder so the file grid is visible again.
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);

  // Hide context menu on click elsewhere
  useEffect(() => {
    const handler = () => setContextMenu(null);
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, []);

  // --- Folder creation ---
  const createFolder = async () => {
    if (!newFolderName.trim()) return;
    setCreatingFolder(true);
    try {
      const res = await fetch("/api/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newFolderName.trim(), parentId: currentFolder }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to create folder");
      toast.success(`Folder "${newFolderName.trim()}" created`);
      setShowNewFolderDialog(false);
      setNewFolderName("");
      await loadFiles(currentFolder);
      await loadFolderTree();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create folder");
    } finally {
      setCreatingFolder(false);
    }
  };

  // --- File upload ---
  const uploadFiles = async (fileList: FileList | File[], targetFolderId = currentFolder) => {
    const filesToUpload = Array.from(fileList);
    if (!filesToUpload.length) return;
    setUploading(true);
    try {
      const formData = new FormData();
      filesToUpload.forEach((f) => formData.append("file", f));
      const url = targetFolderId
        ? `/api/files/upload?parentId=${encodeURIComponent(targetFolderId)}`
        : "/api/files/upload";
      const res = await fetch(url, { method: "POST", body: formData });
      const data = await res.json() as { error?: string; files?: unknown[] };
      if (!res.ok) throw new Error(data.error ?? "Upload failed");
      toast.success(
        `${filesToUpload.length} file${filesToUpload.length > 1 ? "s" : ""} uploaded`,
      );
      if (targetFolderId === currentFolder) await loadFiles(currentFolder);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // --- Delete ---
  const deleteEntry = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/files/${deleteTarget.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      toast.success(
        `${deleteTarget.isFolder ? "Folder" : "File"} "${deleteTarget.name}" deleted`,
      );
      setDeleteTarget(null);
      if (deleteTarget.isFolder && deleteTarget.id === currentFolder) {
        const parts = breadcrumbs.slice(0, -1);
        setCurrentFolder(parts.length ? parts[parts.length - 1]!.id : null);
      } else {
        await loadFiles(currentFolder);
      }
      await loadFolderTree();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  };

  // --- Protect / unprotect from automatic cleanup ---
  const toggleProtect = async (entry: FileEntry) => {
    const nextProtected = !entry.protected;
    try {
      const res = await fetch(`/api/files/${entry.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ protected: nextProtected }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to update");
      toast.success(
        nextProtected
          ? `"${entry.name}" is now protected from automatic cleanup${entry.isFolder ? " (including its contents)" : ""}`
          : `"${entry.name}" is no longer protected`,
      );
      await loadFiles(currentFolder);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update");
    }
  };

  // --- Drag and drop (items) ---
  const handleItemDragStart = (e: React.DragEvent, entry: FileEntry) => {
    setDraggingItem(entry);
    e.dataTransfer.setData("text/plain", entry.id);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleItemDragEnd = () => {
    setDraggingItem(null);
    setDragOverFolder(null);
  };

  const handleDropOnFolder = async (targetFolderId: string | null) => {
    setDragOverFolder(null);
    if (!draggingItem) return;
    if (draggingItem.id === targetFolderId) return;

    try {
      const res = await fetch(`/api/files/${draggingItem.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentId: targetFolderId }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Move failed");
      toast.success(`Moved "${draggingItem.name}"`);
      await loadFiles(currentFolder);
      await loadFolderTree();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Move failed");
    } finally {
      setDraggingItem(null);
    }
  };

  // Drop on the main area = move to current folder, or upload external files
  const handleDropOnMain = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOverDropZone(false);

    if (e.dataTransfer.files.length > 0 && !draggingItem) {
      await uploadFiles(e.dataTransfer.files);
      return;
    }

    if (draggingItem) {
      await handleDropOnFolder(currentFolder);
    }
  };

  // Drop on folder item in grid
  const handleDropOnFolderEntry = async (e: React.DragEvent, entry: FileEntry) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverFolder(null);

    if (e.dataTransfer.files.length > 0 && !draggingItem) {
      await uploadFiles(e.dataTransfer.files, entry.id);
      return;
    }

    if (draggingItem) {
      await handleDropOnFolder(entry.id);
    }
  };

  const displayedEntries = searchResults ?? entries;
  const isSearchMode = searchResults !== null;

  const sidebarBody = (
    <>
      <div className="p-3 border-b border-border flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-1">
          Folders
        </h2>
        {isMobile && (
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close folders"
            className="text-muted-foreground hover:text-foreground p-0.5"
          >
            <X className="size-4" />
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto py-2">
        {/* Root */}
        <div
          className={cn(
            "flex items-center gap-1.5 px-3 py-1 rounded-md cursor-pointer text-sm transition-colors mx-1 select-none",
            currentFolder === null
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:text-foreground hover:bg-muted",
            dragOverFolder === "root" && "bg-blue-500/20 text-blue-400 ring-1 ring-blue-400/40",
          )}
          onClick={() => navigate(null)}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOverFolder("root");
          }}
          onDragLeave={() => setDragOverFolder(null)}
          onDrop={(e) => {
            e.preventDefault();
            void handleDropOnFolder(null);
          }}
        >
          <Home className="size-4 shrink-0 text-muted-foreground" />
          <span>All Files</span>
        </div>

        {/* Folder tree */}
        {folderTree.map((node) => (
          <div key={node.id} className="mx-1">
            <FolderTreeItem
              node={node}
              currentFolder={currentFolder}
              onNavigate={navigate}
              dragOverFolder={dragOverFolder}
              onDragOver={setDragOverFolder}
              onDragLeave={() => setDragOverFolder(null)}
              onDrop={(targetFolder) => void handleDropOnFolder(targetFolder)}
            />
          </div>
        ))}
      </div>
    </>
  );

  return (
    <div className="flex h-[calc(100vh-10rem)] min-h-96 rounded-xl border border-border bg-card overflow-hidden">
      {/* Sidebar — an overlay drawer on mobile, a collapsible column on desktop */}
      {isMobile ? (
        sidebarOpen && (
          <>
            <div
              className="fixed inset-0 z-40 bg-black/50"
              onClick={() => setSidebarOpen(false)}
            />
            <div className="fixed top-0 left-0 z-50 h-full w-64 bg-card border-r border-border flex flex-col">
              {sidebarBody}
            </div>
          </>
        )
      ) : (
        sidebarOpen && (
          <div className="w-52 shrink-0 border-r border-border bg-muted/30 flex flex-col">
            {sidebarBody}
          </div>
        )
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 px-3 sm:px-4 py-3 border-b border-border shrink-0">
          {/* Sidebar toggle */}
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 px-2"
            onClick={() => setSidebarOpen((v) => !v)}
            aria-label={sidebarOpen ? "Hide folders" : "Show folders"}
            title={sidebarOpen ? "Hide folders" : "Show folders"}
          >
            <PanelLeft className="size-4" />
          </Button>

          {/* Breadcrumbs */}
          {!isSearchMode && (
            <div className="flex items-center gap-1 text-sm flex-1 min-w-0 overflow-x-auto">
              <button
                className={cn(
                  "text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1 shrink-0",
                  currentFolder === null && "text-foreground font-medium",
                )}
                onClick={() => navigate(null)}
              >
                <Home className="size-3.5" />
                <span>Files</span>
              </button>
              {breadcrumbs.map((crumb) => (
                <span key={crumb.id} className="flex items-center gap-1 shrink-0">
                  <ChevronRight className="size-3.5 text-muted-foreground/50" />
                  <button
                    className={cn(
                      "text-muted-foreground hover:text-foreground transition-colors",
                      crumb.id === currentFolder && "text-foreground font-medium",
                    )}
                    onClick={() => navigate(crumb.id)}
                  >
                    {crumb.name}
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* Search — full width on its own row on mobile, inline on desktop */}
          <div className="relative order-last w-full sm:order-none sm:w-auto sm:flex-1 sm:min-w-0 sm:max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search all files…"
              className="pl-8 pr-7 h-8 text-sm"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Clear search"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>

          {/* Actions */}
          {!isSearchMode && (
            <div className="flex items-center gap-2 shrink-0">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void loadFiles(currentFolder)}
                title="Refresh"
              >
                <RefreshCw className="size-4" />
              </Button>
              {currentFolder !== null && (
                <Button
                  variant="outline"
                  size="sm"
                  className="px-2 sm:px-3"
                  onClick={() =>
                    router.push(`/tasks/new?fromFolder=${encodeURIComponent(currentFolder)}`)
                  }
                  title="Create a task from this folder"
                >
                  <ListPlus className="size-4 sm:mr-1.5" />
                  <span className="hidden sm:inline">Create Task</span>
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className="px-2 sm:px-3"
                onClick={() => {
                  setNewFolderName("");
                  setShowNewFolderDialog(true);
                }}
                title="New Folder"
              >
                <FolderPlus className="size-4 sm:mr-1.5" />
                <span className="hidden sm:inline">New Folder</span>
              </Button>
              <Button
                variant="default"
                size="sm"
                className="px-2 sm:px-3"
                disabled={uploading}
                onClick={() => fileInputRef.current?.click()}
                title="Upload"
              >
                <Upload className="size-4 sm:mr-1.5" />
                <span className="hidden sm:inline">{uploading ? "Uploading…" : "Upload"}</span>
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.length) void uploadFiles(e.target.files);
                }}
              />
            </div>
          )}
        </div>

        {/* File grid drop zone */}
        <div
          className={cn(
            "flex-1 overflow-y-auto p-4 transition-colors",
            isDragOverDropZone && "bg-blue-500/5 ring-2 ring-inset ring-blue-400/30",
          )}
          onDragOver={(e) => {
            if (isSearchMode) return;
            e.preventDefault();
            setIsDragOverDropZone(true);
          }}
          onDragLeave={() => setIsDragOverDropZone(false)}
          onDrop={(e) => !isSearchMode && void handleDropOnMain(e)}
        >
          {loading || searching ? (
            <div className="flex items-center justify-center h-40 text-muted-foreground text-sm gap-2">
              <RefreshCw className="size-4 animate-spin" />
              Loading…
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-40 gap-3 text-destructive">
              <AlertCircle className="size-8" />
              <p className="text-sm">{error}</p>
              <Button variant="outline" size="sm" onClick={() => void loadFiles(currentFolder)}>
                Retry
              </Button>
            </div>
          ) : displayedEntries.length === 0 ? (
            isSearchMode ? (
              <div className="flex flex-col items-center justify-center h-40 gap-2 text-muted-foreground">
                <Search size={28} className="text-muted-foreground/40" />
                <p className="text-sm">No files match &ldquo;{query}&rdquo;.</p>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-40 gap-3 text-muted-foreground">
                <div className="size-12 rounded-xl border-2 border-dashed border-border flex items-center justify-center">
                  <Upload className="size-5 text-muted-foreground/50" />
                </div>
                <p className="text-sm text-center">
                  Drop files here or click <strong className="text-foreground">Upload</strong>
                  <br />
                  <span className="text-xs">to add files to this folder</span>
                </p>
              </div>
            )
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(105px,1fr))] sm:grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2 sm:gap-3">
              {displayedEntries.map((entry) => {
                const isImage = !entry.isFolder && isImageFile(entry);
                const isDragTarget = dragOverFolder === entry.id;
                const isDragging = draggingItem?.id === entry.id;
                const href = entry.isFolder ? undefined : `/files/${entry.id}`;

                const inner = (
                  <>
                    {/* Thumbnail or icon — a touch smaller on mobile so two
                        items fit comfortably side-by-side at typical phone widths. */}
                    <div className="relative w-12 h-12 sm:w-16 sm:h-16 flex items-center justify-center">
                      {isImage ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={`/api/files/${entry.id}/download`}
                          alt={entry.name}
                          className="w-full h-full object-cover rounded-lg border border-border"
                          draggable={false}
                        />
                      ) : entry.isFolder ? (
                        isDragTarget ? (
                          <FolderOpen className="size-10 sm:size-14 text-amber-400 drop-shadow-md" />
                        ) : (
                          <Folder className="size-10 sm:size-14 text-amber-400 drop-shadow-md" />
                        )
                      ) : (
                        getFileIcon(
                          { name: entry.name, ext: getFileExt(entry.name) },
                          "size-9 sm:size-12",
                        )
                      )}
                      {entry.protected && (
                        <span
                          className="absolute -bottom-0.5 -right-0.5 flex items-center justify-center size-4 rounded-full bg-card border border-border text-emerald-400"
                          title="Protected from automatic cleanup"
                        >
                          <Shield className="size-2.5 fill-current" />
                        </span>
                      )}
                    </div>

                    {/* Name */}
                    <span
                      className="text-xs text-center text-foreground leading-tight max-w-full overflow-hidden text-ellipsis line-clamp-2 w-full"
                      title={entry.name}
                    >
                      {entry.name}
                    </span>

                    {isSearchMode && entry.task && (
                      <span className="text-[10px] text-muted-foreground/70 truncate w-full text-center" title={entry.task.title}>
                        ↳ {entry.task.title}
                      </span>
                    )}

                    {/* File size */}
                    {!entry.isFolder && entry.size != null && (
                      <span className="text-[10px] text-muted-foreground/60">
                        {formatSize(entry.size)}
                      </span>
                    )}
                  </>
                );

                return (
                  <div
                    key={entry.id}
                    draggable={!isSearchMode}
                    onDragStart={(e) => !isSearchMode && handleItemDragStart(e, entry)}
                    onDragEnd={handleItemDragEnd}
                    onDragOver={(e) => {
                      if (!isSearchMode && entry.isFolder) {
                        e.preventDefault();
                        e.stopPropagation();
                        setDragOverFolder(entry.id);
                      }
                    }}
                    onDragLeave={(e) => {
                      e.stopPropagation();
                      if (dragOverFolder === entry.id) setDragOverFolder(null);
                    }}
                    onDrop={
                      !isSearchMode && entry.isFolder
                        ? (e) => void handleDropOnFolderEntry(e, entry)
                        : undefined
                    }
                    onClick={(e) => {
                      // Single click opens a folder — there's no separate
                      // "select" action here, so open-on-click matches how
                      // files (via the Link wrapper) already behave.
                      if (!entry.isFolder) return;
                      if ((e.target as HTMLElement).closest("button, a")) return;
                      navigate(entry.id);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setContextMenu({ x: e.clientX, y: e.clientY, entry });
                    }}
                    className={cn(
                      "group relative flex flex-col items-center gap-1.5 sm:gap-2 p-2 sm:p-3 rounded-xl border border-transparent transition-all hover:border-border hover:bg-muted/50 select-none",
                      entry.isFolder ? "cursor-pointer" : "cursor-default",
                      isDragging && "opacity-40",
                      isDragTarget &&
                        "border-blue-400/60 bg-blue-500/10 ring-2 ring-blue-400/30 scale-105",
                    )}
                  >
                    {href ? (
                      <Link href={href} className="flex flex-col items-center gap-2 w-full">
                        {inner}
                      </Link>
                    ) : (
                      inner
                    )}

                    {/* Item actions — always visible on touch devices (where
                        hover doesn't fire) and on hover for desktop. */}
                    <div
                      className={cn(
                        "absolute top-1 right-1 sm:top-1.5 sm:right-1.5 items-center gap-0.5",
                        // On mobile (no hover) always render; on sm+ rely on hover.
                        isMobile ? "flex" : "hidden group-hover:flex",
                      )}
                    >
                      {entry.isFolder && !isSearchMode && (
                        <button
                          type="button"
                          className="p-1 rounded bg-card/70 backdrop-blur-sm sm:bg-transparent hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                          title="Create task from this folder"
                          aria-label="Create task from this folder"
                          onClick={(e) => {
                            e.stopPropagation();
                            router.push(`/tasks/new?fromFolder=${encodeURIComponent(entry.id)}`);
                          }}
                        >
                          <ListPlus className="size-3" />
                        </button>
                      )}
                      {!entry.isFolder && (
                        <a
                          href={`/api/files/${entry.id}/download`}
                          download={entry.name}
                          onClick={(e) => e.stopPropagation()}
                          className="p-1 rounded bg-card/70 backdrop-blur-sm sm:bg-transparent hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                          title="Download"
                          aria-label="Download"
                        >
                          <Download className="size-3" />
                        </a>
                      )}
                      {!isSearchMode && (
                        <button
                          type="button"
                          className={cn(
                            "p-1 rounded bg-card/70 backdrop-blur-sm sm:bg-transparent hover:bg-muted transition-colors",
                            entry.protected
                              ? "text-emerald-400 hover:text-emerald-300"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                          title={
                            entry.protected
                              ? "Unprotect from automatic cleanup"
                              : "Protect from automatic cleanup"
                          }
                          aria-label={entry.protected ? "Unprotect" : "Protect from cleanup"}
                          onClick={(e) => {
                            e.stopPropagation();
                            void toggleProtect(entry);
                          }}
                        >
                          {entry.protected ? (
                            <Shield className="size-3 fill-current" />
                          ) : (
                            <ShieldOff className="size-3" />
                          )}
                        </button>
                      )}
                      <button
                        type="button"
                        className="p-1 rounded bg-card/70 backdrop-blur-sm sm:bg-transparent hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                        title="Delete"
                        aria-label="Delete"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteTarget(entry);
                        }}
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Status bar */}
        {!loading && !error && (
          <div className="border-t border-border px-4 py-1.5 flex items-center gap-4 text-xs text-muted-foreground shrink-0">
            <span>
              {isSearchMode
                ? `${displayedEntries.length} result${displayedEntries.length !== 1 ? "s" : ""}`
                : `${displayedEntries.length} item${displayedEntries.length !== 1 ? "s" : ""}`}
            </span>
            {draggingItem && (
              <span className="text-blue-400">
                Dragging &ldquo;{draggingItem.name}&rdquo;, drop on a folder to move
              </span>
            )}
          </div>
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-card border border-border rounded-lg shadow-lg py-1 min-w-36 text-sm"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          {!contextMenu.entry.isFolder && (
            <a
              href={`/api/files/${contextMenu.entry.id}/download`}
              download={contextMenu.entry.name}
              className="flex items-center gap-2 px-3 py-2 hover:bg-muted transition-colors cursor-pointer"
              onClick={() => setContextMenu(null)}
            >
              <Download className="size-3.5" />
              Download
            </a>
          )}
          {contextMenu.entry.isFolder && (
            <button
              type="button"
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted transition-colors text-left"
              onClick={() => {
                navigate(contextMenu.entry.id);
                setContextMenu(null);
              }}
            >
              <FolderOpen className="size-3.5" />
              Open
            </button>
          )}
          {contextMenu.entry.isFolder && (
            <button
              type="button"
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted transition-colors text-left"
              onClick={() => {
                router.push(`/tasks/new?fromFolder=${encodeURIComponent(contextMenu.entry.id)}`);
                setContextMenu(null);
              }}
            >
              <ListPlus className="size-3.5" />
              Create Task
            </button>
          )}
          <button
            type="button"
            className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted transition-colors text-left"
            onClick={() => {
              void toggleProtect(contextMenu.entry);
              setContextMenu(null);
            }}
          >
            {contextMenu.entry.protected ? (
              <>
                <ShieldOff className="size-3.5" />
                Unprotect
              </>
            ) : (
              <>
                <Shield className="size-3.5" />
                Protect from cleanup
              </>
            )}
          </button>
          <button
            type="button"
            className="w-full flex items-center gap-2 px-3 py-2 hover:bg-destructive/10 text-destructive transition-colors text-left"
            onClick={() => {
              setDeleteTarget(contextMenu.entry);
              setContextMenu(null);
            }}
          >
            <Trash2 className="size-3.5" />
            Delete
          </button>
        </div>
      )}

      {/* New Folder Dialog */}
      <Dialog open={showNewFolderDialog} onOpenChange={setShowNewFolderDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>New Folder</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <Input
              placeholder="Folder name"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void createFolder();
                if (e.key === "Escape") setShowNewFolderDialog(false);
              }}
              autoFocus
            />
            {breadcrumbs.length > 0 && (
              <p className="text-xs text-muted-foreground mt-1.5">
                Will be created inside{" "}
                <code className="bg-muted px-1 py-0.5 rounded">
                  {breadcrumbs[breadcrumbs.length - 1]!.name}
                </code>
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowNewFolderDialog(false)}
              disabled={creatingFolder}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void createFolder()}
              disabled={!newFolderName.trim() || creatingFolder}
            >
              {creatingFolder ? "Creating…" : "Create Folder"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete {deleteTarget?.isFolder ? "Folder" : "File"}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            Are you sure you want to delete{" "}
            <strong className="text-foreground">&ldquo;{deleteTarget?.name}&rdquo;</strong>?
            {deleteTarget?.isFolder && (
              <span className="block mt-1 text-destructive text-xs">
                This will delete the folder and all its contents.
              </span>
            )}
            {deleteTarget?.protected && (
              <span className="flex items-center gap-1 mt-1 text-emerald-400 text-xs">
                <Shield className="size-3" />
                This item is protected from automatic cleanup, but manual deletion still removes it.
              </span>
            )}
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDeleteTarget(null)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void deleteEntry()}
              disabled={deleting}
            >
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
