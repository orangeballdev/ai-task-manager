"use client";
import { copyToClipboard } from "@/lib/clipboard";
import { useState, useEffect, useCallback, useSyncExternalStore } from "react";
import { fetchJson } from "@/lib/fetch-json";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Copy, Pencil, Trash2, Plus, X, RefreshCw, ChevronDown, Activity } from "lucide-react";
import Link from "next/link";

interface Webhook {
  id: string;
  name: string;
  slug: string;
  secretToken: string;
  secretHeader: string;
  taskTitle: string;
  taskDescription: string;
  taskContext: string | null;
  repoUrl: string | null;
  repoAlias: string | null;
  isEnabled: boolean;
  createdAt: string;
}

interface FormState {
  name: string;
  slug: string;
  secretToken: string;
  secretHeader: string;
  taskTitle: string;
  taskDescription: string;
  taskContext: string;
  repoUrl: string;
  isEnabled: boolean;
}

interface Template {
  label: string;
  fields: Partial<Omit<FormState, "name" | "slug" | "secretToken" | "isEnabled" | "secretHeader">>;
  secretHeader?: string;
}

const TEMPLATES: Template[] = [
  {
    label: "Bitbucket: PR Review",
    secretHeader: "X-Webhook-Secret",
    fields: {
      taskTitle: "Review PR: {{body.pullrequest.title}}",
      taskDescription:
        "Review the pull request and post your feedback as a comment via the Bitbucket REST API.\n\n" +
        "PR #{{body.pullrequest.id}}: {{body.pullrequest.title}}\n" +
        "Author: {{body.pullrequest.author.display_name}}\n" +
        "Branch: {{body.pullrequest.source.branch.name}} → {{body.pullrequest.destination.branch.name}}\n\n" +
        "PR description:\n{{body.pullrequest.description}}\n\n" +
        "IMPORTANT: Only review the changed code. Run the following to see what changed:\n" +
        "  git fetch origin\n" +
        "  git diff origin/{{body.pullrequest.destination.branch.name}}...origin/{{body.pullrequest.source.branch.name}}\n" +
        "Review only the files and lines shown in that diff. Do not review the entire codebase.\n\n" +
        "When done, post a summary comment to:\n" +
        "{{body.pullrequest.links.self.href}}/comments\n" +
        "Use the git access token from your environment for authentication.",
      taskContext:
        "PR URL: {{body.pullrequest.links.html.href}}\n" +
        "Comments API: {{body.pullrequest.links.self.href}}/comments\n" +
        "Base branch: {{body.pullrequest.destination.branch.name}}\n" +
        "Head branch: {{body.pullrequest.source.branch.name}}",
      repoUrl: "{{body.repository.links.clone.0.href}}",
    },
  },
  {
    label: "GitHub: PR Review",
    secretHeader: "X-Hub-Signature-256",
    fields: {
      taskTitle: "Review PR: {{body.pull_request.title}}",
      taskDescription:
        "Review the pull request and post your feedback as a review comment via the GitHub REST API.\n\n" +
        "PR #{{body.number}}: {{body.pull_request.title}}\n" +
        "Author: {{body.pull_request.user.login}}\n" +
        "Branch: {{body.pull_request.head.ref}} → {{body.pull_request.base.ref}}\n\n" +
        "PR body:\n{{body.pull_request.body}}\n\n" +
        "IMPORTANT: Only review the changed code. Run the following to see what changed:\n" +
        "  git fetch origin\n" +
        "  git diff origin/{{body.pull_request.base.ref}}...origin/{{body.pull_request.head.ref}}\n" +
        "Review only the files and lines shown in that diff. Do not review the entire codebase.\n\n" +
        "Post a review to: {{body.pull_request.url}}/reviews",
      taskContext:
        "PR URL: {{body.pull_request.html_url}}\n" +
        "Reviews API: {{body.pull_request.url}}/reviews\n" +
        "Base branch: {{body.pull_request.base.ref}}\n" +
        "Head branch: {{body.pull_request.head.ref}}",
      repoUrl: "{{body.repository.clone_url}}",
    },
  },
  {
    label: "GitLab: MR Review",
    secretHeader: "X-Gitlab-Token",
    fields: {
      taskTitle: "Review MR: {{body.object_attributes.title}}",
      taskDescription:
        "Review the merge request and post your feedback as a note via the GitLab REST API.\n\n" +
        "MR #{{body.object_attributes.iid}}: {{body.object_attributes.title}}\n" +
        "Author: {{body.user.name}}\n" +
        "Branch: {{body.object_attributes.source_branch}} → {{body.object_attributes.target_branch}}\n\n" +
        "MR description:\n{{body.object_attributes.description}}\n\n" +
        "IMPORTANT: Only review the changed code. Run the following to see what changed:\n" +
        "  git fetch origin\n" +
        "  git diff origin/{{body.object_attributes.target_branch}}...origin/{{body.object_attributes.source_branch}}\n" +
        "Review only the files and lines shown in that diff. Do not review the entire codebase.\n\n" +
        "When done, post a note to the MR using the GitLab API. Use the git access token from your environment (PRIVATE-TOKEN header).",
      taskContext:
        "MR URL: {{body.object_attributes.url}}\n" +
        "Notes API: {{body.project.web_url}}/api/v4/projects/{{body.project.id}}/merge_requests/{{body.object_attributes.iid}}/notes\n" +
        "Base branch: {{body.object_attributes.target_branch}}\n" +
        "Head branch: {{body.object_attributes.source_branch}}",
      repoUrl: "{{body.project.git_http_url}}",
    },
  },
];

