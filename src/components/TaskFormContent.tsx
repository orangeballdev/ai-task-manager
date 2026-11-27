"use client";

import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle, Bookmark, BookmarkCheck, FileText, GitFork, History, Paperclip, Sparkles, Timer, Wand2, X } from "lucide-react";
import { PreviewPromptModal } from "@/components/PreviewPromptModal";
import { OutputTypeSelector, type OutputType } from "@/components/OutputTypeSelector";
import {
  AdvancedOptions,
  ADVANCED_OPTION_FIELDS,
  type AdvancedOptionField,
  type AdvancedOptionsValues,
} from "@/components/AdvancedOptions";
import { ToolAccessPicker } from "@/components/ToolAccessPicker";
import type { ToolAccessMap } from "@/lib/agent-tools";
import { isReadOnlyOutput } from "@/lib/output-type";
import { FolderSelector } from "@/components/FolderSelector";
import { ContextFileSelector } from "@/components/ContextFileSelector";
import { toast } from "sonner";
import type { TaskAttachment, TaskContextFile } from "@/lib/types";
import { extractImageFiles, pastedImageName } from "@/lib/pasted-images";
import { DEFAULT_PRIORITY, type TaskPriority } from "@/lib/priority";
import type { TaskEffort } from "@/lib/effort";
import { getAnalytics } from "@/components/WebAnalytics";

export interface Repo { url: string; branch?: string }
export interface RepoTestState { status: "idle" | "testing" | "ok" | "error"; output: string }
export interface RepoHistory {
  url: string;
  alias: string;
  saved?: boolean;
  // Remembered from the last task that used this repo, so the new-task form
  // can prepopulate the branch + "after task completes" section when this
  // repo is picked again. See GET /api/repos.
  lastBranch?: string;
  lastGitMode?: "branch" | "target" | "main" | "pr";
  lastTargetBranch?: string;
  // Default context saved for this repo on the Repositories page. Prefilled
  // into the task's Context field when the repo is picked (if Context is empty).
  defaultContext?: string;
  // Advanced Options defaults saved for this repo on the Repositories page.
  // Prefilled into the matching fields when the repo is picked, but only for
  // options the user hasn't set by hand — see applyRepoDefaults() in
  // src/app/tasks/new/page.tsx.
  defaultPriority?: TaskPriority;
  defaultEffort?: TaskEffort;
  defaultCostBudget?: number;
  defaultTokenBudget?: number;
  defaultAiProviderId?: string;
  defaultUseSmartProvider?: boolean;
  defaultModel?: string;
  defaultLabels?: string[];
  defaultCreateValidationTask?: boolean;
  // Git defaults saved for this repo on the Repositories page: the branch to
  // clone at and the "after task completes" mode. Prefilled when the repo is
  // picked (branch only if empty, mode only if the user hasn't chosen one).
  defaultBranch?: string;
  defaultGitMode?: "branch" | "target" | "main" | "pr";
  defaultTargetBranch?: string;
  defaultAllowSubtasks?: boolean;
  // Team saved as this repo's default on the Repositories page. Switches "Use a
  // team" on with it when the repo is picked, unless the user already chose.
  defaultTeamId?: string;
}

export function deriveAlias(url: string): string {
  return url.split("/").pop()?.replace(/\.git$/, "") ?? "repo";
}

// Short labels for the "after task completes" git mode, shown as a hint in the
// repo history dropdown so users can see what they picked last time.
const REPO_GIT_MODE_HINTS: Record<"branch" | "target" | "main" | "pr", string> = {
  branch: "push to agent branch",
  target: "push to branch",
  main: "push to main",
  pr: "open a PR",
};

export function nextCronDates(expr: string, count = 3): Date[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { CronExpressionParser } = require("cron-parser") as typeof import("cron-parser");
    const interval = CronExpressionParser.parse(expr);
    return Array.from({ length: count }, () => interval.next().toDate());
  } catch {
    return [];
  }
}

export function RepoUrlInput({
  value,
  onChange,
  onSelect,
  history,
  placeholder,
  className,
  onHistoryRefresh,
}: {
  value: string;
  onChange: (v: string) => void;
  // Fired (in addition to onChange) when the user explicitly picks a repo from
  // the dropdown, carrying its remembered branch / "after task completes" defaults.
  onSelect?: (entry: RepoHistory) => void;
  history: RepoHistory[];
  placeholder?: string;
  className?: string;
  onHistoryRefresh?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [togglingUrl, setTogglingUrl] = useState<string | null>(null);
  const suggestions = history.filter(
    (r) => !value || r.url.toLowerCase().includes(value.toLowerCase())
  );
  const savedSuggestions = suggestions.filter((r) => r.saved);
  const recentSuggestions = suggestions.filter((r) => !r.saved);

  async function toggleSaved(r: RepoHistory, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setTogglingUrl(r.url);
    try {
      if (r.saved) {
        await fetch("/api/repos", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: r.url }),
        });
      } else {
        await fetch("/api/repos", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: r.url, alias: r.alias }),
        });
      }
      onHistoryRefresh?.();
    } catch { /* ignore */ } finally {
      setTogglingUrl(null);
    }
  }

  function renderItem(r: RepoHistory) {
    const hint = [
      r.lastBranch ? `${r.lastBranch} branch` : null,
      r.lastGitMode ? REPO_GIT_MODE_HINTS[r.lastGitMode] : null,
    ].filter(Boolean).join(" · ");
    return (
      <li
        key={r.url}
        className="px-3 py-2 text-sm cursor-pointer hover:bg-accent flex items-center gap-2"
        onMouseDown={(e) => {
          e.preventDefault();
          onChange(r.url);
          onSelect?.(r);
          setOpen(false);
        }}
      >
        <div className="flex flex-col gap-0.5 flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            {r.saved && <BookmarkCheck className="size-3 text-primary shrink-0" />}
            <span className="text-xs text-muted-foreground truncate">{r.alias}</span>
          </div>
          <span className="break-all text-xs">{r.url}</span>
          {hint && <span className="text-[10px] text-muted-foreground/70">Last used: {hint}</span>}
        </div>
        <button
          type="button"
          className={`shrink-0 p-1 rounded hover:bg-muted/60 transition-colors ${togglingUrl === r.url ? "opacity-50" : ""}`}
          onMouseDown={(e) => void toggleSaved(r, e)}
          title={r.saved ? "Remove from saved repos" : "Save this repo for quick access"}
        >
          {r.saved
            ? <BookmarkCheck className="size-3.5 text-primary" />
            : <Bookmark className="size-3.5 text-muted-foreground" />}
        </button>
      </li>
    );
  }

  return (
    <div className="relative">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={className}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && suggestions.length > 0 && (
        <ul className="absolute z-50 top-full left-0 right-0 mt-1 bg-popover border border-border rounded-lg shadow-md max-h-56 overflow-y-auto py-1">
          {savedSuggestions.length > 0 && (
            <>
              <li className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground select-none">Saved</li>
              {savedSuggestions.map(renderItem)}
            </>
          )}
          {recentSuggestions.length > 0 && (
            <>
              {savedSuggestions.length > 0 && <li className="border-t border-border my-1" />}
              <li className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground select-none">Recent</li>
              {recentSuggestions.map(renderItem)}
            </>
          )}
        </ul>
      )}
    </div>
  );
}

export interface TaskFormContentProps {
  // Values
  title: string;
  description: string;
  context: string;
  labels?: string[];
  isRecurring: boolean;
  cronExpression: string;
  /** Max number of scheduled runs for a recurring task. "" means unlimited (the default). */
  maxRuns?: string;
  /** How many scheduled runs the template has already fired (edit form only). */
  runCount?: number;
  scheduledFor: string;
  tokenBudget?: string;
  costBudget?: string;
  attachments?: TaskAttachment[];
  attachmentsFolder?: string;
  contextFiles?: TaskContextFile[];
  gitMode: "branch" | "target" | "main" | "pr";
  targetBranch: string;
  repos: Repo[];
  repoTests: Record<number, RepoTestState>;
  repoHistory: RepoHistory[];
  addToBacklog: boolean;
  outputType?: OutputType;

