"use client";
import { useState, useEffect, useRef, type ChangeEvent } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { beginDelete, endDelete } from "@/lib/delete-lock";
import { confirm } from "@/components/ui/confirm-dialog";
import { Download, Upload } from "lucide-react";

const STATUS_OPTIONS = [
  { value: "all", label: "All tasks" },
  { value: "completed", label: "Completed" },
  { value: "no_changes", label: "No changes" },
  { value: "failed", label: "Failed" },
  { value: "killed", label: "Killed" },
  { value: "timedout", label: "Timed out" },
] as const;

const RETENTION_OPTIONS = [
  { value: "1", label: "1 day" },
  { value: "3", label: "3 days" },
  { value: "7", label: "7 days" },
  { value: "14", label: "14 days" },
  { value: "30", label: "30 days" },
  { value: "0", label: "Disabled" },
] as const;

const RETENTION_SCOPE_OPTIONS = [
  { value: "all", label: "All finished tasks" },
  { value: "done", label: "Done tasks only" },
] as const;

const FILE_RETENTION_OPTIONS = [
  { value: "7", label: "7 days" },
  { value: "14", label: "14 days" },
  { value: "30", label: "30 days" },
  { value: "60", label: "60 days" },
  { value: "90", label: "90 days" },
  { value: "0", label: "Disabled" },
] as const;

type StatusOption = (typeof STATUS_OPTIONS)[number]["value"];

