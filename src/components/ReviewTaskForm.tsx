"use client";

// The create/edit form for review-only tickets (src/lib/review-only.ts): a reminder
// to review work done elsewhere. Same ticket fields as any task — title, description,
// priority, labels, context, notes — plus the review metadata (repo, branch, commit
// SHAs, PR link). No run options: the task never runs.
import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Eye } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AdvancedOptions } from "@/components/AdvancedOptions";
import { DEFAULT_PRIORITY } from "@/lib/priority";
import { parseReviewMetadata, parseStoredCommits, splitCommitList } from "@/lib/review-only";

export interface ReviewTaskFormValues {
  title: string;
  description: string;
  context: string;
  notes: string;
  priority: string;
  labels: string[];
  repo: string;
  branch: string;
  commits: string;
  prUrl: string;
}

export const EMPTY_REVIEW_FORM: ReviewTaskFormValues = {
  title: "", description: "", context: "", notes: "", priority: DEFAULT_PRIORITY, labels: [],
  repo: "", branch: "", commits: "", prUrl: "",
};

/** Form values for an existing review-only task row. */
export function reviewFormValuesFromTask(task: {
  title: string; description: string; context: string | null; notes: string | null; priority: string; labels: string | null;
  reviewRepo?: string | null; reviewBranch?: string | null; reviewCommits?: string | null; reviewPrUrl?: string | null;
}): ReviewTaskFormValues {
  let labels: string[] = [];
  try { labels = task.labels ? (JSON.parse(task.labels) as string[]) : []; } catch { /* ignore */ }
  return {
    title: task.title,
    description: task.description,
    context: task.context ?? "",
    notes: task.notes ?? "",
    priority: task.priority || DEFAULT_PRIORITY,
    labels,
    repo: task.reviewRepo ?? "",
    branch: task.reviewBranch ?? "",
    commits: parseStoredCommits(task.reviewCommits).join(", "),
    prUrl: task.reviewPrUrl ?? "",
  };
}

function metadataPayload(v: ReviewTaskFormValues) {
  // Every key is sent, so clearing a field on edit clears it on the task.
  return { repo: v.repo, branch: v.branch, commits: splitCommitList(v.commits) ?? [], prUrl: v.prUrl };
}

interface SavedRepo { url: string; alias: string; saved?: boolean }

