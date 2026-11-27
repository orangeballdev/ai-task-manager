"use client";
import { copyToClipboard } from "@/lib/clipboard";
import { useState, useEffect, useCallback, useId, useMemo } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { confirm } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import { PRIORITY_LABELS, DEFAULT_PRIORITY, normalizePriority, type TaskPriority } from "@/lib/priority";
import { type TaskEffort } from "@/lib/effort";
import { shortRepoUrl } from "@/lib/git-urls";
import {
  AdvancedOptions,
  type AdvancedOptionField,
  type AdvancedOptionsValues,
} from "@/components/AdvancedOptions";
import { RepoBranchInput } from "@/components/TaskFormContent";
import {
  Trash2,
  Plus,
  X,
  GitBranch,
  Save,
  FileText,
  ChevronDown,
  Check,
  Copy,
  Search,
  Undo2,
  ArrowUpDown,
  SlidersHorizontal,
  MessageSquare,
  Gauge,
  Users,
} from "lucide-react";

interface RepoItem {
  url: string;
  alias: string;
  saved: boolean;
  defaultContext?: string;
  defaultPriority?: TaskPriority;
  defaultEffort?: TaskEffort;
  defaultCostBudget?: number;
  defaultAiProviderId?: string;
  defaultUseSmartProvider?: boolean;
  defaultModel?: string;
  defaultLabels?: string[];
  defaultCreateValidationTask?: boolean;
  defaultBranch?: string;
  defaultGitMode?: GitMode;
  defaultTargetBranch?: string;
  defaultAllowSubtasks?: boolean;
  defaultTeamId?: string;
  maxConcurrentTasks?: number;
}

/** A team as returned by GET /api/teams (only the fields this page needs). */
interface TeamOption {
  id: string;
  name: string;
  isDefault: boolean;
  members: { id: string }[];
}

type GitMode = "branch" | "target" | "main" | "pr";

/** Editable state of a repo's git defaults ("" mode = no default). */
interface GitDefaultsValues {
  branch: string;
  gitMode: GitMode | "";
  targetBranch: string;
}

function toGitValues(repo: RepoItem): GitDefaultsValues {
  return {
    branch: repo.defaultBranch ?? "",
    gitMode: repo.defaultGitMode ?? "",
    targetBranch: repo.defaultTargetBranch ?? "",
  };
}

/**
 * Git defaults → PATCH /api/repos body. Like toDefaultsPayload, everything is
 * sent explicitly (null = clear) so clearing a default actually clears it.
 */
function toGitPayload(v: GitDefaultsValues) {
  return {
    defaultBranch: v.branch.trim() || null,
    defaultGitMode: v.gitMode || null,
    defaultTargetBranch: v.gitMode === "target" ? v.targetBranch.trim() || null : null,
  };
}

const EMPTY_GIT_VALUES: GitDefaultsValues = { branch: "", gitMode: "", targetBranch: "" };

const GIT_MODE_SHORT_LABELS: Record<GitMode, string> = {
  branch: "Agent branch",
  target: "Push to branch",
  main: "Push to base",
  pr: "Open PR",
};

/** Text input value -> the number (or null to clear) the API expects. */
function parseConcurrency(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i >= 1 ? i : null;
}

function concurrencyToInput(repo: RepoItem): string {
  return repo.maxConcurrentTasks != null ? String(repo.maxConcurrentTasks) : "";
}

/**
 * Advanced options that make sense as a per-repo default. The task-only ones
 * (title, depends-on, attachments, context files, subtask splitting) are
 * deliberately absent, and "Additional Instructions" is excluded because this
 * page already exposes it as the more prominent "Default context" field —
 * which, unlike the rest, is also injected into the agent's prompt at run time
 * (see getRepoDefaultContext in src/lib/repos.ts).
 */
const REPO_DEFAULT_FIELDS: AdvancedOptionField[] = [
  "priority",
  "effort",
  "costBudget",
  "aiProviderId",
  "model",
  "labels",
  "createValidationTask",
  "allowSubtasks",
];

/** Repo preset → the shape the shared Advanced Options accordion edits. */
function toAdvancedValues(repo: RepoItem): AdvancedOptionsValues {
  return {
    priority: normalizePriority(repo.defaultPriority),
    effort: repo.defaultEffort ?? null,
    costBudget: repo.defaultCostBudget != null ? String(repo.defaultCostBudget) : "",
    aiProviderId: repo.defaultAiProviderId ?? null,
    useSmartProvider: repo.defaultUseSmartProvider ?? false,
    model: repo.defaultModel ?? null,
    labels: repo.defaultLabels ?? [],
    createValidationTask: repo.defaultCreateValidationTask ?? false,
    allowSubtasks: repo.defaultAllowSubtasks ?? false,
  };
}

/**
 * Accordion values → PATCH /api/repos body. Every field is sent explicitly
 * (null when unset) so clearing a default actually clears it — the API treats
 * an omitted key as "leave this one alone".
 */