  // Handlers
  onChange: (field: string, value: string) => void;
  onOutputTypeChange?: (v: OutputType) => void;
  onLabelsChange?: (labels: string[]) => void;
  onIsRecurringChange: (v: boolean) => void;
  onCronExpressionChange: (v: string) => void;
  onMaxRunsChange?: (v: string) => void;
  onGitModeChange: (mode: "branch" | "target" | "main" | "pr") => void;
  onTargetBranchChange: (v: string) => void;
  // Fired only when the *user* picks an "after task completes" option (not
  // when the form auto-syncs it), so callers can stop applying repo defaults.
  onGitModeTouched?: () => void;
  onAddToBacklogChange: (v: boolean) => void;
  onAddRepo: () => void;
  onRemoveRepo: (i: number) => void;
  onSetRepo: (i: number, v: string) => void;
  onSetRepoBranch: (i: number, branch: string) => void;
  onTestRepo: (i: number, url: string) => void;
  // Called when a repo is explicitly picked from the history dropdown. Only
  // applies the URL — remembered branch / "after task completes" settings are
  // applied separately via onApplyRepoHistory, behind an explicit button, so
  // picking a repo never silently overrides settings the user already chose.
  onSelectRepoHistory?: (i: number, entry: RepoHistory) => void;
  // Called when the user clicks "Use previous run settings" for a repo,
  // carrying its remembered branch / "after task completes" defaults so the
  // caller can prepopulate the rest of the git section.
  onApplyRepoHistory?: (i: number, entry: RepoHistory) => void;
  onAttachmentsChange?: (attachments: TaskAttachment[]) => void;
  onAttachmentsFolderChange?: (folder: string) => void;
  onContextFilesChange?: (files: TaskContextFile[]) => void;

  // Provider selection
  aiProviderId?: string | null;
  onAiProviderIdChange?: (id: string | null) => void;
  useSmartProvider?: boolean;
  onUseSmartProviderChange?: (v: boolean) => void;

  // Model override
  taskModel?: string | null;
  onTaskModelChange?: (model: string | null) => void;

  // Dependency
  dependsOnTaskId?: string | null;
  onDependsOnTaskIdChange?: (id: string | null) => void;
  excludeTaskId?: string;

  // Team pipeline — when set, this task runs through the team's members in
  // sequence instead of a single agent handling the whole task (see
  // src/lib/teams.ts and the "Team pipeline" section of src/worker/index.ts).
  teamId?: string | null;
  onTeamIdChange?: (id: string | null) => void;

  // Priority — determines pick-up order when the worker has multiple eligible
  // tasks to choose from (higher priority runs before lower priority, position
  // breaks ties within the same priority level).
  priority?: string | null;
  onPriorityChange?: (v: string) => void;

  // Thinking effort — forwarded to the Claude CLI (`--effort <level>`) or the
  // Anthropic API (`output_config.effort`) by the worker. Null/unset means
  // "use the provider's own default" rather than a specific level.
  effort?: string | null;
  onEffortChange?: (v: string | null) => void;

  // Custom system prompt override (kept for backward compat but merged into context UI)
  systemPrompt?: string | null;
  onSystemPromptChange?: (v: string | null) => void;

  // Per-task agent tool access overrides (tool id -> allow/deny). Tools absent
  // from the map follow Settings → Agent Tools. See src/lib/agent-tools.ts.
  toolAccess?: ToolAccessMap;
  onToolAccessChange?: (v: ToolAccessMap) => void;

  // Follow-up validation task
  createValidationTask?: boolean;
  onCreateValidationTaskChange?: (v: boolean) => void;

  // Agent-created subtasks (src/lib/subtasks.ts)
  allowSubtasks?: boolean;
  onAllowSubtasksChange?: (v: boolean) => void;

  // Config
  isRecurringTemplate?: boolean;
  showRecurringToggle?: boolean;
  showTokenBudget?: boolean;
  showCostBudget?: boolean;
  showScheduleAsToggle?: boolean;
  onOpenPromptBuilder?: () => void;
  providerConfigured?: { configured: boolean; reason: string } | null;
  onSubtaskPreviewChange?: (subtasks: Array<{ title: string; description: string; context: string; enabled: boolean }> | null) => void;
  onRepoHistoryRefresh?: () => void;

  // Fired when the user edits a control inside Advanced Options. The new-task
  // form uses this to remember which options were chosen by hand, so a saved
  // repo's defaults never overwrite them (see src/app/tasks/new/page.tsx).
  onAdvancedFieldTouched?: (field: AdvancedOptionField) => void;

  // Auto-enhance setting
  autoEnhanceDescription?: boolean;

  // External enhancing state (e.g. triggered by auto-enhance on submit)
  isEnhancing?: boolean;
}

