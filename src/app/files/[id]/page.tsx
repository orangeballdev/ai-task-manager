"use client";

import { useState, useEffect, use } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ChevronRight, Edit2, Save, Trash2, X, Eye, Code, Download, Maximize2, Minimize2, ListPlus, Shield, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { LocalDateTime } from "@/components/LocalDateTime";
import { toast } from "sonner";
import { confirm } from "@/components/ui/confirm-dialog";
import { FileContentView } from "@/components/FileContentView";
import { getFileIcon, getFileExt } from "@/lib/file-icons";

interface FileRecord {
  id: string;
  name: string;
  isFolder: boolean;
  content: string | null;
  mimeType: string | null;
  size: number | null;
  taskId: string | null;
  task: { id: string; title: string } | null;
  parentId: string | null;
  protected: boolean;
  createdAt: string;
  updatedAt: string;
}

interface Breadcrumb {
  id: string;
  name: string;
}

export default function FileDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [file, setFile] = useState<FileRecord | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const isBinary = file !== null && !file.isFolder && file.content === null;
  const isImage = isBinary && (file?.mimeType ?? "").startsWith("image/");

  // View state: "rendered" | "raw"
  const [viewMode, setViewMode] = useState<"rendered" | "raw">("rendered");
  const [fullscreen, setFullscreen] = useState(false);
  // Edit state
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    fetch(`/api/files/${id}`)
      .then((r) => {
        if (r.status === 404) { setNotFound(true); return null; }
        return r.json() as Promise<FileRecord>;
      })
      .then((data) => {
        if (data) {
          if (data.isFolder) {
            // Folders don't have their own detail view — hand off to the file
            // browser, opened directly to this folder's contents.
            router.replace(`/files?folder=${encodeURIComponent(data.id)}`);
            return;
          }
          setFile(data);
          if (data.parentId) {
            fetch(`/api/files?parentId=${encodeURIComponent(data.parentId)}`)
              .then((r) => r.json() as Promise<{ breadcrumbs: Breadcrumb[] }>)
              .then((d) => setBreadcrumbs(d.breadcrumbs))
              .catch(() => {});
          } else {
            setBreadcrumbs([]);
          }
        }
      })
      .catch(() => toast.error("Failed to load file"))
      .finally(() => setLoading(false));
  }, [id, router]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape" && fullscreen) setFullscreen(false);
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [fullscreen]);

  function startEditing() {
    if (!file || isBinary) return;
    setEditName(file.name);
    setEditContent(file.content ?? "");
    setEditing(true);
  }

  function cancelEditing() {
    setEditing(false);
    setEditName("");
    setEditContent("");
  }

  async function saveFile() {
    if (!file) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/files/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editName.trim() || file.name, content: editContent }),
      });
      if (!res.ok) throw new Error("Save failed");
      const updated = await res.json() as FileRecord;
      setFile(updated);
      setEditing(false);
      setViewMode("rendered");
      toast.success("File saved");
    } catch {
      toast.error("Failed to save file");
    } finally {
      setSaving(false);
    }
  }

  function downloadFile() {
    if (!file) return;
    if (isBinary) {
      window.location.href = `/api/files/${file.id}/download`;
      return;
    }
    // Extension-less (legacy) files are rendered as markdown, so download them as .md.
    const downloadName = getFileExt(file.name) ? file.name : `${file.name}.md`;
    const blob = new Blob([file.content ?? ""], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = downloadName;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function toggleProtect() {
    if (!file) return;
    const nextProtected = !file.protected;
    try {
      const res = await fetch(`/api/files/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ protected: nextProtected }),
      });
      if (!res.ok) throw new Error("Failed to update");
      const updated = await res.json() as FileRecord;
      setFile(updated);
      toast.success(nextProtected ? "Protected from automatic cleanup" : "No longer protected");
    } catch {
      toast.error("Failed to update protection");
    }
  }

  async function deleteFile() {
    if (!file) return;
    const ok = await confirm({
      title: "Delete file",
      description: `Delete "${file.name}"? This cannot be undone.`,
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/files/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      toast.success("File deleted");
      router.push(file.parentId ? `/files?folder=${encodeURIComponent(file.parentId)}` : "/files");
    } catch {
      toast.error("Failed to delete file");
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto">
        <p className="text-muted-foreground text-sm">Loading…</p>
      </div>
    );
  }

  if (notFound || !file) {
    return (
      <div className="max-w-7xl mx-auto">
        <Link href="/files" className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-6 w-fit transition-colors">
          <ArrowLeft size={14} /> Back to Files
        </Link>
        <p className="text-muted-foreground">File not found.</p>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto flex flex-col gap-4">
      {/* Header */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-1 text-sm flex-wrap w-fit">
          <Link
            href={file.parentId ? `/files?folder=${encodeURIComponent(file.parentId)}` : "/files"}
            className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft size={14} /> Files
          </Link>
          {breadcrumbs.map((crumb) => (
            <span key={crumb.id} className="flex items-center gap-1">
              <ChevronRight className="size-3.5 text-muted-foreground/50" />
              <Link
                href={`/files?folder=${encodeURIComponent(crumb.id)}`}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                {crumb.name}
              </Link>
            </span>
          ))}
        </div>
        {/* File name: always on its own full-width line */}
        {editing ? (
          <Input
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            className="text-xl font-bold h-auto py-1 border-0 border-b border-border rounded-none px-0 focus-visible:ring-0 focus-visible:border-primary"
            placeholder="File name"
            autoFocus
          />
        ) : (
          <div className="flex items-center gap-2.5 min-w-0 w-full">
            {getFileIcon({ name: file.name, ext: getFileExt(file.name) || "md" }, "size-6")}
            <h1 className="text-2xl font-bold truncate">{file.name}</h1>
          </div>
        )}

        {/* Metadata: full width, independent of the action buttons */}
        {!editing && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap w-full">
            {file.task ? (
              <Link href={`/tasks/${file.task.id}`} className="hover:text-foreground transition-colors">
                ↳ {file.task.title}
              </Link>
            ) : (
              <div className="flex items-center gap-2.5 min-w-0">
                {getFileIcon({ name: file.name, ext: getFileExt(file.name) || "md" }, "size-6")}
                <h1 className="text-2xl font-bold truncate">{file.name}</h1>
              </div>
            )}
            <div className="flex items-center gap-2 mt-1.5 text-xs text-muted-foreground flex-wrap">
              {file.task ? (
                <Link href={`/tasks/${file.task.id}`} className="hover:text-foreground transition-colors">
                  ↳ {file.task.title}
                </Link>
              ) : (
                <span className="italic">Task deleted</span>
              )}
              <span className="text-muted-foreground/40">·</span>
              <span>Updated <LocalDateTime iso={file.updatedAt} /></span>
              <span className="text-muted-foreground/40">·</span>
              <span>Created <LocalDateTime iso={file.createdAt} /></span>
              {file.protected && (
                <>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="flex items-center gap-1 text-emerald-400" title="Exempt from automatic file cleanup">
                    <Shield className="size-3 fill-current" />
                    Protected
                  </span>
                </>
              )}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 self-end">
          {!editing ? (
            <>
              {!isBinary && (
                <Link href={`/tasks/new?fromFile=${file.id}`} className="contents">
                  <Button variant="outline" size="sm">
                    <ListPlus size={14} />
                    Create Task
                  </Button>
                </Link>
              )}
              <Button variant="outline" size="sm" onClick={downloadFile}>
                <Download size={14} />
                Download
              </Button>
              {!isBinary && (
                <Button variant="outline" size="sm" onClick={startEditing}>
                  <Edit2 size={14} />
                  Edit
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void toggleProtect()}
                className={file.protected ? "text-emerald-400 hover:text-emerald-300" : undefined}
              >
                {file.protected ? <Shield size={14} className="fill-current" /> : <ShieldOff size={14} />}
                {file.protected ? "Unprotect" : "Protect"}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => void deleteFile()}
                disabled={deleting}
              >
                <Trash2 size={14} />
                {deleting ? "Deleting…" : "Delete"}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={cancelEditing} disabled={saving}>
                <X size={14} />
                Cancel
              </Button>
              <Button size="sm" onClick={() => void saveFile()} disabled={saving}>
                <Save size={14} />
                {saving ? "Saving…" : "Save"}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Content area */}
      <div
        className={
          fullscreen
            ? "fixed inset-0 z-50 bg-background flex flex-col"
            : "border border-border rounded-lg overflow-hidden"
        }
      >
        {isBinary ? (
          isImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/files/${file.id}/download`}
              alt={file.name}
              className="max-w-full max-h-[700px] mx-auto"
            />
          ) : (
            <div className="flex flex-col items-center gap-3 p-12 text-center text-muted-foreground">
              {getFileIcon({ name: file.name, ext: getFileExt(file.name) }, "size-10")}
              <p className="text-sm">Preview isn&apos;t available for this file type.</p>
              <Button variant="outline" size="sm" onClick={downloadFile}>
                <Download size={14} />
                Download to view
              </Button>
            </div>
          )
        ) : editing ? (
          <Textarea
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            className="min-h-[500px] font-mono text-sm resize-none rounded-none border-0 focus-visible:ring-0"
            placeholder="Markdown content…"
          />
        ) : (
          <>
            {/* View toggle + fullscreen, on a single row */}
            <div className="flex items-center justify-between gap-1 px-3 py-2 border-b border-border bg-muted/30">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setViewMode("rendered")}
                  className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                    viewMode === "rendered"
                      ? "bg-background text-foreground shadow-sm border border-border"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Eye size={12} />
                  Rendered
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode("raw")}
                  className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                    viewMode === "raw"
                      ? "bg-background text-foreground shadow-sm border border-border"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Code size={12} />
                  Raw
                </button>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0 shrink-0"
                onClick={() => setFullscreen((f) => !f)}
                title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
              >
                {fullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
              </Button>
            </div>

            <div className={fullscreen ? "flex-1 overflow-auto" : undefined}>
              {viewMode === "rendered" ? (
                <FileContentView
                  content={file.content ?? ""}
                  fileName={file.name}
                  markdownFallback
                  showLabel={false}
                  fullscreenProps={{ hideToolbar: true, fullscreen, onFullscreenChange: setFullscreen }}
                />
              ) : (
                <pre
                  className={
                    fullscreen
                      ? "p-6 text-sm font-mono text-foreground/90 whitespace-pre-wrap break-words overflow-auto h-full"
                      : "p-6 text-sm font-mono text-foreground/90 whitespace-pre-wrap break-words overflow-auto max-h-[700px]"
                  }
                >
                  {file.content ?? ""}
                </pre>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