export default function DataSettingsPage() {
  const [deleteStatus, setDeleteStatus] = useState<StatusOption>("completed");
  const [deleting, setDeleting] = useState(false);
  const [retentionDays, setRetentionDays] = useState("3");
  const [savingRetention, setSavingRetention] = useState(false);
  const [retentionScope, setRetentionScope] = useState("all");
  const [savingRetentionScope, setSavingRetentionScope] = useState(false);
  const [fileRetentionDays, setFileRetentionDays] = useState("30");
  const [savingFileRetention, setSavingFileRetention] = useState(false);
  const [runningCleanup, setRunningCleanup] = useState(false);
  const [downloadingBackup, setDownloadingBackup] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const restoreInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data: Record<string, string>) => {
        if (data.task_retention_days !== undefined) setRetentionDays(data.task_retention_days);
        if (data.task_retention_scope !== undefined) setRetentionScope(data.task_retention_scope === "done" ? "done" : "all");
        if (data.file_retention_days !== undefined) setFileRetentionDays(data.file_retention_days);
      })
      .catch(() => {});
  }, []);

  async function saveRetention(value: string) {
    setRetentionDays(value);
    setSavingRetention(true);
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "task_retention_days", value }),
      });
      toast.success("Retention setting saved");
    } catch {
      toast.error("Failed to save setting");
    } finally {
      setSavingRetention(false);
    }
  }

  async function saveRetentionScope(value: string) {
    const previous = retentionScope;
    setRetentionScope(value);
    setSavingRetentionScope(true);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "task_retention_scope", value }),
      });
      if (!res.ok) throw new Error();
      toast.success("Cleanup scope saved");
    } catch {
      setRetentionScope(previous);
      toast.error("Failed to save setting");
    } finally {
      setSavingRetentionScope(false);
    }
  }

  async function saveFileRetention(value: string) {
    setFileRetentionDays(value);
    setSavingFileRetention(true);
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "file_retention_days", value }),
      });
      toast.success("File retention setting saved");
    } catch {
      toast.error("Failed to save setting");
    } finally {
      setSavingFileRetention(false);
    }
  }

  async function runCleanupNow() {
    setRunningCleanup(true);
    try {
      const res = await fetch("/api/tasks/cleanup", { method: "POST" });
      const data = await res.json() as { deleted: number };
      toast.success(data.deleted > 0 ? `Removed ${data.deleted} old task${data.deleted === 1 ? "" : "s"}` : "Nothing to clean up");
    } catch {
      toast.error("Cleanup failed");
    } finally {
      setRunningCleanup(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    beginDelete();
    try {
      const res = await fetch("/api/tasks/delete-by-status", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: deleteStatus }),
      });
      const data = await res.json() as { ok: boolean; count?: number; error?: string };
      if (!res.ok || !data.ok) {
        toast.error(data.error ?? "Failed to delete tasks");
        return;
      }
      const label = STATUS_OPTIONS.find((o) => o.value === deleteStatus)?.label ?? deleteStatus;
      toast.success(`Deleted ${data.count} ${label.toLowerCase()} task${data.count === 1 ? "" : "s"}`);
    } catch {
      toast.error("Request failed");
    } finally {
      setDeleting(false);
      endDelete();
    }
  }

  async function downloadBackup() {
    setDownloadingBackup(true);
    try {
      const res = await fetch("/api/settings/backup");
      if (!res.ok) {
        const data = await res.json().catch(() => ({}) as { error?: string });
        toast.error(data.error ?? "Failed to create backup");
        return;
      }
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(disposition);
      const filename = match?.[1] ?? `task-manager-backup-${Date.now()}.db`;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success("Backup downloaded");
    } catch {
      toast.error("Failed to create backup");
    } finally {
      setDownloadingBackup(false);
    }
  }

  function pickRestoreFile() {
    restoreInputRef.current?.click();
  }

  async function handleRestoreFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    const ok = await confirm({
      title: "Restore database",
      description: `This will overwrite all current data with the contents of "${file.name}". This cannot be undone. Continue?`,
      confirmLabel: "Restore",
      variant: "destructive",
    });
    if (!ok) return;

    setRestoring(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/settings/backup", { method: "POST", body: formData });
      const data = await res.json() as { ok?: boolean; error?: string; warning?: string };
      if (!res.ok || !data.ok) {
        toast.error(data.error ?? "Failed to restore database");
        return;
      }
      toast.success(data.warning ?? "Database restored");
    } catch {
      toast.error("Failed to restore database");
    } finally {
      setRestoring(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle id="backup-restore" className="text-base scroll-mt-24">Backup &amp; Restore</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Download a full snapshot of the database, or restore from a previously downloaded backup file. Restoring
            <strong className="text-foreground"> overwrites all current data</strong> and cannot be undone.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" onClick={downloadBackup} disabled={downloadingBackup}>
              <Download className="size-4" />
              {downloadingBackup ? "Preparing…" : "Download Backup"}
            </Button>
            <Button variant="outline" onClick={pickRestoreFile} disabled={restoring}>
              <Upload className="size-4" />
              {restoring ? "Restoring…" : "Restore from File"}
            </Button>
            <input
              ref={restoreInputRef}
              type="file"
              accept=".db,.sqlite,.sqlite3"
              className="hidden"
              onChange={(e) => void handleRestoreFile(e)}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            After restoring, restart the app and worker process so the new data is fully picked up.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle id="automatic-cleanup" className="text-base scroll-mt-24">Automatic Cleanup</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Automatically delete finished tasks (and their workspaces) after a set period. Runs daily in the background.
            Choose <strong className="text-foreground">Done tasks only</strong> to delete just the tasks in the board&rsquo;s Done
            column and leave everything else &mdash; tasks still In Review and failed, killed or timed-out tasks &mdash; untouched.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">Delete tasks older than</span>
              <Select
                value={retentionDays}
                onValueChange={(v) => { if (v) void saveRetention(v); }}
                disabled={savingRetention}
              >
                <SelectTrigger className="w-36">
                  <span className="flex-1 text-left">
                    {RETENTION_OPTIONS.find((o) => o.value === retentionDays)?.label ?? retentionDays}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  {RETENTION_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">Apply to</span>
              <Select
                value={retentionScope}
                onValueChange={(v) => { if (v) void saveRetentionScope(v); }}
                disabled={savingRetentionScope || retentionDays === "0"}
              >
                <SelectTrigger className="w-44">
                  <span className="flex-1 text-left">
                    {RETENTION_SCOPE_OPTIONS.find((o) => o.value === retentionScope)?.label ?? retentionScope}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  {RETENTION_SCOPE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button variant="outline" onClick={runCleanupNow} disabled={runningCleanup || retentionDays === "0"}>
              {runningCleanup ? "Running…" : "Run Now"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle id="file-retention" className="text-base scroll-mt-24">File Retention</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Automatically delete files produced by &ldquo;Create file(s)&rdquo; tasks after a set period. Runs as part of the daily cleanup. Files and folders marked as{" "}
            <strong className="text-foreground">protected</strong> in the{" "}
            <Link href="/files" className="underline hover:text-foreground">Files</Link> browser are always kept. Protecting a folder also protects everything inside it.
          </p>
          <div className="flex items-end gap-3">
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">Delete files older than</span>
              <Select
                value={fileRetentionDays}
                onValueChange={(v) => { if (v) void saveFileRetention(v); }}
                disabled={savingFileRetention}
              >
                <SelectTrigger className="w-36">
                  <span className="flex-1 text-left">
                    {FILE_RETENTION_OPTIONS.find((o) => o.value === fileRetentionDays)?.label ?? fileRetentionDays}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  {FILE_RETENTION_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle id="delete-tasks" className="text-base scroll-mt-24">Delete Tasks</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Permanently delete tasks by status. This action cannot be undone.
          </p>
          <div className="flex items-end gap-3">
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">Task type</span>
              <Select value={deleteStatus} onValueChange={(v) => setDeleteStatus(v as StatusOption)}>
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? "Deleting..." : "Delete"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