export function RepoBranchInput({
  value,
  onChange,
  repoUrl,
  className,
  placeholder = "main",
}: {
  value: string;
  onChange: (v: string) => void;
  repoUrl: string;
  className?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchBranches = async () => {
    if (!repoUrl || branches.length > 0) { setOpen(true); return; }
    setLoading(true);
    try {
      const res = await fetch(`/api/git/branches?url=${encodeURIComponent(repoUrl)}`);
      const data = await res.json() as { branches: string[] };
      setBranches(data.branches ?? []);
    } catch { /* ignore */ } finally {
      setLoading(false);
      setOpen(true);
    }
  };

  const suggestions = value
    ? branches.filter((b) => b.toLowerCase().includes(value.toLowerCase()))
    : branches;

  return (
    <div className="relative">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`font-mono text-sm ${className ?? ""}`}
        onFocus={fetchBranches}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && (loading || suggestions.length > 0) && (
        <ul className="absolute z-50 top-full left-0 right-0 mt-1 bg-popover border border-border rounded-lg shadow-md max-h-48 overflow-y-auto py-1">
          {loading && <li className="px-3 py-2 text-sm text-muted-foreground">Loading branches…</li>}
          {suggestions.map((b) => (
            <li
              key={b}
              className="px-3 py-2 text-sm font-mono cursor-pointer hover:bg-accent"
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(b);
                setOpen(false);
              }}
            >
              {b}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * A small UI helper rendered below a cron expression input.
 * Users can type a plain-English schedule (e.g. "every weekday at 9am")
 * and the AI converts it to a cron expression via /api/tasks/cron-from-text.
 */
function CronNaturalLanguageHelper({
  onGenerate,
}: {
  onGenerate: (text: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleConvert() {
    if (!text.trim() || loading) return;
    setLoading(true);
    try {
      await onGenerate(text.trim());
      setText("");
      setExpanded(false);
    } finally {
      setLoading(false);
    }
  }

  if (!expanded) {
    return (
      <button
        type="button"
        className="text-xs text-primary hover:text-primary/80 transition-colors font-medium"
        onClick={() => setExpanded(true)}
      >
        ✦ Use plain English instead
      </button>
    );
  }

  return (
    <div className="flex gap-2 items-center mt-1">
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); void handleConvert(); }
          if (e.key === "Escape") { setExpanded(false); setText(""); }
        }}
        placeholder='e.g. "every weekday at 9am"'
        autoFocus
        className="flex-1 min-w-0 bg-muted border border-border rounded-md px-3 py-1.5 text-sm focus:outline-none focus:border-primary/60"
        disabled={loading}
      />
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={!text.trim() || loading}
        onClick={() => void handleConvert()}
        className="shrink-0"
      >
        {loading ? "Converting…" : "Convert"}
      </Button>
      <button
        type="button"
        className="text-xs text-muted-foreground hover:text-foreground shrink-0"
        onClick={() => { setExpanded(false); setText(""); }}
      >
        Cancel
      </button>
    </div>
  );
}

/**
 * "Max runs" control for recurring tasks, rendered directly under the cron input.
 *
 * The stored value is a string so the form can round-trip an empty field; "" (and anything
 * that isn't a positive integer) means unlimited, which is the default. When a limit is set
 * we preview the date of the final run so it's obvious what "5 runs" actually buys you.
 */
function MaxRunsField({
  value,
  onChange,
  cronExpression,
  runCount,
}: {
  value: string;
  onChange: (v: string) => void;
  cronExpression: string;
  runCount: number;
}) {
  const limited = value.trim() !== "";
  const parsed = Number(value);
  const validLimit = limited && Number.isFinite(parsed) && Math.floor(parsed) >= 1 ? Math.floor(parsed) : null;
  const remaining = validLimit === null ? null : Math.max(0, validLimit - runCount);

  // Date of the final scheduled run, so "5 runs" reads as a concrete end date. Skipped for
  // large caps — walking hundreds of cron occurrences on every keystroke isn't worth it.
  const lastRunDate = (() => {
    if (remaining === null || remaining < 1 || remaining > 100 || !cronExpression.trim()) return null;
    const dates = nextCronDates(cronExpression.trim(), remaining);
    return dates.length === remaining ? dates[dates.length - 1] : null;
  })();

  return (
    <div className="mt-3">
      <Label htmlFor="maxRuns">Max Runs</Label>
      <div className="flex flex-wrap items-center gap-2 mt-1">
        <label className="flex items-center gap-2 cursor-pointer text-sm">
          <input
            type="radio"
            name="maxRunsMode"
            checked={!limited}
            onChange={() => onChange("")}
            className="size-4 accent-primary"
          />
          Unlimited
        </label>
        <label className="flex items-center gap-2 cursor-pointer text-sm">
          <input
            type="radio"
            name="maxRunsMode"
            checked={limited}
            onChange={() => onChange(String(Math.max(1, runCount + 1)))}
            className="size-4 accent-primary"
          />
          Stop after
        </label>
        <Input
          id="maxRuns"
          type="number"
          min={1}
          step={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="∞"
          className="w-24"
          aria-label="Maximum number of runs"
        />
        <span className="text-sm text-muted-foreground">runs</span>
      </div>
      <p className="text-xs text-muted-foreground mt-1">
        {validLimit === null
          ? "Runs forever until you disable it. Choose “Stop after” to cap the number of runs."
          : `This task will run at most ${validLimit} time${validLimit === 1 ? "" : "s"}, then stop automatically.`}
      </p>
      {validLimit !== null && runCount > 0 && (
        <p className="text-xs text-muted-foreground mt-1">
          {runCount} run{runCount === 1 ? "" : "s"} used so far, {remaining} remaining.
          {remaining === 0 && " Raise the limit to let it run again."}
        </p>
      )}
      {lastRunDate && (
        <p className="text-xs text-muted-foreground mt-1" suppressHydrationWarning>
          <span className="font-medium">Final run: </span>{lastRunDate.toLocaleString()}
        </p>
      )}
      {limited && validLimit === null && (
        <p className="text-xs text-destructive mt-1">Enter a whole number of 1 or more, or pick Unlimited.</p>
      )}
    </div>
  );
}

function DependsOnInput({
  value,
  onChange,
  options,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  options: { id: string; title: string; status: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const selectedTitle = value ? (options.find((t) => t.id === value)?.title ?? "Unknown task") : "";

  const filtered = query
    ? options.filter((t) => t.title.toLowerCase().includes(query.toLowerCase()))
    : options;

  function select(id: string | null) {
    onChange(id);
    setQuery("");
    setOpen(false);
  }

  return (
    <div>
      <Label htmlFor="dependsOn">Depends on <span className="text-muted-foreground font-normal">(optional)</span></Label>
      <div className="relative mt-1">
        <Input
          id="dependsOn"
          value={open ? query : selectedTitle}
          placeholder="Search tasks…"
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          autoComplete="off"
        />
        {value && !open && (
          <button
            type="button"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-xs px-1"
            onMouseDown={(e) => { e.preventDefault(); select(null); }}
          >
            ✕
          </button>
        )}
        {open && (
          <ul className="absolute z-50 top-full left-0 right-0 mt-1 bg-popover border border-border rounded-lg shadow-md max-h-52 overflow-y-auto py-1">
            <li
              className="px-3 py-2 text-sm cursor-pointer hover:bg-accent text-muted-foreground italic"
              onMouseDown={(e) => { e.preventDefault(); select(null); }}
            >
              No dependency
            </li>
            {filtered.length === 0 && (
              <li className="px-3 py-2 text-sm text-muted-foreground">No matches</li>
            )}
            {filtered.map((t) => (
              <li
                key={t.id}
                className={`px-3 py-2 text-sm cursor-pointer hover:bg-accent flex items-center justify-between gap-2 ${value === t.id ? "bg-accent/50" : ""}`}
                onMouseDown={(e) => { e.preventDefault(); select(t.id); }}
              >
                <span className="truncate">{t.title}</span>
                <span className="text-xs text-muted-foreground capitalize shrink-0">{t.status}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="text-xs text-muted-foreground mt-1">This task will only start after the selected task completes.</p>
    </div>
  );
}

interface TeamOption {
  id: string;
  name: string;
  isDefault: boolean;
  members: { id: string }[];
}

// "Use a team" toggle + team select, positioned alongside "Schedule for later" and
// "Recurring task" in the form. When enabled, the task is executed by the selected
// team's members in sequence instead of a single agent — see src/lib/teams.ts.
function TeamPicker({ teamId, onChange }: { teamId?: string | null; onChange: (id: string | null) => void }) {
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [loaded, setLoaded] = useState(false);
  const useTeam = !!teamId;

  useEffect(() => {
    fetch("/api/teams")
      .then((r) => r.json())
      .then((data: TeamOption[]) => setTeams(Array.isArray(data) ? data : []))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  function handleToggle(checked: boolean) {
    if (!checked) {
      onChange(null);
      return;
    }
    const defaultTeam = teams.find((t) => t.isDefault) ?? teams[0];
    onChange(defaultTeam?.id ?? "");
  }

  const noTeams = loaded && teams.length === 0;

  // A team id that no longer exists (a repo's default team or a restored draft
  // pointing at a since-deleted team) would show the first option while
  // submitting the dead id — drop it so the task runs as a single agent.
  useEffect(() => {
    if (loaded && teamId && !teams.some((t) => t.id === teamId)) onChange(null);
  }, [loaded, teamId, teams, onChange]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <input
          id="useTeam"
          type="checkbox"
          checked={useTeam}
          disabled={noTeams}
          onChange={(e) => handleToggle(e.target.checked)}
          className="size-4 rounded border-2 border-muted-foreground accent-primary disabled:opacity-40"
        />
        <Label htmlFor="useTeam" className={noTeams ? "text-muted-foreground" : "cursor-pointer"}>
          Use a team
        </Label>
      </div>
      {noTeams && (
        <p className="text-xs text-muted-foreground">
          No teams configured yet. Create one on the{" "}
          <a href="/teams" target="_blank" rel="noreferrer" className="text-blue-400 hover:text-blue-300 underline">
            Teams page
          </a>{" "}
          to run this task as a pipeline of agents.
        </p>
      )}
      {useTeam && !noTeams && (
        <div>
          <select
            value={teamId ?? ""}
            onChange={(e) => onChange(e.target.value || null)}
            className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}{t.isDefault ? " (default)" : ""} — {t.members.length} member{t.members.length === 1 ? "" : "s"}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground mt-1">
            The task runs through this team&apos;s members in order, each one picking up where the last left off, instead of a single agent handling the whole task.
          </p>
        </div>
      )}
    </div>
  );
}

export function TaskFormContent({
  title,
  description,
  context,
  labels = [],
  isRecurring,
  cronExpression,
  maxRuns = "",
  runCount = 0,
  scheduledFor,
  tokenBudget,
  costBudget,
  attachments = [],
  attachmentsFolder = "",
  contextFiles = [],
  gitMode,
  targetBranch,
  repos,
  repoTests,
  repoHistory,
  addToBacklog,
  outputType = "repository",
  onChange,
  onOutputTypeChange,
  onLabelsChange,
  onIsRecurringChange,
  onCronExpressionChange,
  onMaxRunsChange,
  onGitModeChange,
  onGitModeTouched,
  onTargetBranchChange,
  onAddToBacklogChange,
  onAddRepo,
  onRemoveRepo,
  onSetRepo,
  onSetRepoBranch,
  onTestRepo,
  onSelectRepoHistory,
  onApplyRepoHistory,
  onAttachmentsChange,
  onAttachmentsFolderChange,
  onContextFilesChange,
  aiProviderId,
  onAiProviderIdChange,
  useSmartProvider = false,
  onUseSmartProviderChange,
  taskModel,
  onTaskModelChange,
  dependsOnTaskId,
  onDependsOnTaskIdChange,
  excludeTaskId,
  teamId,
  onTeamIdChange,
  priority,
  onPriorityChange,
  effort,
  onEffortChange,
  createValidationTask = false,
  onCreateValidationTaskChange,
  allowSubtasks = false,
  onAllowSubtasksChange,
  toolAccess,
  onToolAccessChange,
  isRecurringTemplate = false,
  showRecurringToggle = false,
  showTokenBudget = false,
  showCostBudget = false,
  showScheduleAsToggle = false,
  onOpenPromptBuilder,
  providerConfigured,
  onSubtaskPreviewChange,
  systemPrompt,
  onRepoHistoryRefresh,
  onAdvancedFieldTouched,
  autoEnhanceDescription = false,
  isEnhancing = false,
}: TaskFormContentProps) {
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [suggestingContext, setSuggestingContext] = useState(false);
  const [enhancingDescription, setEnhancingDescription] = useState(false);
  // Snapshot of the description immediately before the last "Enhance" run, so
  // the user can revert if they don't like the AI's rewrite. Cleared once they
  // undo or manually edit the description again.
  const [preEnhanceDescription, setPreEnhanceDescription] = useState<string | null>(null);
  const [suggestingTitle, setSuggestingTitle] = useState(false);
  const [suggestingBudget, setSuggestingBudget] = useState(false);
  const [checkingDuplicates, setCheckingDuplicates] = useState(false);
  const [duplicateWarnings, setDuplicateWarnings] = useState<{ id: string; title: string; reason: string }[] | null>(null);
  const [estimatingWorkload, setEstimatingWorkload] = useState(false);
  const [workloadEstimate, setWorkloadEstimate] = useState<{ complexity: "quick" | "medium" | "complex"; minMinutes: number; maxMinutes: number; reasoning: string } | null>(null);
  const [decomposing, setDecomposing] = useState(false);
  const [subtaskPreview, setSubtaskPreview] = useState<Array<{ title: string; description: string; context: string; enabled: boolean }> | null>(null);
  const [splitIntoSubtasks, setSplitIntoSubtasks] = useState(false);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  // Latest attachments list, so back-to-back pastes that finish uploading
  // out of order don't drop each other's results via a stale closure.
  const attachmentsRef = useRef(attachments);
  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);
  const [descriptionDragOver, setDescriptionDragOver] = useState(false);

  // Uploads images to the attachments store and appends them to the task.
  // Shared by the "Attach Images" button and paste/drop on the description.
  async function uploadAttachmentFiles(files: File[]) {
    if (!onAttachmentsChange || files.length === 0) return;
    setUploadingAttachments(true);
    try {
      const formData = new FormData();
      files.forEach((f) => formData.append("file", f));
      const res = await fetch("/api/tasks/attachments", { method: "POST", body: formData });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error || "Upload failed");
      }
      const data = await res.json() as { attachments: TaskAttachment[] };
      const next = [...attachmentsRef.current, ...data.attachments];
      attachmentsRef.current = next;
      onAttachmentsChange(next);
      return data.attachments;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploadingAttachments(false);
    }
  }

  // Paste / drop of screenshots into the description: the image becomes a
  // task attachment (the same as "Attach Images"), text pastes are untouched.
  async function attachImagesFromTransfer(data: DataTransfer | null, opts: { ignoreWhenText?: boolean } = {}): Promise<boolean> {
    if (!onAttachmentsChange) return false;
    const images = extractImageFiles<File>(data, opts);
    if (images.length === 0) return false;
    const now = new Date();
    const named = images.map((f, i) => {
      const name = pastedImageName(f, now, i);
      return name === f.name ? f : new File([f], name, { type: f.type });
    });
    const uploaded = await uploadAttachmentFiles(named);
    if (uploaded && uploaded.length > 0) {
      toast.success(uploaded.length === 1 ? `Attached ${uploaded[0].name}` : `Attached ${uploaded.length} images`);
    }
    return true;
  }

  function removeAttachment(att: TaskAttachment) {
    if (!onAttachmentsChange) return;
    void fetch("/api/tasks/attachments", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: att.path }),
    }).catch(() => { /* ignore */ });
    const next = attachmentsRef.current.filter((a) => a.id !== att.id);
    attachmentsRef.current = next;
    onAttachmentsChange(next);
  }

  function renderAttachmentChips() {
    return (
      <div className="flex flex-wrap gap-2 mb-2">
        {attachments.map((att) => (
          <div key={att.id} className="flex items-center gap-1.5 bg-muted rounded-lg px-2 py-1.5 text-sm max-w-xs">
            {/* eslint-disable-next-line @next/next/no-img-element -- tiny thumbnail of an uploaded attachment served by our own API */}
            <img
              src={`/api/attachments/${att.id}.${att.name.split(".").pop()}`}
              alt={att.name}
              className="w-8 h-8 object-cover rounded"
            />
            <span className="truncate text-xs text-muted-foreground max-w-28">{att.name}</span>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground shrink-0"
              title="Remove attachment"
              onClick={() => removeAttachment(att)}
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
    );
  }
  const [showSchedule, setShowSchedule] = useState(!!scheduledFor);
  const [taskOptions, setTaskOptions] = useState<{ id: string; title: string; status: string }[]>([]);
  const prevRepoBranchesRef = useRef<string>("");
  const [defaultBaseBranch, setDefaultBaseBranch] = useState("main");

  // Only offer the advanced options this form actually wires up — the edit
  // form, recurring templates and the new-task form each pass a different
  // subset of handlers.
  const advancedFields = ADVANCED_OPTION_FIELDS.filter((field) => {
    switch (field) {
      case "priority": return Boolean(onPriorityChange);
      case "effort": return Boolean(onEffortChange);
      case "costBudget": return showCostBudget;
      // The two budgets are alternatives, cost wins when both are enabled.
      case "tokenBudget": return showTokenBudget && !showCostBudget;
      case "aiProviderId": return Boolean(onAiProviderIdChange);
      case "model": return Boolean(onTaskModelChange);
      case "labels": return Boolean(onLabelsChange);
      case "createValidationTask": return Boolean(onCreateValidationTaskChange);
      case "allowSubtasks": return Boolean(onAllowSubtasksChange);
      case "context": return true;
    }
  });

  // Fan a patch from the shared accordion back out to this form's individual
  // (historically separate) change handlers.
  function applyAdvancedChange(patch: Partial<AdvancedOptionsValues>) {
    if ("priority" in patch) onPriorityChange?.(patch.priority ?? DEFAULT_PRIORITY);
    if ("effort" in patch) onEffortChange?.(patch.effort ?? null);
    if ("costBudget" in patch) onChange("costBudget", patch.costBudget ?? "");
    if ("tokenBudget" in patch) onChange("tokenBudget", patch.tokenBudget ?? "");
    // Smart Provider is set before the provider id so the two never disagree
    // mid-render (picking one always clears the other).
    if ("useSmartProvider" in patch) onUseSmartProviderChange?.(Boolean(patch.useSmartProvider));
    if ("aiProviderId" in patch) onAiProviderIdChange?.(patch.aiProviderId ?? null);
    if ("model" in patch) onTaskModelChange?.(patch.model ?? null);
    if ("labels" in patch) onLabelsChange?.(patch.labels ?? []);
    if ("context" in patch) onChange("context", patch.context ?? "");
    if ("createValidationTask" in patch) onCreateValidationTaskChange?.(Boolean(patch.createValidationTask));
    if ("allowSubtasks" in patch) onAllowSubtasksChange?.(Boolean(patch.allowSubtasks));
  }

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data: Record<string, string>) => {
        if (data.git_default_base_branch) setDefaultBaseBranch(data.git_default_base_branch);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!onDependsOnTaskIdChange) return;
    fetch("/api/tasks")
      .then((r) => r.json())
      .then((data: { id: string; title: string; status: string }[]) => {
        setTaskOptions(data.filter((t) => t.id !== excludeTaskId));
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-populate "push to branch" from first repo's clone branch
  useEffect(() => {
    const currentBranches = repos.map((r) => r.branch ?? "").join(",");
    if (currentBranches === prevRepoBranchesRef.current) return;
    prevRepoBranchesRef.current = currentBranches;
    const firstRepoBranch = repos.find((r) => r.branch)?.branch;
    if (firstRepoBranch) {
      if (gitMode === "branch") onGitModeChange("target");
      onTargetBranchChange(firstRepoBranch);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repos]);

  async function suggestContext() {
    if (!description.trim()) {
      toast.error("Enter a description first so the AI has something to work with.");
      return;
    }
    setSuggestingContext(true);
    try {
      const res = await fetch("/api/tasks/suggest-context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title || description.slice(0, 80), description, providerId: aiProviderId || undefined }),
      });
      const data = await res.json() as { context?: string; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? "Suggestion failed");
      if (data.context) {
        onChange("context", data.context);
        getAnalytics()?.capture("ai_assist_used", { kind: "context" });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to suggest context");
    } finally {
      setSuggestingContext(false);
    }
  }

  async function enhanceDescription() {
    if (!description.trim()) {
      toast.error("Enter a description first so the AI has something to work with.");
      return;
    }
    const previousDescription = description;
    setEnhancingDescription(true);
    try {
      const res = await fetch("/api/tasks/enhance-description", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title || description.slice(0, 80), description, providerId: aiProviderId || undefined }),
      });
      const data = await res.json() as { description?: string; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? "Enhancement failed");
      if (data.description) {
        onChange("description", data.description);
        getAnalytics()?.capture("ai_assist_used", { kind: "description" });
        setPreEnhanceDescription(previousDescription);
        toast.success("Description enhanced", {
          action: {
            label: "Undo",
            onClick: () => undoEnhanceDescription(previousDescription),
          },
        });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to enhance description");
    } finally {
      setEnhancingDescription(false);
    }
  }

  // Reverts the description to what it was right before the last "Enhance"
  // run. Exposed both via the toast action shown right after enhancing and via
  // a persistent "Undo" button next to the Enhance control, so the option
  // doesn't disappear once the toast times out.
  function undoEnhanceDescription(value?: string) {
    const target = value ?? preEnhanceDescription;
    if (target === null || target === undefined) return;
    onChange("description", target);
    setPreEnhanceDescription(null);
  }

  async function suggestTitle() {
    if (!description.trim()) {
      toast.error("Enter a description first so the AI has something to work with.");
      return;
    }
    setSuggestingTitle(true);
    try {
      const res = await fetch("/api/tasks/suggest-title", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description, context: context || undefined, providerId: aiProviderId || undefined }),
      });
      const data = await res.json() as { title?: string; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? "Title suggestion failed");
      if (data.title) {
        onChange("title", data.title);
        getAnalytics()?.capture("ai_assist_used", { kind: "title" });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to suggest title");
    } finally {
      setSuggestingTitle(false);
    }
  }

  async function suggestBudget() {
    if (!description.trim()) {
      toast.error("Enter a description first so the AI has something to work with.");
      return;
    }
    setSuggestingBudget(true);
    try {
      const res = await fetch("/api/tasks/suggest-budget", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title || description.slice(0, 80), description, providerId: aiProviderId || undefined }),
      });
      const data = await res.json() as { costBudget?: number; reasoning?: string; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? "Budget suggestion failed");
      if (data.costBudget) {
        onChange("costBudget", data.costBudget.toFixed(2));
        getAnalytics()?.capture("ai_assist_used", { kind: "budget" });
        if (data.reasoning) toast.success(`Budget set to $${data.costBudget.toFixed(2)}: ${data.reasoning}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to suggest budget");
    } finally {
      setSuggestingBudget(false);
    }
  }

  async function checkDuplicates() {
    if (!description.trim()) {
      toast.error("Enter a description first so the AI has something to compare.");
      return;
    }
    setCheckingDuplicates(true);
    setDuplicateWarnings(null);
    try {
      const res = await fetch("/api/tasks/check-duplicate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title || description.slice(0, 80), description, providerId: aiProviderId || undefined }),
      });
      const data = await res.json() as { duplicates?: { id: string; title: string; reason: string }[]; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? "Duplicate check failed");
      setDuplicateWarnings(data.duplicates ?? []);
      if ((data.duplicates ?? []).length === 0) {
        toast.success("No similar tasks found.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Duplicate check failed");
    } finally {
      setCheckingDuplicates(false);
    }
  }

  async function estimateWorkload() {
    if (!description.trim()) {
      toast.error("Enter a description first so the AI has something to estimate.");
      return;
    }
    setEstimatingWorkload(true);
    setWorkloadEstimate(null);
    try {
      const res = await fetch("/api/tasks/estimate-workload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title || description.slice(0, 80), description, providerId: aiProviderId || undefined }),
      });
      const data = await res.json() as { complexity?: "quick" | "medium" | "complex"; minMinutes?: number; maxMinutes?: number; reasoning?: string; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? "Estimation failed");
      if (data.complexity && data.minMinutes !== undefined && data.maxMinutes !== undefined) {
        setWorkloadEstimate({ complexity: data.complexity, minMinutes: data.minMinutes, maxMinutes: data.maxMinutes, reasoning: data.reasoning ?? "" });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to estimate workload");
    } finally {
      setEstimatingWorkload(false);
    }
  }

  async function decomposeTask() {
    if (!description.trim()) {
      toast.error("Enter a description first so the AI has something to decompose.");
      return;
    }
    setDecomposing(true);
    setSubtaskPreview(null);
    try {
      const res = await fetch("/api/tasks/decompose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title || description.slice(0, 80), description, context: context || undefined, providerId: aiProviderId || undefined }),
      });
      const data = await res.json() as { subtasks?: Array<{ title: string; description: string; context: string }>; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? "Decomposition failed");
      if (!data.subtasks || data.subtasks.length < 2) throw new Error("AI determined this task doesn't need splitting");
      setSubtaskPreview(data.subtasks.map((s, i) => ({ ...s, title: `${i + 1}. ${s.title}`, enabled: !addToBacklog })));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to decompose task");
      setSplitIntoSubtasks(false);
    } finally {
      setDecomposing(false);
    }
  }

  // Keep the parent in sync with the current subtask preview so it can create the
  // subtasks itself when the main "Create Task" button is pressed, instead of this
  // form having its own separate submit action.
  useEffect(() => {
    onSubtaskPreviewChange?.(subtaskPreview);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subtaskPreview]);

  async function cronFromText(text: string): Promise<string | null> {
    try {
      const res = await fetch("/api/tasks/cron-from-text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, providerId: aiProviderId || undefined }),
      });
      const data = await res.json() as { cronExpression?: string; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? "Failed to generate cron");
      return data.cronExpression ?? null;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to generate cron expression");
      return null;
    }
  }

  return (
    <>
      <Card className="!overflow-visible">
        <CardHeader><CardTitle className="text-base">Task Details</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-4 !overflow-visible">
          <div>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-1">
              <Label htmlFor="description">Description</Label>
              <div className="flex items-center gap-3 flex-wrap">
                <button
                  type="button"
                  disabled={estimatingWorkload || !description.trim()}
                  onClick={() => void estimateWorkload()}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Use AI to estimate task complexity and duration before running"
                >
                  <Timer size={13} />
                  {estimatingWorkload ? "Estimating…" : "Estimate"}
                </button>
                <button
                  type="button"
                  disabled={enhancingDescription}
                  onClick={() => void enhanceDescription()}
                  className={`flex items-center gap-1.5 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                    autoEnhanceDescription
                      ? "text-green-600 hover:text-green-700 bg-green-500/10 border border-green-500/30 rounded-md px-2 py-0.5"
                      : "text-primary hover:text-primary/80"
                  }`}
                  title={autoEnhanceDescription ? "Auto-enhance is on: description will be enhanced automatically on submit" : "Use AI to rewrite your description as detailed, actionable agent instructions"}
                >
                  <Sparkles size={13} />
                  {enhancingDescription ? "Enhancing…" : autoEnhanceDescription ? "Auto enhance is on" : "Enhance"}
                </button>
                {preEnhanceDescription !== null && !enhancingDescription && (
                  <button
                    type="button"
                    onClick={() => undoEnhanceDescription()}
                    className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                    title="Revert the description to what it was before the last enhancement"
                  >
                    <History size={13} />
                    Undo enhance
                  </button>
                )}
                <PreviewPromptModal
                  title={title}
                  description={description}
                  context={context || undefined}
                  labels={labels && labels.length > 0 ? labels : undefined}
                  systemPrompt={systemPrompt}
                  outputType={outputType}
                  repos={repos.filter((r) => r.url).map((r) => ({ alias: r.url.split("/").pop()?.replace(/\.git$/, "") ?? "repo", url: r.url }))}
                  contextFiles={contextFiles.length > 0 ? contextFiles : undefined}
                />
                {onOpenPromptBuilder && (
                  <button
                    type="button"
                    onClick={() => {
                      if (providerConfigured && !providerConfigured.configured) {
                        toast.error(providerConfigured.reason || "Configure an AI provider in Settings → AI first");
                        return;
                      }
                      onOpenPromptBuilder();
                    }}
                    className="flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 transition-colors font-medium"
                  >
                    <Wand2 size={13} />
                    Prompt Builder
                  </button>
                )}
              </div>
            </div>
            <div className="relative mt-1">
              <Textarea
                id="description"
                value={description}
                onChange={(e) => { onChange("description", e.target.value); setWorkloadEstimate(null); setPreEnhanceDescription(null); }}
                required
                rows={4}
                disabled={enhancingDescription || isEnhancing}
                onPaste={onAttachmentsChange ? (e) => {
                  const data = e.clipboardData;
                  if (extractImageFiles(data).length === 0) return;
                  e.preventDefault();
                  void attachImagesFromTransfer(data);
                } : undefined}
                onDragOver={onAttachmentsChange ? (e) => {
                  if (!Array.from(e.dataTransfer.types).includes("Files")) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "copy";
                  if (!descriptionDragOver) setDescriptionDragOver(true);
                } : undefined}
                onDragLeave={onAttachmentsChange ? () => setDescriptionDragOver(false) : undefined}
                onDrop={onAttachmentsChange ? (e) => {
                  setDescriptionDragOver(false);
                  const data = e.dataTransfer;
                  if (extractImageFiles(data, { ignoreWhenText: false }).length === 0) return;
                  e.preventDefault();
                  void attachImagesFromTransfer(data, { ignoreWhenText: false });
                } : undefined}
                className={`${enhancingDescription || isEnhancing ? "opacity-60 cursor-not-allowed" : ""} ${descriptionDragOver ? "ring-2 ring-primary border-primary" : ""}`.trim()}
                placeholder={outputType === "design" ? "Describe the app or UI you want designed (e.g. \"design me a habit-tracking app\")…" : outputType === "file" ? "Describe the document(s) you want the agent to produce…" : outputType === "result" ? "Ask a question or describe what you want the agent to find out…" : "What should the agent do?"}
              />
              {(enhancingDescription || isEnhancing) && (
                <div className="absolute inset-0 flex items-center justify-center rounded-md pointer-events-none">
                  <div className="flex items-center gap-2 bg-background/90 rounded-md px-3 py-2 border border-border shadow-sm">
                    <Sparkles size={14} className="animate-pulse text-primary" />
                    <span className="text-xs text-muted-foreground">Enhancing description…</span>
                  </div>
                </div>
              )}
            </div>
            {onAttachmentsChange && (
              <div className="mt-1.5">
                {attachments.length > 0 && renderAttachmentChips()}
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Paperclip size={11} />
                  {uploadingAttachments ? "Uploading image…" : "Paste or drop a screenshot here to attach it."}
                </p>
              </div>
            )}
            {workloadEstimate && (
              <div className={`mt-2 rounded-md border px-3 py-2.5 flex items-start gap-2 ${
                workloadEstimate.complexity === "quick"
                  ? "border-green-500/40 bg-green-500/5"
                  : workloadEstimate.complexity === "medium"
                  ? "border-yellow-500/40 bg-yellow-500/5"
                  : "border-orange-500/40 bg-orange-500/5"
              }`}>
                <Timer size={13} className={`mt-0.5 shrink-0 ${
                  workloadEstimate.complexity === "quick" ? "text-green-400" :
                  workloadEstimate.complexity === "medium" ? "text-yellow-400" : "text-orange-400"
                }`} />
                <div className="flex flex-col gap-0.5 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-semibold capitalize ${
                      workloadEstimate.complexity === "quick" ? "text-green-400" :
                      workloadEstimate.complexity === "medium" ? "text-yellow-400" : "text-orange-400"
                    }`}>
                      {workloadEstimate.complexity}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      ~{workloadEstimate.minMinutes === workloadEstimate.maxMinutes
                        ? `${workloadEstimate.minMinutes}m`
                        : `${workloadEstimate.minMinutes}–${workloadEstimate.maxMinutes}m`}
                    </span>
                    <button
                      type="button"
                      className="ml-auto text-muted-foreground/60 hover:text-muted-foreground"
                      onClick={() => setWorkloadEstimate(null)}
                    >
                      <X size={11} />
                    </button>
                  </div>
                  {workloadEstimate.reasoning && (
                    <p className="text-xs text-muted-foreground">{workloadEstimate.reasoning}</p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Recurring template: show only cron expression */}
          {isRecurringTemplate && (
            <div>
              <Label htmlFor="cronExpression">Cron Expression</Label>
              <Input
                id="cronExpression"
                value={cronExpression}
                onChange={(e) => onCronExpressionChange(e.target.value)}
                placeholder="0 9 * * 1-5"
                className="mt-1 font-mono"
                required
              />
              <p className="text-xs text-muted-foreground mt-1">
                Standard 5-field cron (minute hour day month weekday).
              </p>
              <div className="mt-1.5">
                <CronNaturalLanguageHelper
                  onGenerate={async (text) => {
                    const expr = await cronFromText(text);
                    if (expr) onCronExpressionChange(expr);
                  }}
                />
              </div>
              {cronExpression && (() => {
                const dates = nextCronDates(cronExpression);
                if (!dates.length) return <p className="text-xs text-destructive mt-1">Invalid cron expression</p>;
                return (
                  <div className="mt-2 text-xs text-muted-foreground">
                    <span className="font-medium">Next runs: </span>
                    {dates.map((d, i) => <span key={i}>{i > 0 && " · "}{d.toLocaleString()}</span>)}
                  </div>
                );
              })()}
              {onMaxRunsChange && (
                <MaxRunsField
                  value={maxRuns}
                  onChange={onMaxRunsChange}
                  cronExpression={cronExpression}
                  runCount={runCount}
                />
              )}
            </div>
          )}

          {/* Non-template: show recurring toggle + schedule options */}
          {!isRecurringTemplate && (
            <>
              {showRecurringToggle && (
                <div className="flex items-center gap-3">
                  <input
                    id="isRecurring"
                    type="checkbox"
                    checked={isRecurring}
                    onChange={(e) => { onIsRecurringChange(e.target.checked); onCronExpressionChange(""); onMaxRunsChange?.(""); }}
                    className="size-4 rounded border-2 border-muted-foreground accent-primary"
                  />
                  <Label htmlFor="isRecurring" className="cursor-pointer">Recurring task (cron schedule)</Label>
                </div>
              )}

              {isRecurring ? (
                <div>
                  <Label htmlFor="cronExpression">Cron Expression</Label>
                  <Input
                    id="cronExpression"
                    value={cronExpression}
                    onChange={(e) => onCronExpressionChange(e.target.value)}
                    placeholder="0 9 * * 1-5"
                    className="mt-1 font-mono"
                    required
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Standard 5-field cron (minute hour day month weekday). Each firing creates an independent job.
                  </p>
                  <div className="mt-1.5">
                    <CronNaturalLanguageHelper
                      onGenerate={async (text) => {
                        const expr = await cronFromText(text);
                        if (expr) onCronExpressionChange(expr);
                      }}
                    />
                  </div>
                  {cronExpression && (() => {
                    const dates = nextCronDates(cronExpression);
                    if (!dates.length) return <p className="text-xs text-destructive mt-1">Invalid cron expression</p>;
                    return (
                      <div className="mt-2 text-xs text-muted-foreground">
                        <span className="font-medium">Next runs: </span>
                        {dates.map((d, i) => <span key={i}>{i > 0 && " · "}{d.toLocaleString()}</span>)}
                      </div>
                    );
                  })()}
                  {onMaxRunsChange && (
                    <MaxRunsField
                      value={maxRuns}
                      onChange={onMaxRunsChange}
                      cronExpression={cronExpression}
                      runCount={runCount}
                    />
                  )}
                </div>
              ) : showScheduleAsToggle ? (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-3">
                    <input
                      id="showSchedule"
                      type="checkbox"
                      checked={showSchedule}
                      onChange={(e) => {
                        setShowSchedule(e.target.checked);
                        if (!e.target.checked) onChange("scheduledFor", "");
                      }}
                      className="size-4 rounded border-2 border-muted-foreground accent-primary"
                    />
                    <Label htmlFor="showSchedule" className="cursor-pointer">Schedule for later</Label>
                  </div>
                  {showSchedule && (
                    <Input
                      id="scheduledFor"
                      type="datetime-local"
                      value={scheduledFor}
                      onChange={(e) => {
                        onChange("scheduledFor", e.target.value);
                        // A backlog task is disabled and never runs, so a schedule on one
                        // silently never fires. Picking a time means "run it then".
                        if (e.target.value) onAddToBacklogChange(false);
                      }}
                      className="mt-1"
                    />
                  )}
                </div>
              ) : (
                <div>
                  <Label htmlFor="scheduledFor">Scheduled For (optional)</Label>
                  <Input
                    id="scheduledFor"
                    type="datetime-local"
                    value={scheduledFor}
                    onChange={(e) => {
                        onChange("scheduledFor", e.target.value);
                        // A backlog task is disabled and never runs, so a schedule on one
                        // silently never fires. Picking a time means "run it then".
                        if (e.target.value) onAddToBacklogChange(false);
                      }}
                    className="mt-1"
                  />
                  <p className="text-xs text-muted-foreground mt-1">Leave blank to run immediately.</p>
                </div>
              )}
            </>
          )}

          {onTeamIdChange && (
            <TeamPicker teamId={teamId} onChange={onTeamIdChange} />
          )}

          {/* Advanced Options — the collapsible section shared with the
              Repositories page, where the same controls set per-repo defaults.
              See src/components/AdvancedOptions.tsx. Task-only controls
              (depends-on, title, attachments, context files, subtask
              splitting) are injected as slots so they stay in this section. */}
          <AdvancedOptions
            values={{
              priority,
              effort,
              costBudget,
              tokenBudget,
              aiProviderId,
              useSmartProvider,
              model: taskModel,
              labels,
              context,
              createValidationTask,
              allowSubtasks,
            }}
            onChange={applyAdvancedChange}
            onFieldTouched={onAdvancedFieldTouched}
            fields={advancedFields}
            extraSummary={[
              title.trim() && "title",
              attachments.length > 0 && "attachments",
              contextFiles.length > 0 && "context files",
              dependsOnTaskId && "depends on",
              toolAccess && Object.keys(toolAccess).length > 0 && "tool access",
            ].filter(Boolean) as string[]}
            onSuggestBudget={() => void suggestBudget()}
            suggestingBudget={suggestingBudget}
            onSuggestContext={() => void suggestContext()}
            suggestingContext={suggestingContext}
            autoSelectDefaultProvider
            eager
            slots={{
              afterModel: (
                <>
                  {/* Depends On */}
                  {onDependsOnTaskIdChange && taskOptions.length > 0 && (
                    <DependsOnInput
                      value={dependsOnTaskId ?? null}
                      onChange={onDependsOnTaskIdChange}
                      options={taskOptions}
                    />
                  )}

                  {/* Title */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <Label htmlFor="title">
                        Title{" "}
                        <span className="text-muted-foreground font-normal">(optional, auto-generated from description if left blank)</span>
                      </Label>
                      <button
                        type="button"
                        disabled={suggestingTitle || !description.trim()}
                        onClick={() => void suggestTitle()}
                        className="flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 transition-colors font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                        title="Use AI to generate a concise title from your description"
                      >
                        <Sparkles size={13} />
                        {suggestingTitle ? "Suggesting…" : "Suggest title"}
                      </button>
                    </div>
                    <Input
                      id="title"
                      value={title}
                      onChange={(e) => onChange("title", e.target.value)}
                      className="mt-1"
                      placeholder={suggestingTitle ? "Generating title…" : "Leave blank to auto-generate from description"}
                    />
                    <div className="flex items-center justify-between mt-1.5">
                      <button
                        type="button"
                        disabled={checkingDuplicates || !description.trim()}
                        onClick={() => void checkDuplicates()}
                        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        title="Use AI to check if a similar task already exists"
                      >
                        <AlertTriangle size={13} />
                        {checkingDuplicates ? "Checking…" : "Check for duplicates"}
                      </button>
                      {duplicateWarnings !== null && duplicateWarnings.length === 0 && (
                        <span className="text-xs text-green-500">No duplicates found ✓</span>
                      )}
                    </div>
                    {duplicateWarnings && duplicateWarnings.length > 0 && (
                      <div className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 flex flex-col gap-1.5">
                        <div className="flex items-center gap-1.5 text-xs font-medium text-amber-400">
                          <AlertTriangle size={13} />
                          {duplicateWarnings.length === 1 ? "Possible duplicate detected" : `${duplicateWarnings.length} possible duplicates detected`}
                          <button
                            type="button"
                            className="ml-auto text-amber-400/60 hover:text-amber-400"
                            onClick={() => setDuplicateWarnings(null)}
                          >
                            <X size={13} />
                          </button>
                        </div>
                        {duplicateWarnings.map((d) => (
                          <div key={d.id} className="text-xs text-amber-300/80">
                            <a href={`/tasks/${d.id}`} target="_blank" rel="noreferrer" className="font-medium underline decoration-dotted hover:text-amber-300">
                              {d.title}
                            </a>
                            {": "}{d.reason}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              ),
              afterContext: (
                <>
                  {/* Attachments */}
                  {onAttachmentsChange && (
                    <div>
                      <Label>Attachments <span className="text-muted-foreground font-normal">(optional)</span></Label>
                      <p className="text-xs text-muted-foreground mt-0.5 mb-2">Attach images for the agent to reference (e.g., screenshots, mockups, diagrams). You can also paste or drop images straight into the description.</p>
                      <input
                        ref={attachmentInputRef}
                        type="file"
                        accept="image/*"
                        multiple
                        className="hidden"
                        onChange={async (e) => {
                          const files = Array.from(e.target.files ?? []);
                          if (!files.length) return;
                          await uploadAttachmentFiles(files);
                          if (attachmentInputRef.current) attachmentInputRef.current.value = "";
                        }}
                      />
                      {attachments.length > 0 && renderAttachmentChips()}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={uploadingAttachments}
                        onClick={() => attachmentInputRef.current?.click()}
                        className="flex items-center gap-2"
                      >
                        <Paperclip size={14} />
                        {uploadingAttachments ? "Uploading…" : "Attach Images"}
                      </Button>

                      {/* Destination folder for attachments */}
                      {onAttachmentsFolderChange && (
                        <div className="mt-3">
                          <Label className="text-xs">Files location <span className="text-muted-foreground font-normal">(optional)</span></Label>
                          <p className="text-xs text-muted-foreground mt-0.5 mb-1.5">
                            Where in the workspace these files will be placed. Defaults to the repository root.
                          </p>
                          <FolderSelector
                            value={attachmentsFolder}
                            onChange={onAttachmentsFolderChange}
                            repos={repos.filter((r) => r.url).map((r) => ({ url: r.url, alias: deriveAlias(r.url), branch: r.branch }))}
                          />
                        </div>
                      )}
                    </div>
                  )}

                  {/* Context files — pick specific files from the repo to include as read-only context */}
                  {onContextFilesChange && (
                    <div>
                      <Label className="flex items-center gap-1.5">
                        <FileText size={13} />
                        Context files <span className="text-muted-foreground font-normal">(optional)</span>
                      </Label>
                      <p className="text-xs text-muted-foreground mt-0.5 mb-2">
                        Pick specific files from your repositories to inline into the agent&apos;s prompt as read-only reference material. Useful when the agent should focus on particular files rather than exploring the whole repo.
                      </p>
                      <ContextFileSelector
                        value={contextFiles}
                        onChange={onContextFilesChange}
                        repos={repos.filter((r) => r.url).map((r) => ({ url: r.url, alias: deriveAlias(r.url), branch: r.branch }))}
                      />
                    </div>
                  )}
                </>
              ),
              end: (
                <>
                  {/* Per-task tool access (GitHub CLI, …) */}
                  {onToolAccessChange && (
                    <ToolAccessPicker value={toolAccess ?? {}} onChange={onToolAccessChange} />
                  )}
                  {/* Split into subtasks */}
                  {onSubtaskPreviewChange && (
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center gap-3">
                        <input
                          id="splitIntoSubtasks"
                          type="checkbox"
                          checked={splitIntoSubtasks}
                          disabled={decomposing}
                          onChange={async (e) => {
                            const checked = e.target.checked;
                            if (!checked) {
                              setSplitIntoSubtasks(false);
                              setSubtaskPreview(null);
                              return;
                            }
                            if (!description.trim()) {
                              toast.error("Enter a description first so the AI has something to decompose.");
                              return;
                            }
                            setSplitIntoSubtasks(true);
                            await decomposeTask();
                          }}
                          className="size-4 rounded border-2 border-muted-foreground accent-primary"
                        />
                        <Label htmlFor="splitIntoSubtasks" className="cursor-pointer flex items-center gap-1.5">
                          <GitFork size={13} />
                          Split into subtasks
                          {decomposing && <span className="text-xs text-muted-foreground font-normal ml-1">Analysing…</span>}
                        </Label>
                      </div>
                      <p className="text-xs text-muted-foreground pl-7">
                        Use AI to break this into sequential subtasks. Each will run with the same provider, model, and repositories configured here. They&apos;re created together when you press Create Task below.
                      </p>

                      {subtaskPreview && (
                        <div className="mt-1 rounded-md border border-sky-500/40 bg-sky-500/5 p-3 flex flex-col gap-2">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-1.5 text-xs font-medium text-sky-400">
                              <GitFork size={13} />
                              {subtaskPreview.length} subtasks, will run in order, each depending on the previous
                            </div>
                            <button
                              type="button"
                              className="text-muted-foreground/60 hover:text-muted-foreground"
                              onClick={() => { setSubtaskPreview(null); setSplitIntoSubtasks(false); }}
                            >
                              <X size={13} />
                            </button>
                          </div>
                          <div className="flex items-center justify-end gap-2 text-[11px] text-muted-foreground">
                            <button
                              type="button"
                              className="hover:text-foreground underline underline-offset-2"
                              onClick={() => setSubtaskPreview((prev) => prev?.map((s) => ({ ...s, enabled: true })) ?? prev)}
                            >
                              Enable all
                            </button>
                            <span>·</span>
                            <button
                              type="button"
                              className="hover:text-foreground underline underline-offset-2"
                              onClick={() => setSubtaskPreview((prev) => prev?.map((s) => ({ ...s, enabled: false })) ?? prev)}
                            >
                              Disable all
                            </button>
                          </div>
                          <ol className="flex flex-col gap-1.5 max-h-96 overflow-y-auto pr-1">
                            {subtaskPreview.map((s, i) => (
                              <li key={i} className={`flex gap-2 text-xs ${s.enabled ? "" : "opacity-50"}`}>
                                <input
                                  type="checkbox"
                                  checked={s.enabled}
                                  onChange={(e) => {
                                    const checked = e.target.checked;
                                    // Each subtask depends on the previous one completing, so disabling
                                    // one strands everything after it (it'll never see its dependency
                                    // reach "completed") and enabling one requires everything before it.
                                    setSubtaskPreview((prev) => prev?.map((p, idx) => {
                                      if (checked && idx <= i) return { ...p, enabled: true };
                                      if (!checked && idx >= i) return { ...p, enabled: false };
                                      return p;
                                    }) ?? prev);
                                  }}
                                  title={s.enabled ? "Will run: disabling also disables every subtask after this one" : "Disabled: will be saved to backlog"}
                                  className="shrink-0 mt-0.5 size-3.5 rounded border-2 border-muted-foreground accent-primary"
                                />
                                <div className="flex flex-col gap-0.5 min-w-0">
                                  <span className="font-medium text-foreground/90 truncate">{s.title}</span>
                                  <span className="text-muted-foreground line-clamp-2">{s.description}</span>
                                </div>
                              </li>
                            ))}
                          </ol>
                          <p className="text-[11px] text-muted-foreground/80">
                            Each subtask depends on the one before it, so disabling one disables everything after it too.
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </>
              ),
            }}
          />
        </CardContent>
      </Card>

      {onOutputTypeChange && (
        <Card>
          <CardContent className="pt-5">
            <OutputTypeSelector value={outputType} onChange={onOutputTypeChange} />
          </CardContent>
        </Card>
      )}

      <Card className="!overflow-visible">
        <CardHeader>
          <CardTitle className="text-base">
            {isReadOnlyOutput(outputType)
              ? <>Git Repositories <span className="text-muted-foreground font-normal text-sm">(optional, for context only)</span></>
              : <>Git Repositories <span className="text-muted-foreground font-normal text-sm">(required)</span></>
            }
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {isReadOnlyOutput(outputType) ? (
            <p className="text-sm text-muted-foreground -mt-1">
              Optionally add repositories for the agent to read as context. The agent will <strong>not</strong> commit or push, {outputType === "result" ? "its answer is shown on the task details page" : `it writes ${outputType === "design" ? "design mockups" : "files"}`} instead.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground -mt-1">
              Add at least one repository for the agent to clone, work in, and commit/push changes to.
            </p>
          )}
          {repos.map((repo, i) => {
            const test = repoTests[i] ?? { status: "idle", output: "" };
            const historyEntry = repo.url
              ? repoHistory.find((h) => h.url === repo.url)
              : undefined;
            const previousSettingsHint = historyEntry
              ? [
                  historyEntry.lastBranch ? `${historyEntry.lastBranch} branch` : null,
                  historyEntry.lastGitMode ? REPO_GIT_MODE_HINTS[historyEntry.lastGitMode] : null,
                ].filter(Boolean).join(" · ")
              : "";
            return (
              <div key={i} className="flex flex-col gap-1">
                <div className="flex flex-wrap gap-2 items-end">
                  <div className="flex-1 min-w-0" style={{ minWidth: "200px" }}>
                    <Label>Git URL</Label>
                    <RepoUrlInput
                      value={repo.url}
                      onChange={(v) => onSetRepo(i, v)}
                      onSelect={(entry) => onSelectRepoHistory?.(i, entry)}
                      history={repoHistory}
                      placeholder="git@github.com:user/repo.git"
                      className="mt-1"
                      onHistoryRefresh={onRepoHistoryRefresh}
                    />
                  </div>
                  <div className="flex-shrink-0" style={{ minWidth: "130px" }}>
                    <Label>Branch (optional)</Label>
                    <RepoBranchInput
                      value={repo.branch ?? ""}
                      onChange={(v) => onSetRepoBranch(i, v)}
                      repoUrl={repo.url}
                      className="mt-1"
                      placeholder={defaultBaseBranch}
                    />
                  </div>
                  <div className="flex gap-2 items-center shrink-0">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!repo.url || test.status === "testing"}
                      onClick={() => onTestRepo(i, repo.url)}
                    >
                      {test.status === "testing" ? "Testing…" : "Test"}
                    </Button>
                    {test.status === "ok" && <span className="text-green-600 font-medium">&#10003;</span>}
                    {test.status === "error" && <span className="text-destructive font-medium">&#10005;</span>}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => onRemoveRepo(i)}
                      className="text-destructive hover:text-destructive/80"
                    >
                      ✕
                    </Button>
                  </div>
                </div>
                {previousSettingsHint && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 w-fit text-xs gap-1.5"
                      onClick={() => onApplyRepoHistory?.(i, historyEntry!)}
                      title={`Prepopulate branch and "after task completes" settings from the last run against this repo`}
                    >
                      <History className="size-3" /> Use previous run settings
                    </Button>
                    <span className="text-[11px] text-muted-foreground/80">Last used: {previousSettingsHint}</span>
                  </div>
                )}
                {test.status === "error" && test.output && (
                  <pre className="text-xs text-destructive bg-destructive/5 rounded px-2 py-1 overflow-x-auto whitespace-pre-wrap break-all">{test.output}</pre>
                )}
              </div>
            );
          })}
          <Button type="button" variant="outline" size="sm" onClick={onAddRepo} className="w-fit">
            + Add Repository
          </Button>
          {repos.some((r) => r.url) && !isReadOnlyOutput(outputType) && (
            <div className="flex flex-col gap-2 pt-1 border-t border-border">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">After task completes</p>
              {([
                { value: "branch", label: "Push to agent branch" },
                { value: "target", label: "Push to branch:" },
                { value: "main", label: <span key="main">Push directly to <code className="text-xs bg-muted px-1 py-0.5 rounded">{defaultBaseBranch}</code></span> },
                { value: "pr", label: "Push to agent branch and open a PR (default)" },
              ] as const).map(({ value, label }) => (
                <label
                  key={value}
                  className={`flex items-center gap-2.5 cursor-pointer rounded-md px-2.5 py-1.5 -mx-2.5 transition-colors ${gitMode === value ? "bg-primary/10 border border-primary/50 shadow-sm" : "border border-transparent hover:bg-muted/40"}`}
                >
                  <input
                    type="radio"
                    name="gitMode"
                    value={value}
                    checked={gitMode === value}
                    onChange={() => { onGitModeTouched?.(); onGitModeChange(value); if (value !== "target") onTargetBranchChange(""); }}
                    className="accent-primary w-4 h-4"
                  />
                  <span className={`text-sm ${gitMode === value ? "text-foreground font-medium" : "text-muted-foreground"}`}>{label}</span>
                  {value === "target" && (
                    <div className="ml-1" onClick={() => { onGitModeTouched?.(); onGitModeChange("target"); }}>
                      <RepoBranchInput
                        value={targetBranch}
                        onChange={onTargetBranchChange}
                        repoUrl={repos.find((r) => r.url)?.url ?? ""}
                        className="h-7 w-36 text-sm"
                        placeholder={defaultBaseBranch}
                      />
                    </div>
                  )}
                </label>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={addToBacklog}
            onChange={(e) => onAddToBacklogChange(e.target.checked)}
            className="size-4 rounded border-2 border-muted-foreground accent-primary"
          />
          <span className="text-sm text-muted-foreground">Save to backlog (disabled)</span>
        </label>
        {addToBacklog && scheduledFor && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Backlog tasks don&apos;t run, so this won&apos;t start at its scheduled time. Untick &quot;Save to backlog&quot; to let it run.
          </p>
        )}
      </div>
    </>
  );
}
