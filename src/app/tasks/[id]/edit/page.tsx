"use client";
import { useState, useEffect, useRef, use, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { toast } from "sonner";
import type { Task, TaskAttachment, TaskContextFile } from "@/lib/types";
import { TaskFormContent, deriveAlias, type Repo, type RepoTestState, type RepoHistory } from "@/components/TaskFormContent";
import type { OutputType } from "@/components/OutputTypeSelector";
import { normalizeOutputType } from "@/lib/output-type";
import { PromptBuilderModal } from "@/components/PromptBuilderModal";
import { DEFAULT_PRIORITY, normalizePriority } from "@/lib/priority";
import { normalizeEffort } from "@/lib/effort";
import { normalizeToolAccess, type ToolAccessMap } from "@/lib/agent-tools";
import { ReviewTaskForm, reviewFormValuesFromTask } from "@/components/ReviewTaskForm";

function toLocalDatetimeValue(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function EditTaskPageContent({ id }: { id: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const reenable = searchParams.get("reenable") === "true";
  const savedRef = useRef(false);
  const [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isRecurring, setIsRecurring] = useState(false);
  const [cronExpression, setCronExpression] = useState("");
  // "" == unlimited runs. `runCount` is read-only here — it's how many scheduled runs the
  // template has already fired, shown next to the cap so the user knows what's left.
  const [maxRuns, setMaxRuns] = useState("");
  const [runCount, setRunCount] = useState(0);
  const [gitMode, setGitMode] = useState<"branch" | "target" | "main" | "pr">("pr");
  const [targetBranch, setTargetBranch] = useState("");
  const [form, setForm] = useState({ title: "", description: "", context: "", scheduledFor: "", tokenBudget: "", costBudget: "" });
  const [labels, setLabels] = useState<string[]>([]);
  const [attachments, setAttachments] = useState<TaskAttachment[]>([]);
  const [attachmentsFolder, setAttachmentsFolder] = useState<string>("");
  const [contextFiles, setContextFiles] = useState<TaskContextFile[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repoTests, setRepoTests] = useState<Record<number, RepoTestState>>({});
  const [repoHistory, setRepoHistory] = useState<RepoHistory[]>([]);
  const [addToBacklog, setAddToBacklog] = useState(false);
  const [promptBuilderOpen, setPromptBuilderOpen] = useState(false);
  const [aiProviderId, setAiProviderId] = useState<string | null>(null);
  const [useSmartProvider, setUseSmartProvider] = useState(false);
  const [taskModel, setTaskModel] = useState<string | null>(null);
  const [dependsOnTaskId, setDependsOnTaskId] = useState<string | null>(null);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [priority, setPriority] = useState<string>(DEFAULT_PRIORITY);
  const [effort, setEffort] = useState<string | null>(null);
  const [toolAccess, setToolAccess] = useState<ToolAccessMap>({});
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [createValidationTask, setCreateValidationTask] = useState(false);
  const [allowSubtasks, setAllowSubtasks] = useState(false);
  const [outputType, setOutputType] = useState<OutputType>("repository");
  const [autoApplyPreviousRunSettings, setAutoApplyPreviousRunSettings] = useState(false);

  function refreshRepoHistory() {
    fetch("/api/repos")
      .then((r) => r.json())
      .then((data) => setRepoHistory(data as RepoHistory[]))
      .catch(() => {});
  }

  useEffect(() => {
    refreshRepoHistory();
  }, []);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data: Record<string, string>) => {
        setAutoApplyPreviousRunSettings(data.git_auto_apply_previous_run_settings === "true");
      })
      .catch(() => {});
  }, []);

  // Re-enable the task on unmount if the user didn't save (cancel / navigation away)
  useEffect(() => {
    if (!reenable) return;
    return () => {
      if (!savedRef.current) {
        void fetch(`/api/tasks/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isEnabled: true }),
        }).catch(() => {});
      }
    };
  }, [id, reenable]);

  useEffect(() => {
    fetch(`/api/tasks/${id}`)
      .then((r) => r.json())
      .then((t: Task) => {
        setTask(t);
        setForm({
          title: t.title,
          description: t.description,
          context: t.context ?? "",
          scheduledFor: toLocalDatetimeValue(t.scheduledFor),
          tokenBudget: t.tokenBudget ? String(t.tokenBudget) : "",
          costBudget: t.costBudget ? String(t.costBudget) : "",
        });
        // Parse attachments from JSON string
        if (t.attachments) {
          try {
            const parsed = JSON.parse(t.attachments) as TaskAttachment[];
            if (Array.isArray(parsed)) setAttachments(parsed);
          } catch { /* ignore */ }
        }
        setAttachmentsFolder((t as { attachmentsFolder?: string | null }).attachmentsFolder ?? "");
        // Parse context files from JSON string
        const ctxRaw = (t as { contextFiles?: string | null }).contextFiles;
        if (ctxRaw) {
          try {
            const parsed = JSON.parse(ctxRaw) as TaskContextFile[];
            if (Array.isArray(parsed)) setContextFiles(parsed);
          } catch { /* ignore */ }
        }
        // Parse labels from JSON string
        if (t.labels) {
          try {
            const parsed = JSON.parse(t.labels) as string[];
            if (Array.isArray(parsed)) setLabels(parsed);
          } catch { /* ignore */ }
        }
        // If reenable=true, the task was temporarily disabled — treat as enabled
        setAddToBacklog(reenable ? false : !t.isEnabled);
        if (t.repos?.length) setRepos(t.repos.map((r) => ({ url: r.url, branch: (r as { url: string; branch?: string | null }).branch ?? undefined })));
        if (t.isRecurringTemplate && t.cronExpression) {
          setIsRecurring(true);
          setCronExpression(t.cronExpression);
          setMaxRuns(t.maxRuns ? String(t.maxRuns) : "");
          setRunCount(t.runCount ?? 0);
        }
        if (t.targetBranch) { setGitMode("target"); setTargetBranch(t.targetBranch); }
        else if (t.pushToMain) setGitMode("main");
        else if (t.createPR) setGitMode("pr");
        setAiProviderId(t.aiProviderId ?? null);
        setUseSmartProvider(Boolean((t as { useSmartProvider?: boolean }).useSmartProvider));
        setTaskModel(t.model ?? null);
        setDependsOnTaskId((t as { dependsOnTaskId?: string | null }).dependsOnTaskId ?? null);
        setTeamId((t as { teamId?: string | null }).teamId ?? null);
        setPriority(normalizePriority((t as { priority?: string | null }).priority));
        setEffort(normalizeEffort((t as { effort?: string | null }).effort));
        setToolAccess(normalizeToolAccess((t as { toolAccess?: string | null }).toolAccess));
        setSystemPrompt((t as { systemPrompt?: string | null }).systemPrompt ?? null);
        setCreateValidationTask(Boolean((t as { createValidationTask?: boolean }).createValidationTask));
        setAllowSubtasks(Boolean((t as { allowSubtasks?: boolean }).allowSubtasks));
        setOutputType(normalizeOutputType((t as { outputType?: string }).outputType));
        setLoading(false);
      })
      .catch(() => {
        toast.error("Failed to load task");
        setLoading(false);
      });
  }, [id, reenable]);

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const addRepo = () => setRepos((r) => [...r, { url: "" }]);
  const removeRepo = (i: number) => {
    setRepos((r) => r.filter((_, idx) => idx !== i));
    setRepoTests((t) => {
      const next: Record<number, RepoTestState> = {};
      Object.entries(t).forEach(([k, v]) => {
        const idx = Number(k);
        if (idx < i) next[idx] = v;
        else if (idx > i) next[idx - 1] = v;
      });
      return next;
    });
  };
  const setRepo = (i: number, v: string) => {
    setRepos((r) => r.map((repo, idx) => (idx === i ? { ...repo, url: v } : repo)));
    setRepoTests((t) => ({ ...t, [i]: { status: "idle", output: "" } }));
  };
  const setRepoBranch = (i: number, branch: string) => {
    setRepos((r) => r.map((repo, idx) => (idx === i ? { ...repo, branch: branch || undefined } : repo)));
  };

  // When a repo is picked from the history dropdown, only fill in the URL —
  // remembered settings are applied separately (see applyPreviousRunSettings)
  // via an explicit "Use previous run settings" button, so picking a repo
  // never silently overrides settings the user already chose.
  function selectRepoFromHistory(i: number, entry: RepoHistory) {
    setRepos((r) => r.map((repo, idx) => (idx === i ? { ...repo, url: entry.url } : repo)));
    // When "Auto-apply previous run settings" is enabled globally (Settings →
    // Git), skip the extra "Use previous run settings" click and apply the
    // remembered branch / "after task completes" defaults right away.
    if (autoApplyPreviousRunSettings) applyPreviousRunSettings(i, entry);
  }

  // Fired by the "Use previous run settings" button: prepopulate the branch
  // the repo was last cloned at and the "after task completes" setting last
  // used with it. Deferred so it runs after TaskFormContent's own effect that
  // auto-syncs targetBranch from the repo's clone branch (which would
  // otherwise clobber it).
  function applyPreviousRunSettings(i: number, entry: RepoHistory) {
    setRepos((r) => r.map((repo, idx) => (idx === i ? { ...repo, branch: entry.lastBranch ?? repo.branch } : repo)));
    if (!entry.lastGitMode) return;
    setTimeout(() => {
      setGitMode(entry.lastGitMode!);
      setTargetBranch(entry.lastGitMode === "target" ? (entry.lastTargetBranch ?? "") : "");
    }, 0);
  }

  async function testRepo(i: number, url: string) {
    setRepoTests((t) => ({ ...t, [i]: { status: "testing", output: "" } }));
    try {
      const res = await fetch("/api/git/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json() as { ok: boolean; output: string };
      setRepoTests((t) => ({ ...t, [i]: { status: data.ok ? "ok" : "error", output: data.output } }));
    } catch (err) {
      setRepoTests((t) => ({ ...t, [i]: { status: "error", output: err instanceof Error ? err.message : "Request failed" } }));
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (gitMode === "target" && !targetBranch.trim()) {
      toast.error("Enter a branch name");
      return;
    }
    if (outputType === "repository" && repos.filter((r) => r.url.trim()).length === 0) {
      toast.error("Add at least one Git repository, it's required for \"Commit to repository\" tasks");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: form.title,
          description: form.description,
          context: form.context || null,
          cronExpression: isRecurring ? cronExpression : null,
          maxRuns: isRecurring ? (maxRuns.trim() || null) : null,
          scheduledFor: !isRecurring && form.scheduledFor ? new Date(form.scheduledFor).toISOString() : null,
          pushToMain: gitMode === "main",
          targetBranch: gitMode === "target" ? targetBranch.trim() : null,
          createPR: gitMode === "pr",
          isEnabled: !addToBacklog,
          tokenBudget: form.tokenBudget ? parseInt(form.tokenBudget, 10) : null,
          costBudget: form.costBudget ? parseFloat(form.costBudget) : null,
          attachments: attachments.length > 0 ? attachments : null,
          attachmentsFolder: attachmentsFolder.trim() || null,
          contextFiles: contextFiles.length > 0 ? contextFiles : null,
          labels: labels.length > 0 ? labels : null,
          repos: repos.filter((r) => r.url).map((r) => ({ url: r.url, alias: deriveAlias(r.url), branch: r.branch || undefined })),
          aiProviderId: useSmartProvider ? null : aiProviderId,
          useSmartProvider: useSmartProvider,
          model: taskModel || null,
          dependsOnTaskId: dependsOnTaskId || null,
          teamId: teamId || null,
          priority,
          effort: effort || null,
          toolAccess,
          systemPrompt: systemPrompt || null,
          createValidationTask: createValidationTask || false,
          allowSubtasks: allowSubtasks || false,
          outputType,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      savedRef.current = true;
      toast.success("Task updated");
      router.push(task?.isRecurringTemplate ? "/tasks" : `/tasks/${id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update task");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto">
        <div className="h-8 w-32 bg-muted rounded animate-pulse mb-6" />
        <div className="h-48 bg-muted rounded animate-pulse" />
      </div>
    );
  }

  if (!task) {
    return (
      <div className="max-w-7xl mx-auto">
        <p className="text-muted-foreground">Task not found.</p>
        <Link href="/tasks" className={buttonVariants({ variant: "outline" }) + " mt-4"}>Back</Link>
      </div>
    );
  }

  // Review-only tickets never run, so they get the review form (ticket fields +
  // review metadata) instead of the run settings.
  if (task.reviewOnly) {
    return (
      <div className="max-w-3xl mx-auto">
        <h1 className="text-2xl font-bold mb-6">Edit Review Ticket</h1>
        <ReviewTaskForm mode="edit" taskId={task.id} initial={reviewFormValuesFromTask(task)} cancelHref={`/tasks/${task.id}`} />
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Edit Task</h1>

      <form onSubmit={handleSubmit} className="flex flex-col gap-6">
        <TaskFormContent
          title={form.title}
          description={form.description}
          context={form.context}
          isRecurring={isRecurring}
          cronExpression={cronExpression}
          maxRuns={maxRuns}
          runCount={runCount}
          scheduledFor={form.scheduledFor}
          tokenBudget={form.tokenBudget}
          costBudget={form.costBudget}
          attachments={attachments}
          attachmentsFolder={attachmentsFolder}
          contextFiles={contextFiles}
          gitMode={gitMode}
          targetBranch={targetBranch}
          repos={repos}
          repoTests={repoTests}
          repoHistory={repoHistory}
          addToBacklog={addToBacklog}
          onChange={set}
          onIsRecurringChange={setIsRecurring}
          onCronExpressionChange={setCronExpression}
          onMaxRunsChange={setMaxRuns}
          onGitModeChange={setGitMode}
          onTargetBranchChange={setTargetBranch}
          onAddToBacklogChange={setAddToBacklog}
          onAddRepo={addRepo}
          onRemoveRepo={removeRepo}
          onSetRepo={setRepo}
          onSetRepoBranch={setRepoBranch}
          onTestRepo={testRepo}
          onSelectRepoHistory={selectRepoFromHistory}
          onApplyRepoHistory={applyPreviousRunSettings}
          onAttachmentsChange={setAttachments}
          onAttachmentsFolderChange={setAttachmentsFolder}
          onContextFilesChange={setContextFiles}
          labels={labels}
          onLabelsChange={setLabels}
          isRecurringTemplate={task.isRecurringTemplate}
          showRecurringToggle={!task.isRecurringTemplate}
          showTokenBudget={false}
          showCostBudget={true}
          showScheduleAsToggle={!task.isRecurringTemplate}
          onOpenPromptBuilder={() => setPromptBuilderOpen(true)}
          aiProviderId={aiProviderId}
          onAiProviderIdChange={setAiProviderId}
          useSmartProvider={useSmartProvider}
          onUseSmartProviderChange={setUseSmartProvider}
          taskModel={taskModel}
          onTaskModelChange={setTaskModel}
          dependsOnTaskId={dependsOnTaskId}
          onDependsOnTaskIdChange={setDependsOnTaskId}
          teamId={teamId}
          onTeamIdChange={setTeamId}
          excludeTaskId={id}
          priority={priority}
          onPriorityChange={setPriority}
          effort={effort}
          onEffortChange={setEffort}
          toolAccess={toolAccess}
          onToolAccessChange={setToolAccess}
          systemPrompt={systemPrompt}
          onSystemPromptChange={setSystemPrompt}
          createValidationTask={createValidationTask}
          onCreateValidationTaskChange={!task.isRecurringTemplate ? setCreateValidationTask : undefined}
          allowSubtasks={allowSubtasks}
          onAllowSubtasksChange={setAllowSubtasks}
          onRepoHistoryRefresh={refreshRepoHistory}
          outputType={outputType}
          onOutputTypeChange={setOutputType}
        />
        <div className="flex gap-3 justify-end">
          <Link href={task.isRecurringTemplate ? "/tasks" : `/tasks/${id}`} className={buttonVariants({ variant: "ghost" })}>Cancel</Link>
          <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save Changes"}</Button>
        </div>
      </form>

      {promptBuilderOpen && (
        <PromptBuilderModal
          initialDescription={form.description}
          onUsePrompt={(prompt) => {
            const previousDescription = form.description;
            set("description", prompt);
            setPromptBuilderOpen(false);
            toast.success("Prompt applied", {
              action: {
                label: "Undo",
                onClick: () => set("description", previousDescription),
              },
            });
          }}
          onClose={() => setPromptBuilderOpen(false)}
        />
      )}
    </div>
  );
}

export default function EditTaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense>
      <EditTaskPageContent id={id} />
    </Suspense>
  );
}