export function ReviewTaskForm({
  mode,
  taskId,
  initial = EMPTY_REVIEW_FORM,
  cancelHref,
  onCreated,
}: {
  mode: "create" | "edit";
  taskId?: string;
  initial?: ReviewTaskFormValues;
  cancelHref: string;
  /** Where to go after creating; defaults to the new task's page. */
  onCreated?: (id: string) => void;
}) {
  const router = useRouter();
  const uid = useId();
  const [values, setValues] = useState<ReviewTaskFormValues>(initial);
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);
  const [repos, setRepos] = useState<SavedRepo[]>([]);

  useEffect(() => {
    fetch("/api/repos")
      .then((r) => r.json())
      .then((data: SavedRepo[]) => setRepos(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, []);

  const set = <K extends keyof ReviewTaskFormValues>(key: K, value: ReviewTaskFormValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    if (fieldError && fieldError.field.endsWith(`.${key}`)) setFieldError(null);
  };

  const errorFor = (key: string) => (fieldError?.field === `reviewMetadata.${key}` ? fieldError.message : null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!values.description.trim()) {
      toast.error("Please enter a description: what to review and why");
      return;
    }
    const meta = metadataPayload(values);
    const check = parseReviewMetadata(meta);
    if (!check.ok) {
      setFieldError({ field: check.field, message: check.message });
      toast.error(check.message);
      return;
    }
    setSaving(true);
    try {
      let title = values.title.trim();
      if (!title && mode === "create") {
        // Same default as the normal form: ask for a suggested title, else the description's start.
        try {
          const res = await fetch("/api/tasks/suggest-title", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ description: values.description, context: values.context || undefined }),
          });
          const data = await res.json() as { title?: string };
          if (data.title) title = data.title;
        } catch { /* fall back below */ }
      }
      if (!title) title = values.description.trim().slice(0, 80);

      const body = {
        title,
        description: values.description,
        context: values.context.trim() || (mode === "edit" ? null : undefined),
        notes: values.notes.trim() ? values.notes : mode === "edit" ? null : undefined,
        priority: values.priority,
        labels: values.labels,
        reviewMetadata: meta,
      };
      const res = await fetch(mode === "create" ? "/api/tasks" : `/api/tasks/${taskId}`, {
        method: mode === "create" ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "create" ? { ...body, reviewOnly: true } : body),
      });
      const data = await res.json().catch(() => ({})) as { id?: string; error?: string; field?: string };
      if (!res.ok) {
        if (data.field) setFieldError({ field: data.field, message: data.error ?? "Invalid value" });
        throw new Error(data.error || "Failed to save");
      }
      if (mode === "create") {
        toast.success("Review ticket created in In Review");
        if (onCreated && data.id) onCreated(data.id);
        else router.push(`/tasks/${data.id}`);
      } else {
        toast.success("Review ticket saved");
        router.push(`/tasks/${taskId}`);
        router.refresh();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  const id = (s: string) => `${uid}-${s}`;
  const savedRepos = repos.filter((r) => r.url);

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <div className="rounded-lg border border-sky-500/40 bg-sky-500/10 px-4 py-3 text-sm text-sky-300 flex gap-2">
        <Eye className="size-4 mt-0.5 shrink-0" />
        <span>
          A review-only ticket goes straight to <strong>In Review</strong> as a reminder to review work done elsewhere,
          such as a commit pushed by hand or from another session. It never runs an agent and spends no tokens.
          Approve it to move it to Done.
        </span>
      </div>

      <div className="flex flex-col gap-4">
        <div>
          <Label htmlFor={id("title")}>Title <span className="text-muted-foreground font-normal">(optional)</span></Label>
          <Input
            id={id("title")}
            className="mt-1"
            value={values.title}
            onChange={(e) => set("title", e.target.value)}
            placeholder="Defaults from the description"
          />
        </div>
        <div>
          <Label htmlFor={id("description")}>Description</Label>
          <Textarea
            id={id("description")}
            className="mt-1 min-h-32"
            value={values.description}
            onChange={(e) => set("description", e.target.value)}
            placeholder="What to review and why, e.g. the commit message"
            required
          />
        </div>
      </div>

      <fieldset className="flex flex-col gap-4 rounded-lg border border-border/50 p-4">
        <legend className="px-1 text-sm font-medium">What to review <span className="text-muted-foreground font-normal">(all optional)</span></legend>
        <div>
          <Label htmlFor={id("repo")}>Repository</Label>
          <Input
            id={id("repo")}
            className="mt-1 font-mono text-sm"
            list={id("repos")}
            value={values.repo}
            onChange={(e) => set("repo", e.target.value)}
            placeholder="Pick a saved repo or paste any Git URL"
            aria-invalid={Boolean(errorFor("repo"))}
          />
          <datalist id={id("repos")}>
            {savedRepos.map((r) => <option key={r.url} value={r.url}>{r.alias}</option>)}
          </datalist>
          {errorFor("repo") && <p className="text-xs text-destructive mt-1">{errorFor("repo")}</p>}
        </div>
        <div>
          <Label htmlFor={id("branch")}>Branch</Label>
          <Input
            id={id("branch")}
            className="mt-1 font-mono text-sm"
            value={values.branch}
            onChange={(e) => set("branch", e.target.value)}
            placeholder="e.g. develop"
            aria-invalid={Boolean(errorFor("branch"))}
          />
          {errorFor("branch") && <p className="text-xs text-destructive mt-1">{errorFor("branch")}</p>}
        </div>
        <div>
          <Label htmlFor={id("commits")}>Commit IDs</Label>
          <Input
            id={id("commits")}
            className="mt-1 font-mono text-sm"
            value={values.commits}
            onChange={(e) => set("commits", e.target.value)}
            placeholder="One or more SHAs, short or full, separated by commas or spaces"
            aria-invalid={Boolean(errorFor("commits"))}
          />
          {errorFor("commits")
            ? <p className="text-xs text-destructive mt-1">{errorFor("commits")}</p>
            : <p className="text-xs text-muted-foreground mt-1">7 to 40 hex characters each. Stored as given.</p>}
        </div>
        <div>
          <Label htmlFor={id("prUrl")}>Pull request link</Label>
          <Input
            id={id("prUrl")}
            className="mt-1 text-sm"
            type="url"
            value={values.prUrl}
            onChange={(e) => set("prUrl", e.target.value)}
            placeholder="https://github.com/owner/repo/pull/123"
            aria-invalid={Boolean(errorFor("prUrl"))}
          />
          {errorFor("prUrl") && <p className="text-xs text-destructive mt-1">{errorFor("prUrl")}</p>}
        </div>
      </fieldset>

      <AdvancedOptions
        heading="Options"
        fields={["priority", "labels", "context"]}
        values={{ priority: values.priority, labels: values.labels, context: values.context }}
        onChange={(patch) => {
          if (patch.priority !== undefined) set("priority", patch.priority ?? DEFAULT_PRIORITY);
          if (patch.labels !== undefined) set("labels", patch.labels);
          if (patch.context !== undefined) set("context", patch.context);
        }}
        hints={{ priority: "Shown on the ticket and used to sort the board.", context: "Extra background for the reviewer." }}
        slots={{
          end: (
            <div>
              <Label htmlFor={id("notes")}>Notes <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Textarea
                id={id("notes")}
                className="mt-1"
                value={values.notes}
                onChange={(e) => set("notes", e.target.value)}
                placeholder="Private notes on the ticket"
              />
            </div>
          ),
        }}
      />

      <div className="flex gap-3 justify-end">
        <Link href={cancelHref} className={buttonVariants({ variant: "ghost" })}>Cancel</Link>
        <Button type="submit" disabled={saving}>
          {saving ? (mode === "create" ? "Creating..." : "Saving...") : mode === "create" ? "Create Review Ticket" : "Save"}
        </Button>
      </div>
    </form>
  );
}