const emptyForm = (): FormState => ({
  name: "",
  slug: "",
  secretToken: globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36),
  secretHeader: "X-Webhook-Secret",
  taskTitle: "",
  taskDescription: "",
  taskContext: "",
  repoUrl: "",
  isEnabled: true,
});

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

interface WebhookEvent {
  id: string;
  status: string;
  taskId: string | null;
  errorMessage: string | null;
  createdAt: string;
}

// window.location.origin never changes for the lifetime of the page.
const subscribeToNothing = () => () => {};

function TriggerUrl({ slug }: { slug: string }) {
  // "" during SSR/hydration, the real origin once on the client.
  const origin = useSyncExternalStore(subscribeToNothing, () => window.location.origin, () => "");
  const url = `${origin}/api/webhooks/receive/${slug}`;
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <code className="text-xs text-muted-foreground truncate flex-1">{url}</code>
      <button
        type="button"
        onClick={() => copyToClipboard(url).then(() => toast.success("URL copied"), () => toast.error("Failed to copy to clipboard"))}
        className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
        title="Copy URL"
      >
        <Copy className="size-3.5" />
      </button>
    </div>
  );
}

const statusColors: Record<string, string> = {
  success: "text-green-500",
  unauthorized: "text-yellow-500",
  error: "text-red-500",
};