function toDefaultsPayload(v: AdvancedOptionsValues) {
  return {
    // "Normal" is the system default, i.e. the same as having no override.
    defaultPriority: normalizePriority(v.priority) === DEFAULT_PRIORITY ? null : v.priority,
    defaultEffort: v.effort ?? null,
    defaultCostBudget: v.costBudget?.trim() ? v.costBudget.trim() : null,
    defaultAiProviderId: v.useSmartProvider ? null : (v.aiProviderId ?? null),
    defaultUseSmartProvider: Boolean(v.useSmartProvider),
    defaultModel: v.model?.trim() || null,
    defaultLabels: v.labels ?? [],
    defaultCreateValidationTask: Boolean(v.createValidationTask),
    defaultAllowSubtasks: Boolean(v.allowSubtasks),
  };
}

/** How many advanced defaults this repo has set, for the collapsed-row badge. */
function countAdvancedDefaults(repo: RepoItem): number {
  return [
    repo.defaultEffort,
    repo.defaultCostBudget,
    repo.defaultAiProviderId,
    repo.defaultUseSmartProvider,
    repo.defaultModel,
    repo.defaultLabels?.length ? repo.defaultLabels : undefined,
    repo.defaultCreateValidationTask,
    repo.defaultAllowSubtasks,
  ].filter(Boolean).length;
}

function deriveAlias(url: string): string {
  return url.split("/").pop()?.replace(/\.git$/, "") || "repo";
}

function repoChatHref(url: string, alias: string): string {
  return `/repositories/chat?url=${encodeURIComponent(url)}&alias=${encodeURIComponent(alias)}`;
}

/**
 * Opens a read-only Q&A chat with this repo loaded as context. Rendered as a
 * link (not a button) so it survives middle-click / long-press "open in new
 * tab", and stopPropagation keeps it from toggling the collapsible row it sits
 * inside.
 */
function AskRepoButton({
  url,
  alias,
  className,
  compact = false,
}: {
  url: string;
  alias: string;
  className?: string;
  compact?: boolean;
}) {
  return (
    <Link
      href={repoChatHref(url, alias)}
      onClick={(e) => e.stopPropagation()}
      aria-label={`Ask questions about ${alias}`}
      title={`Ask questions about ${alias}`}
      className={cn(
        buttonVariants({ variant: "outline" }),
        "h-9 shrink-0 sm:h-8",
        compact && "px-2 sm:px-2.5",
        className
      )}
    >
      <MessageSquare className="size-3.5" />
      <span className={compact ? "hidden sm:inline" : undefined}>Ask</span>
    </Link>
  );
}

function CopyUrlButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  async function copy() {
    try {
      await copyToClipboard(url);
      setCopied(true);
    } catch {
      toast.error("Couldn't copy to clipboard");
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="shrink-0 text-muted-foreground hover:text-foreground"
      onClick={copy}
      aria-label={copied ? "Clone URL copied" : "Copy clone URL"}
      title="Copy clone URL"
    >
      {copied ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
    </Button>
  );
}

interface SavedRepoRowProps {
  repo: RepoItem;
  onSaved: () => void;
  /** Global base branch from Settings → Git, shown as the fallback. */
  defaultBaseBranch: string;
  /** All teams, for the default-team picker. */
  teams: TeamOption[];
  teamsLoaded: boolean;
}

/**
 * Default clone branch + "After task completes" choice for a saved repo —
 * the same options as the git section of the new-task form, prefilled there
 * when this repo is picked and applied to tasks created headlessly.
 */
function GitDefaultsEditor({
  id,
  repoUrl,
  values,
  onChange,
  defaultBaseBranch,
}: {
  id: string;
  repoUrl: string;
  values: GitDefaultsValues;
  onChange: (patch: Partial<GitDefaultsValues>) => void;
  defaultBaseBranch: string;
}) {
  const baseBranch = values.branch.trim() || defaultBaseBranch;
  const options: { value: GitMode | ""; label: React.ReactNode }[] = [
    { value: "", label: "No default (new tasks use the form's usual choice)" },
    { value: "branch", label: "Push to agent branch" },
    { value: "target", label: "Push to branch:" },
    {
      value: "main",
      label: (
        <>
          Push directly to <code className="rounded bg-muted px-1 py-0.5 text-xs">{defaultBaseBranch}</code>
        </>
      ),
    },
    { value: "pr", label: "Push to agent branch and open a PR" },
  ];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-branch`} className="text-xs">
          Default branch
        </Label>
        <div className="w-full sm:w-56">
          <RepoBranchInput
            value={values.branch}
            onChange={(branch) => onChange({ branch })}
            repoUrl={repoUrl}
            placeholder={defaultBaseBranch}
            className="h-9 sm:h-8"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Branch new tasks clone this repo at — agent branches and PRs are based on it. Leave blank
          to use the global default (<code>{defaultBaseBranch}</code>, from{" "}
          <Link href="/settings/git" className="underline underline-offset-2">
            Settings → Git
          </Link>
          ). A branch picked on the task itself still wins.
        </p>
      </div>

      <div className="flex flex-col gap-1.5" role="radiogroup" aria-labelledby={`${id}-gitmode`}>
        <p id={`${id}-gitmode`} className="text-xs font-medium">
          After task completes
        </p>
        <div className="flex flex-col gap-1">
          {options.map(({ value, label }) => {
            const checked = values.gitMode === value;
            return (
              <label
                key={value || "none"}
                className={cn(
                  "flex cursor-pointer flex-wrap items-center gap-2.5 rounded-md border px-2.5 py-1.5 transition-colors",
                  checked
                    ? "border-primary/50 bg-primary/10 shadow-sm"
                    : "border-transparent hover:bg-muted/40"
                )}
              >
                <input
                  type="radio"
                  name={`${id}-gitmode`}
                  value={value}
                  checked={checked}
                  onChange={() => onChange({ gitMode: value })}
                  className="size-4 accent-primary"
                />
                <span className={cn("text-sm", checked ? "font-medium text-foreground" : "text-muted-foreground")}>
                  {label}
                </span>
                {value === "target" && (
                  <div className="w-40" onClick={() => onChange({ gitMode: "target" })}>
                    <RepoBranchInput
                      value={values.targetBranch}
                      onChange={(targetBranch) => onChange({ targetBranch, gitMode: "target" })}
                      repoUrl={repoUrl}
                      placeholder={baseBranch}
                      className="h-7"
                    />
                  </div>
                )}
              </label>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          Prefilled into the new-task form when this repo is picked (unless you already chose an
          option there), and used for tasks created via the API, webhooks or inbound email that
          don&apos;t specify one.
        </p>
      </div>
    </div>
  );
}

/**
 * "Run tasks with a team" default for a saved repo. `value` is the team id, or
 * "" for no default (tasks run as a single agent). Prefilled into the new-task
 * form's "Use a team" toggle when this repo is picked, and applied by
 * POST /api/tasks (and the API/webhook/email paths) when the caller didn't
 * choose a team.
 */
function TeamDefaultEditor({
  id,
  value,
  onChange,
  teams,
  teamsLoaded,
}: {
  id: string;
  value: string;
  onChange: (teamId: string) => void;
  teams: TeamOption[];
  teamsLoaded: boolean;
}) {
  const enabled = Boolean(value);
  // The saved team may have been deleted since — keep it selectable so the
  // user can see why it no longer applies, rather than silently showing another.
  const missing = enabled && teamsLoaded && !teams.some((t) => t.id === value);
  const noTeams = teamsLoaded && teams.length === 0;

  function toggle(checked: boolean) {
    if (!checked) {
      onChange("");
      return;
    }
    const preferred = teams.find((t) => t.isDefault) ?? teams[0];
    if (preferred) onChange(preferred.id);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2.5">
        <input
          id={`${id}-team-toggle`}
          type="checkbox"
          checked={enabled}
          disabled={noTeams && !enabled}
          onChange={(e) => toggle(e.target.checked)}
          className="size-4 rounded border-2 border-muted-foreground accent-primary disabled:opacity-40"
        />
        <Label
          htmlFor={`${id}-team-toggle`}
          className={cn("text-xs", noTeams && !enabled ? "text-muted-foreground" : "cursor-pointer")}
        >
          Run tasks with a team by default
        </Label>
      </div>
      {enabled && (
        <select
          id={`${id}-team`}
          aria-label="Default team"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm sm:h-8 sm:w-72"
        >
          {missing && <option value={value}>Deleted team (no longer applies)</option>}
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.isDefault ? " (default)" : ""} — {t.members.length} member{t.members.length === 1 ? "" : "s"}
            </option>
          ))}
        </select>
      )}
      {noTeams && !enabled ? (
        <p className="text-xs text-muted-foreground">
          No teams yet. Create one on the{" "}
          <Link href="/teams" className="underline underline-offset-2">
            Teams page
          </Link>{" "}
          to run this repo&apos;s tasks as a pipeline of agents.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Tasks for this repo run through the team&apos;s members in order instead of a single
          agent. Prefilled into the new-task form&apos;s &ldquo;Use a team&rdquo; option when this
          repo is picked, and used for tasks created via the API, MCP, webhooks or inbound email
          that don&apos;t choose a team. Switching &ldquo;Use a team&rdquo; off on a task still runs
          it as a single agent.
          {missing && " The selected team has been deleted, so tasks currently run as a single agent."}
        </p>
      )}
    </div>
  );
}

/**
 * One saved repository, rendered as a collapsible row. Collapsed it is a
 * single compact line (name + url + whether a default context is set); the
 * editor only unfolds on demand, which keeps a list of repos scannable
 * instead of a stack of tall always-open forms.
 */
function SavedRepoRow({ repo, onSaved, defaultBaseBranch, teams, teamsLoaded }: SavedRepoRowProps) {
  const [open, setOpen] = useState(false);
  const [alias, setAlias] = useState(repo.alias);
  const [url, setUrl] = useState(repo.url);
  const [context, setContext] = useState(repo.defaultContext ?? "");
  const [concurrency, setConcurrency] = useState(() => concurrencyToInput(repo));
  const [advanced, setAdvanced] = useState<AdvancedOptionsValues>(() => toAdvancedValues(repo));
  const [git, setGit] = useState<GitDefaultsValues>(() => toGitValues(repo));
  const [teamId, setTeamId] = useState(repo.defaultTeamId ?? "");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const panelId = useId();

  const savedAdvanced = toAdvancedValues(repo);
  const dirty =
    alias !== repo.alias ||
    url.trim() !== repo.url ||
    context !== (repo.defaultContext ?? "") ||
    parseConcurrency(concurrency) !== (repo.maxConcurrentTasks ?? null) ||
    teamId !== (repo.defaultTeamId ?? "") ||
    JSON.stringify(toDefaultsPayload(advanced)) !== JSON.stringify(toDefaultsPayload(savedAdvanced)) ||
    JSON.stringify(toGitPayload(git)) !== JSON.stringify(toGitPayload(toGitValues(repo)));
  const gitSummary = [
    repo.defaultBranch ?? null,
    repo.defaultGitMode
      ? repo.defaultGitMode === "target" && repo.defaultTargetBranch
        ? `→ ${repo.defaultTargetBranch}`
        : GIT_MODE_SHORT_LABELS[repo.defaultGitMode]
      : null,
  ].filter(Boolean).join(" · ");
  const hasContext = (repo.defaultContext ?? "").trim().length > 0;
  const hasPriority = Boolean(repo.defaultPriority) && repo.defaultPriority !== DEFAULT_PRIORITY;
  const concurrencyLabel =
    repo.maxConcurrentTasks != null
      ? repo.maxConcurrentTasks === 1
        ? "One at a time"
        : `Max ${repo.maxConcurrentTasks}`
      : null;
  const advancedCount = countAdvancedDefaults(repo);
  const defaultTeam = repo.defaultTeamId ? teams.find((t) => t.id === repo.defaultTeamId) : undefined;
  // Only badge a team that still exists; a deleted one no longer applies.
  const teamLabel = repo.defaultTeamId && (defaultTeam || !teamsLoaded) ? (defaultTeam?.name ?? "Team") : null;

  // Re-sync the editable fields when the saved repo changes (adjusting state
  // during render rather than in an effect avoids a second, stale render).
  const [syncedRepo, setSyncedRepo] = useState(repo);
  if (syncedRepo !== repo) {
    setSyncedRepo(repo);
    setAlias(repo.alias);
    setUrl(repo.url);
    setContext(repo.defaultContext ?? "");
    setConcurrency(concurrencyToInput(repo));
    setAdvanced(toAdvancedValues(repo));
    setGit(toGitValues(repo));
    setTeamId(repo.defaultTeamId ?? "");
  }

  async function save() {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      toast.error("Clone URL can't be empty");
      return;
    }
    if (git.gitMode === "target" && !git.targetBranch.trim()) {
      toast.error("Enter the branch to push to, or pick a different \"After task completes\" option");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/repos", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: repo.url,
          // Only sent when actually changed, so the API can tell "amend the
          // clone URL" apart from "leave it as-is".
          newUrl: trimmedUrl !== repo.url ? trimmedUrl : undefined,
          alias: alias.trim() || deriveAlias(trimmedUrl),
          defaultContext: context,
          // null clears the cap (back to "only the global limit applies").
          maxConcurrentTasks: parseConcurrency(concurrency),
          ...toDefaultsPayload(advanced),
          ...toGitPayload(git),
          // null clears it (tasks run as a single agent).
          defaultTeamId: teamId || null,
        }),
      });
      if (!res.ok) {
        if (res.status === 409) {
          const body = await res.json().catch(() => null) as { error?: string } | null;
          toast.error(body?.error || "Another saved repository already uses that clone URL");
        } else {
          toast.error("Failed to save");
        }
        return;
      }
      toast.success("Saved");
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    setAlias(repo.alias);
    setUrl(repo.url);
    setContext(repo.defaultContext ?? "");
    setConcurrency(concurrencyToInput(repo));
    setAdvanced(toAdvancedValues(repo));
    setGit(toGitValues(repo));
    setTeamId(repo.defaultTeamId ?? "");
  }

  async function remove() {
    const ok = await confirm({
      title: "Remove repository",
      description: `Remove ${repo.alias} from saved repositories? Its default context and advanced option defaults will be deleted. This does not affect any existing tasks.`,
      confirmLabel: "Remove",
      variant: "destructive",
    });
    if (!ok) return;
    setRemoving(true);
    try {
      const res = await fetch("/api/repos", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: repo.url }),
      });
      if (!res.ok) {
        toast.error("Failed to remove");
        return;
      }
      toast.success("Repository removed");
      onSaved();
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div>
      {/* The "Ask" link sits beside the disclosure button rather than inside it:
          a link nested in a button is invalid HTML and swallows its own clicks. */}
      <div className={cn("flex items-center gap-1 pr-3 sm:pr-4", open && "bg-muted/30")}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={panelId}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left transition-colors sm:px-4",
            "min-h-14 hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none",
            "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset",
            open && "bg-muted/30"
          )}
        >
          <span
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
          >
            <GitBranch className="size-4" />
          </span>

          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium">{repo.alias}</span>
              {dirty && (
                <span
                  className="size-1.5 shrink-0 rounded-full bg-primary"
                  title="Unsaved changes"
                  aria-label="Unsaved changes"
                />
              )}
            </span>
            <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
              {shortRepoUrl(repo.url)}
            </span>
          </span>

          {hasPriority && (
            <Badge variant="secondary" className="hidden shrink-0 sm:inline-flex">
              <ArrowUpDown />
              {PRIORITY_LABELS[normalizePriority(repo.defaultPriority)]}
            </Badge>
          )}
          {hasPriority && (
            <ArrowUpDown
              className="size-3.5 shrink-0 text-muted-foreground sm:hidden"
              aria-label={`Default priority: ${PRIORITY_LABELS[normalizePriority(repo.defaultPriority)]}`}
            />
          )}

          {concurrencyLabel && (
            <Badge
              variant="secondary"
              className="hidden shrink-0 sm:inline-flex"
              title={`At most ${repo.maxConcurrentTasks} task(s) run against this repo at a time`}
            >
              <Gauge />
              {concurrencyLabel}
            </Badge>
          )}
          {concurrencyLabel && (
            <Gauge
              className="size-3.5 shrink-0 text-muted-foreground sm:hidden"
              aria-label={`Max ${repo.maxConcurrentTasks} concurrent tasks`}
            />
          )}

          {gitSummary && (
            <Badge
              variant="secondary"
              className="hidden max-w-48 shrink-0 sm:inline-flex"
              title={`Git defaults: ${gitSummary}`}
            >
              <GitBranch />
              <span className="truncate">{gitSummary}</span>
            </Badge>
          )}

          {teamLabel && (
            <Badge
              variant="secondary"
              className="hidden max-w-40 shrink-0 sm:inline-flex"
              title={`Tasks run with the ${teamLabel} team by default`}
            >
              <Users />
              <span className="truncate">{teamLabel}</span>
            </Badge>
          )}
          {teamLabel && (
            <Users
              className="size-3.5 shrink-0 text-muted-foreground sm:hidden"
              aria-label={`Default team: ${teamLabel}`}
            />
          )}

          {hasContext && (
            <Badge variant="secondary" className="hidden shrink-0 sm:inline-flex">
              <FileText />
              Context
            </Badge>
          )}
          {hasContext && (
            <FileText
              className="size-3.5 shrink-0 text-muted-foreground sm:hidden"
              aria-label="Has default context"
            />
          )}

          {advancedCount > 0 && (
            <Badge
              variant="secondary"
              className="hidden shrink-0 sm:inline-flex"
              title={`${advancedCount} advanced option default${advancedCount === 1 ? "" : "s"} set`}
            >
              <SlidersHorizontal />
              {advancedCount}
            </Badge>
          )}
          {advancedCount > 0 && (
            <SlidersHorizontal
              className="size-3.5 shrink-0 text-muted-foreground sm:hidden"
              aria-label={`${advancedCount} advanced option defaults set`}
            />
          )}

          <ChevronDown
            aria-hidden
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
              open && "rotate-180"
            )}
          />
        </button>

        <AskRepoButton url={repo.url} alias={repo.alias} compact />
      </div>

      {open && (
        <div
          id={panelId}
          className="flex flex-col gap-4 border-t border-border/60 bg-muted/20 px-3 pb-4 pt-4 sm:px-4"
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${panelId}-alias`} className="text-xs">
              Name
            </Label>
            <Input
              id={`${panelId}-alias`}
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder={deriveAlias(repo.url)}
              className="h-9 sm:h-8"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              Folder name this repo is cloned into inside the task workspace.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${panelId}-url`} className="text-xs">
              Clone URL
            </Label>
            <div className="flex items-center gap-1.5">
              <Input
                id={`${panelId}-url`}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="h-9 min-w-0 flex-1 font-mono text-xs sm:h-8"
                autoComplete="off"
                spellCheck={false}
              />
              <CopyUrlButton url={url.trim() || repo.url} />
            </div>
            <p className="text-xs text-muted-foreground">
              Where this repo is cloned from. Update this if the remote moved or the URL was
              entered wrong — existing tasks keep using the URL they were created with.
            </p>
          </div>

          <GitDefaultsEditor
            id={panelId}
            repoUrl={url.trim() || repo.url}
            values={git}
            onChange={(patch) => setGit((v) => ({ ...v, ...patch }))}
            defaultBaseBranch={defaultBaseBranch}
          />

          <TeamDefaultEditor
            id={panelId}
            value={teamId}
            onChange={setTeamId}
            teams={teams}
            teamsLoaded={teamsLoaded}
          />

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${panelId}-concurrency`} className="text-xs">
              Max concurrent tasks
            </Label>
            <Input
              id={`${panelId}-concurrency`}
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              value={concurrency}
              onChange={(e) => setConcurrency(e.target.value)}
              placeholder="Unlimited"
              className="h-9 w-32 sm:h-8"
            />
            <p className="text-xs text-muted-foreground">
              How many tasks may run against this repo at the same time. Set it to{" "}
              <strong>1</strong> to run this repo&apos;s tasks strictly one after another — useful
              when parallel agents would clash over shared state or conflicting branches. Extra
              tasks stay in Pending until a slot frees up; tasks for other repos keep running.
              Leave blank for no per-repo limit (only the global{" "}
              <Link href="/settings/general#concurrent-tasks" className="underline underline-offset-2">
                concurrent tasks
              </Link>{" "}
              setting applies).
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${panelId}-context`} className="text-xs">
              Default context
            </Label>
            <p className="text-xs text-muted-foreground">
              Added to every task that uses this repo, and prefilled into the new-task form. Good for
              standing instructions, conventions or gotchas.
            </p>
            <Textarea
              id={`${panelId}-context`}
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder="e.g. Always run `npm run lint` before finishing. Use the existing design tokens in src/theme. The default base branch is develop."
              className="min-h-24"
            />
          </div>

          {/* The same accordion the new-task form uses, wired to this repo's
              defaults instead of a single task's settings. */}
          <AdvancedOptions
            values={advanced}
            onChange={(patch) => setAdvanced((v) => ({ ...v, ...patch }))}
            fields={REPO_DEFAULT_FIELDS}
            heading="Default advanced options"
            intro={
              <p className="text-xs text-muted-foreground">
                Applied to every new task created against this repo. Anything you set by hand
                in a task&apos;s own Advanced Options wins — these only fill in what you left alone.
              </p>
            }
            hints={{
              priority: "Queue position for this repo's tasks: higher-priority tasks are picked up first when the worker has more eligible tasks than open slots.",
              effort: <>How much the model thinks before and while acting. Passed as <code>--effort</code> on the Claude CLI or <code>output_config.effort</code> on the Anthropic API; ignored by providers that don&apos;t support it.</>,
              costBudget: "Max spend in USD per task for this repo. When reached, the agent commits its work and stops gracefully. Leave blank for no limit.",
              aiProviderId: <>Which AI provider runs this repo&apos;s tasks. <strong>Smart Provider</strong> picks the best available one when each task starts running.</>,
              model: "Pin a model for this repo's tasks instead of using the provider's default.",
              labels: "Automatically tag every task created against this repo.",
              createValidationTask: "Automatically spawn a follow-up task to verify the work whenever a task for this repo completes.",
              allowSubtasks: "Let this repo's agents split their work into separate subtasks (queued when the task finishes) by default.",
            }}
          />

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
            <Button
              variant="destructive"
              className="h-9 w-full sm:h-8 sm:w-auto"
              onClick={remove}
              disabled={removing}
            >
              <Trash2 className="size-3.5" />
              {removing ? "Removing..." : "Remove"}
            </Button>

            <div className="flex items-center gap-2 sm:justify-end">
              {dirty && (
                <Button
                  variant="ghost"
                  className="h-9 flex-1 sm:h-8 sm:flex-none"
                  onClick={reset}
                  disabled={saving}
                >
                  <Undo2 className="size-3.5" />
                  Discard
                </Button>
              )}
              <Button
                className="h-9 flex-1 sm:h-8 sm:flex-none"
                onClick={save}
                disabled={saving || !dirty}
              >
                <Save className="size-3.5" />
                {saving ? "Saving..." : "Save changes"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 px-3 py-3 sm:px-4">
      <div className="size-8 shrink-0 animate-pulse rounded-lg bg-muted" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="h-3 w-28 animate-pulse rounded bg-muted" />
        <div className="h-2.5 w-48 max-w-full animate-pulse rounded bg-muted/60" />
      </div>
    </div>
  );
}

async function fetchRepos(): Promise<RepoItem[]> {
  const res = await fetch("/api/repos");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as RepoItem[];
}

export default function RepositoriesClient() {
  const [repos, setRepos] = useState<RepoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newUrl, setNewUrl] = useState("");
  const [newAlias, setNewAlias] = useState("");
  const [adding, setAdding] = useState(false);
  // Optional git defaults set while adding, so a new repo doesn't need a
  // second "expand and edit" round-trip just to pick its branch / git mode.
  const [newGit, setNewGit] = useState<GitDefaultsValues>(EMPTY_GIT_VALUES);
  const [showNewGit, setShowNewGit] = useState(false);
  const [savingUrl, setSavingUrl] = useState<string | null>(null);
  const [removingUrl, setRemovingUrl] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Global base branch (Settings → Git), the fallback for repos with no default branch.
  const [defaultBaseBranch, setDefaultBaseBranch] = useState("main");
  // Teams for the per-repo "default team" picker — fetched once for all rows.
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [teamsLoaded, setTeamsLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/teams")
      .then((r) => (r.ok ? r.json() : []))
      .then((data: TeamOption[]) => setTeams(Array.isArray(data) ? data : []))
      .catch(() => {})
      .finally(() => setTeamsLoaded(true));
  }, []);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Record<string, string> | null) => {
        if (data?.git_default_base_branch) setDefaultBaseBranch(data.git_default_base_branch);
      })
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    try {
      setRepos(await fetchRepos());
    } catch {
      toast.error("Failed to load repositories");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchRepos()
      .then((data) => {
        if (!cancelled) setRepos(data);
      })
      .catch(() => {
        if (!cancelled) toast.error("Failed to load repositories");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const allSaved = useMemo(() => repos.filter((r) => r.saved), [repos]);
  const allRecent = useMemo(() => repos.filter((r) => !r.saved), [repos]);

  // Only worth showing a filter once the list is long enough to scroll past.
  const showFilter = !loading && repos.length > 5;
  const q = showFilter ? query.trim().toLowerCase() : "";
  const matches = useCallback(
    (r: RepoItem) => !q || r.alias.toLowerCase().includes(q) || r.url.toLowerCase().includes(q),
    [q]
  );

  const saved = allSaved.filter(matches);
  const recent = allRecent.filter(matches);
  const noMatches = q.length > 0 && saved.length === 0 && recent.length === 0;

  async function addRepo() {
    const url = newUrl.trim();
    if (!url) {
      toast.error("Repository URL is required");
      return;
    }
    if (newGit.gitMode === "target" && !newGit.targetBranch.trim()) {
      toast.error("Enter the branch to push to, or pick a different \"After task completes\" option");
      return;
    }
    setAdding(true);
    try {
      const res = await fetch("/api/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          alias: newAlias.trim() || deriveAlias(url),
          ...toGitPayload(newGit),
        }),
      });
      if (!res.ok) {
        toast.error("Failed to add repository");
        return;
      }
      toast.success("Repository added");
      closeAdd();
      await load();
    } finally {
      setAdding(false);
    }
  }

  function closeAdd() {
    setShowAdd(false);
    setNewUrl("");
    setNewAlias("");
    setNewGit(EMPTY_GIT_VALUES);
    setShowNewGit(false);
  }

  async function saveRecent(url: string, alias: string) {
    setSavingUrl(url);
    try {
      const res = await fetch("/api/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, alias }),
      });
      if (!res.ok) {
        toast.error("Failed to add repository");
        return;
      }
      toast.success("Repository added");
      await load();
    } finally {
      setSavingUrl(null);
    }
  }

  async function removeRecent(url: string, alias: string) {
    const ok = await confirm({
      title: "Remove repository",
      description: `Remove ${alias} from your recently used list? This only tidies up this list — it does not affect any existing tasks, and it will reappear if you run a new task against it again.`,
      confirmLabel: "Remove",
      variant: "destructive",
    });
    if (!ok) return;
    setRemovingUrl(url);
    try {
      const res = await fetch("/api/repos", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, scope: "recent" }),
      });
      if (!res.ok) {
        toast.error("Failed to remove");
        return;
      }
      toast.success("Repository removed");
      await load();
    } finally {
      setRemovingUrl(null);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 sm:gap-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-bold sm:text-2xl">
            <GitBranch className="size-5 shrink-0 sm:size-6" />
            Repositories
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Save the Git repos you work with and give each a default branch, an &ldquo;After task
            completes&rdquo; choice (agent branch, push to a branch, push to base, or open a PR), a
            default context plus its own advanced options — priority, effort, budget, provider,
            model, labels — automatically applied to every task for that repo. Open a saved repo
            to edit them. Hit <strong className="font-medium text-foreground">Ask</strong> on
            any repo to chat with it and get questions about the codebase answered.
          </p>
        </div>
        {!showAdd && (
          <Button
            className="h-10 w-full shrink-0 sm:h-8 sm:w-auto"
            onClick={() => setShowAdd(true)}
          >
            <Plus className="size-4" />
            Add repository
          </Button>
        )}
      </header>

      {showAdd && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle>Add repository</CardTitle>
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              onClick={closeAdd}
              aria-label="Close"
            >
              <X className="size-4" />
            </Button>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-repo-url" className="text-xs">
                Repository URL
              </Label>
              <Input
                id="new-repo-url"
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !adding) addRepo();
                }}
                placeholder="https://github.com/acme/widgets.git"
                className="h-9 font-mono sm:h-8"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-repo-alias" className="text-xs">
                Name <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="new-repo-alias"
                value={newAlias}
                onChange={(e) => setNewAlias(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !adding) addRepo();
                }}
                placeholder={newUrl ? deriveAlias(newUrl) : "widgets"}
                className="h-9 sm:h-8"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="flex flex-col gap-3">
              <button
                type="button"
                onClick={() => setShowNewGit((v) => !v)}
                aria-expanded={showNewGit}
                className="flex w-fit items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                <ChevronDown
                  aria-hidden
                  className={cn("size-3.5 transition-transform duration-200", showNewGit && "rotate-180")}
                />
                Default branch &amp; &ldquo;After task completes&rdquo;{" "}
                <span className="font-normal">(optional)</span>
              </button>
              {showNewGit && (
                <div className="rounded-md border border-border/60 bg-muted/20 p-3">
                  <GitDefaultsEditor
                    // Remount when the URL changes so the branch picker
                    // doesn't keep suggestions fetched for a different repo.
                    key={newUrl.trim()}
                    id="new-repo"
                    repoUrl={newUrl.trim()}
                    values={newGit}
                    onChange={(patch) => setNewGit((v) => ({ ...v, ...patch }))}
                    defaultBaseBranch={defaultBaseBranch}
                  />
                </div>
              )}
            </div>
            <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
              <Button
                variant="ghost"
                className="h-9 sm:h-8"
                onClick={closeAdd}
                disabled={adding}
              >
                Cancel
              </Button>
              <Button className="h-9 sm:h-8" onClick={addRepo} disabled={adding}>
                <Plus className="size-4" />
                {adding ? "Adding..." : "Add repository"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {showFilter && (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter repositories..."
            aria-label="Filter repositories"
            className="h-9 pl-8"
          />
        </div>
      )}

      {loading ? (
        <Card className="gap-0 divide-y divide-border/60 py-0">
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </Card>
      ) : allSaved.length === 0 && !q ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 px-6 py-10 text-center">
            <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <GitBranch className="size-5" />
            </span>
            <p className="text-sm font-medium">No saved repositories yet</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              Save a repo to give it a default branch, an &ldquo;After task completes&rdquo; choice, a default context and advanced options that are applied to every task using it.
            </p>
            {!showAdd && (
              <Button
                variant="outline"
                className="mt-2 h-9 sm:h-8"
                onClick={() => setShowAdd(true)}
              >
                <Plus className="size-4" />
                Add repository
              </Button>
            )}
          </CardContent>
        </Card>
      ) : saved.length > 0 ? (
        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-2 px-1">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Saved
            </h2>
            <Badge variant="outline">{saved.length}</Badge>
          </div>
          <Card className="gap-0 divide-y divide-border/60 py-0">
            {saved.map((repo) => (
              <SavedRepoRow
                key={repo.url}
                repo={repo}
                onSaved={load}
                defaultBaseBranch={defaultBaseBranch}
                teams={teams}
                teamsLoaded={teamsLoaded}
              />
            ))}
          </Card>
        </section>
      ) : null}

      {recent.length > 0 && (
        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-2 px-1">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Recently used
            </h2>
            <Badge variant="outline">{recent.length}</Badge>
          </div>
          <p className="px-1 text-xs text-muted-foreground">
            Repositories from your recent tasks. Save one to give it a default branch, &ldquo;After task completes&rdquo; choice or context.
          </p>
          <Card className="gap-0 divide-y divide-border/60 py-0">
            {recent.map((repo) => (
              <div
                key={repo.url}
                className="flex min-h-14 items-center gap-3 px-3 py-3 sm:px-4"
              >
                <span
                  aria-hidden
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
                >
                  <GitBranch className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{repo.alias}</p>
                  <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                    {shortRepoUrl(repo.url)}
                  </p>
                </div>
                <AskRepoButton url={repo.url} alias={repo.alias} compact />
                <Button
                  variant="outline"
                  className="h-9 shrink-0 px-2 sm:h-8 sm:px-2.5"
                  onClick={() => saveRecent(repo.url, repo.alias)}
                  disabled={savingUrl === repo.url || removingUrl === repo.url}
                >
                  <Plus className="size-3.5" />
                  <span className="hidden sm:inline">{savingUrl === repo.url ? "Saving..." : "Save"}</span>
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => removeRecent(repo.url, repo.alias)}
                  disabled={removingUrl === repo.url || savingUrl === repo.url}
                  aria-label={`Remove ${repo.alias}`}
                  title="Remove from recently used"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
          </Card>
        </section>
      )}

      {noMatches && (
        <p className="px-1 py-4 text-center text-sm text-muted-foreground">
          No repositories match &ldquo;{query.trim()}&rdquo;.
        </p>
      )}
    </div>
  );
}