function WebhookRow({
  webhook,
  onEdit,
  onDelete,
  onToggle,
  deletingId,
}: {
  webhook: Webhook;
  onEdit: (w: Webhook) => void;
  onDelete: (id: string) => void;
  onToggle: (w: Webhook) => void;
  deletingId: string | null;
}) {
  const [eventsOpen, setEventsOpen] = useState(false);
  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);

  async function loadEvents() {
    setEventsLoading(true);
    try {
      const res = await fetch(`/api/webhooks/${webhook.id}/events`);
      const data = await res.json();
      setEvents(Array.isArray(data) ? data : []);
      if (!Array.isArray(data)) toast.error(data?.error ?? "Failed to load events");
    } catch {
      toast.error("Failed to load events");
    } finally {
      setEventsLoading(false);
    }
  }

  function toggleEvents() {
    if (!eventsOpen) loadEvents();
    setEventsOpen((o) => !o);
  }

  return (
    <Card>
      <CardContent className="py-3 px-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1 min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{webhook.name}</span>
              <Badge variant={webhook.isEnabled ? "default" : "secondary"} className="text-xs">
                {webhook.isEnabled ? "enabled" : "disabled"}
              </Badge>
              <span className="text-xs text-muted-foreground font-mono">{webhook.secretHeader}</span>
            </div>
            <TriggerUrl slug={webhook.slug} />
            <p className="text-xs text-muted-foreground truncate">{webhook.taskTitle}</p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={toggleEvents}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded hover:bg-muted"
              title="View event log"
            >
              <Activity className="size-3.5" />
              <ChevronDown className={`size-3 transition-transform ${eventsOpen ? "rotate-180" : ""}`} />
            </button>
            <Button variant="ghost" size="sm" className="text-xs h-7 px-2" onClick={() => onToggle(webhook)}>
              {webhook.isEnabled ? "Disable" : "Enable"}
            </Button>
            <Button variant="ghost" size="icon" className="size-7" onClick={() => onEdit(webhook)}>
              <Pencil className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-destructive hover:text-destructive"
              onClick={() => onDelete(webhook.id)}
              disabled={deletingId === webhook.id}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        </div>

        {eventsOpen && (
          <div className="mt-3 border-t border-border pt-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-muted-foreground">Recent events</span>
              <button
                type="button"
                onClick={loadEvents}
                disabled={eventsLoading}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              >
                {eventsLoading ? "Loading..." : "Refresh"}
              </button>
            </div>
            {eventsLoading ? null : events.length === 0 ? (
              <p className="text-xs text-muted-foreground">No events recorded yet.</p>
            ) : (
              <div className="flex flex-col gap-1">
                {events.map((event) => (
                  <div key={event.id} className="flex items-start gap-3 text-xs">
                    <span className="text-muted-foreground shrink-0 w-36 tabular-nums">
                      {new Date(event.createdAt).toLocaleString()}
                    </span>
                    <span className={`shrink-0 w-20 font-medium ${statusColors[event.status] ?? "text-muted-foreground"}`}>
                      {event.status}
                    </span>
                    {event.taskId ? (
                      <Link href={`/tasks/${event.taskId}`} className="text-blue-400 hover:underline truncate">
                        task/{event.taskId.slice(0, 8)}
                      </Link>
                    ) : event.errorMessage ? (
                      <span className="text-muted-foreground truncate" title={event.errorMessage}>
                        {event.errorMessage}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function WebhooksPage() {
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [templateOpen, setTemplateOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setWebhooks(await fetchJson<Webhook[]>("/api/webhooks"));
    } catch {
      toast.error("Failed to load webhooks");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchJson<Webhook[]>("/api/webhooks")
      .then((data) => { if (!cancelled) setWebhooks(data); })
      .catch(() => { if (!cancelled) toast.error("Failed to load webhooks"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm());
    setShowForm(true);
    setTemplateOpen(false);
  }

  function openEdit(webhook: Webhook) {
    setEditingId(webhook.id);
    setForm({
      name: webhook.name,
      slug: webhook.slug,
      secretToken: "",
      secretHeader: webhook.secretHeader,
      taskTitle: webhook.taskTitle,
      taskDescription: webhook.taskDescription,
      taskContext: webhook.taskContext ?? "",
      repoUrl: webhook.repoUrl ?? "",
      isEnabled: webhook.isEnabled,
    });
    setShowForm(true);
    setTemplateOpen(false);
  }

  function closeForm() {
    setShowForm(false);
    setEditingId(null);
    setTemplateOpen(false);
  }

  function applyTemplate(template: Template) {
    setForm((f) => ({
      ...f,
      ...template.fields,
      ...(template.secretHeader ? { secretHeader: template.secretHeader } : {}),
    }));
    setTemplateOpen(false);
    toast.success(`Template "${template.label}" applied`);
  }

  function handleNameChange(name: string) {
    setForm((f) => ({
      ...f,
      name,
      slug: editingId ? f.slug : slugify(name),
    }));
  }

  async function handleSave() {
    if (!form.name.trim() || !form.taskTitle.trim() || !form.taskDescription.trim()) {
      toast.error("Name, Task Title, and Task Description are required");
      return;
    }
    if (!editingId && !form.secretToken.trim()) {
      toast.error("Secret token is required");
      return;
    }

    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        slug: form.slug.trim() || slugify(form.name),
        secretHeader: form.secretHeader.trim() || "X-Webhook-Secret",
        taskTitle: form.taskTitle.trim(),
        taskDescription: form.taskDescription.trim(),
        taskContext: form.taskContext.trim() || null,
        repoUrl: form.repoUrl.trim() || null,
        isEnabled: form.isEnabled,
      };
      if (!editingId) payload.secretToken = form.secretToken.trim();
      else if (form.secretToken.trim()) payload.secretToken = form.secretToken.trim();

      const res = await fetch(
        editingId ? `/api/webhooks/${editingId}` : "/api/webhooks",
        {
          method: editingId ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );

      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        toast.error(err.error ?? `Failed to save (${res.status} ${res.statusText})`);
        return;
      }

      toast.success(editingId ? "Webhook updated" : "Webhook created");
      closeForm();
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    setDeletingId(id);
    try {
      const res = await fetch(`/api/webhooks/${id}`, { method: "DELETE" });
      if (!res.ok) { toast.error("Failed to delete"); return; }
      toast.success("Webhook deleted");
      await load();
    } finally {
      setDeletingId(null);
    }
  }

  async function handleToggle(webhook: Webhook) {
    const res = await fetch(`/api/webhooks/${webhook.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isEnabled: !webhook.isEnabled }),
    });
    if (!res.ok) { toast.error("Failed to update"); return; }
    await load();
  }

  return (
    <div className="max-w-7xl mx-auto flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Webhooks</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Configure HTTP endpoints that trigger tasks when called by external services.
          </p>
        </div>
        {!showForm && (
          <Button size="sm" onClick={openCreate}>
            <Plus className="size-4 mr-1.5" />
            New Webhook
          </Button>
        )}
      </div>

      {showForm && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">{editingId ? "Edit Webhook" : "New Webhook"}</CardTitle>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setTemplateOpen((o) => !o)}
                    className="text-xs"
                  >
                    Load template
                    <ChevronDown className={`size-3.5 ml-1 transition-transform ${templateOpen ? "rotate-180" : ""}`} />
                  </Button>
                  {templateOpen && (
                    <div className="absolute right-0 top-full mt-1 z-10 w-52 rounded-md border border-border bg-background shadow-md">
                      {TEMPLATES.map((t) => (
                        <button
                          key={t.label}
                          type="button"
                          onClick={() => applyTemplate(t)}
                          className="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors first:rounded-t-md last:rounded-b-md"
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <Button variant="ghost" size="icon" onClick={closeForm}><X className="size-4" /></Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="wh-name">Name</Label>
                <Input id="wh-name" value={form.name} onChange={(e) => handleNameChange(e.target.value)} placeholder="My Webhook" className="mt-1" />
              </div>
              <div>
                <Label htmlFor="wh-slug">Slug</Label>
                <Input id="wh-slug" value={form.slug} onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))} placeholder="my-webhook" className="mt-1 font-mono text-sm" />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="wh-secret-header">Secret Header</Label>
                <Input
                  id="wh-secret-header"
                  value={form.secretHeader}
                  onChange={(e) => setForm((f) => ({ ...f, secretHeader: e.target.value }))}
                  placeholder="X-Webhook-Secret"
                  className="mt-1 font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground mt-1">Header the caller sends the token in.</p>
              </div>
              <div>
                <Label htmlFor="wh-secret">Secret Token {editingId && <span className="text-muted-foreground font-normal">(blank = keep current)</span>}</Label>
                <div className="flex gap-2 mt-1">
                  <Input
                    id="wh-secret"
                    value={form.secretToken}
                    onChange={(e) => setForm((f) => ({ ...f, secretToken: e.target.value }))}
                    placeholder={editingId ? "Leave blank to keep existing" : ""}
                    className="font-mono text-sm"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    title="Generate new token"
                    onClick={() => setForm((f) => ({ ...f, secretToken: crypto.randomUUID() }))}
                  >
                    <RefreshCw className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    title="Copy token"
                    onClick={() => copyToClipboard(form.secretToken).then(() => toast.success("Token copied"), () => toast.error("Failed to copy to clipboard"))}
                    disabled={!form.secretToken}
                  >
                    <Copy className="size-4" />
                  </Button>
                </div>
              </div>
            </div>

            <div className="border-t border-border pt-4">
              <p className="text-xs text-muted-foreground mb-3">
                Task template: use <code className="bg-muted px-1 py-0.5 rounded">{"{{body.field.path}}"}</code> or <code className="bg-muted px-1 py-0.5 rounded">{"{{headers.header-name}}"}</code> to inject values from the incoming payload.
              </p>
              <div className="flex flex-col gap-3">
                <div>
                  <Label htmlFor="wh-title">Task Title</Label>
                  <Input id="wh-title" value={form.taskTitle} onChange={(e) => setForm((f) => ({ ...f, taskTitle: e.target.value }))} placeholder="Task title (supports template variables)" className="mt-1" />
                </div>
                <div>
                  <Label htmlFor="wh-desc">Task Description</Label>
                  <Textarea id="wh-desc" rows={5} value={form.taskDescription} onChange={(e) => setForm((f) => ({ ...f, taskDescription: e.target.value }))} placeholder="Describe what Claude should do. Use {{body.field}} to include payload values." className="mt-1 text-sm" />
                </div>
                <div>
                  <Label htmlFor="wh-ctx">Task Context <span className="text-muted-foreground font-normal">(optional)</span></Label>
                  <Textarea id="wh-ctx" rows={3} value={form.taskContext} onChange={(e) => setForm((f) => ({ ...f, taskContext: e.target.value }))} placeholder="Additional context or API endpoints Claude may need." className="mt-1 text-sm" />
                </div>
              </div>
            </div>

            <div className="border-t border-border pt-4">
              <p className="text-xs text-muted-foreground mb-3">Repo to clone (optional). Leave blank if the task doesn&apos;t need a repo. The alias is derived automatically from the URL.</p>
              <div>
                <Label htmlFor="wh-repo-url">Repo URL</Label>
                <Input id="wh-repo-url" value={form.repoUrl} onChange={(e) => setForm((f) => ({ ...f, repoUrl: e.target.value }))} placeholder="https://... or {{body.repository.clone_url}}" className="mt-1 font-mono text-xs" />
              </div>
            </div>

            <div className="flex items-center justify-between pt-1">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.isEnabled}
                  onChange={(e) => setForm((f) => ({ ...f, isEnabled: e.target.checked }))}
                  className="size-4 rounded border-2 border-muted-foreground accent-primary"
                />
                <span className="text-sm">Enabled</span>
              </label>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={closeForm}>Cancel</Button>
                <Button onClick={handleSave} disabled={saving}>{saving ? "Saving..." : "Save Webhook"}</Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {!showForm && (
        loading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : webhooks.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              No webhooks configured yet. Click <strong>New Webhook</strong> to create one.
            </CardContent>
          </Card>
        ) : (
          <div className="flex flex-col gap-2">
            {webhooks.map((webhook) => (
              <WebhookRow
                key={webhook.id}
                webhook={webhook}
                onEdit={openEdit}
                onDelete={handleDelete}
                onToggle={handleToggle}
                deletingId={deletingId}
              />
            ))}
          </div>
        )
      )}
    </div>
  );
}
