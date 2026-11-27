export type TaskStatus = "pending" | "running" | "paused" | "throttled" | "completed" | "no_changes" | "failed" | "killed" | "timedout" | "backlog" | "awaiting_approval";

export type AIProviderType = "cli" | "api" | "openai" | "claude-pki" | "codex-cli";

export interface AIProvider {
  id: string;
  name: string;
  type: AIProviderType;
  isDefault: boolean;
  isEnabled: boolean;
  /** Opts this provider out of the Smart Provider Picker's auto-selection only; it remains
   * usable when picked explicitly or via the regular default/fallback tiers. */
  excludeFromSmartPicker: boolean;
  /** Share (1–100%) of each subscription plan window tasks may use; the rest is kept free for
   * manual use. 100 = no cap. Only enforced for subscription CLIs (`cli`, `codex-cli`). */
  maxUsagePercent: number;
  configDir: string | null;
  apiKey: string | null;
  baseUrl: string | null;
  model: string | null;
  // claude-pki-specific — the raw certificate bytes are never sent to the client,
  // only whether one is configured plus its original filename.
  pkiCertConfigured?: boolean;
  pkiCertFilename?: string | null;
  proxyUrl?: string | null;
  createdAt: string;
  updatedAt: string;
}

export function getDisplayStatus(task: { status: TaskStatus | string; isEnabled: boolean }): TaskStatus {
  if (!task.isEnabled && task.status === "pending") return "backlog";
  return task.status as TaskStatus;
}

export interface TaskRepo {
  id: string;
  taskId: string;
  alias: string;
  url: string;
  branch?: string | null;
}

export interface TaskLog {
  id: string;
  taskId: string;
  content: string;
  level: string;
  createdAt: string;
}

export interface TaskAttachment {
  id: string;
  name: string;
  path: string;
  mimeType: string;
  size: number;
}

/**
 * A file selected from one of the task's git repositories to be included in the
 * agent prompt as read-only context. The worker resolves `repoAlias` + `path`
 * to a location inside the cloned workspace when building the prompt.
 * `repoAlias` may be empty when the task has no repositories configured.
 */
export interface TaskContextFile {
  repoAlias: string;
  path: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  context: string | null;
  provider: string;
  model: string | null;
  status: TaskStatus;
  position: number;
  priority: string;
  // Optional thinking-effort override (see src/lib/effort.ts). Null means
  // "use the provider's own default".
  effort: string | null;
  retryCount: number;
  // Counts "Review PR" self-review re-runs, tracked separately from retryCount — see
  // src/app/api/tasks/[id]/review-pr/route.ts and src/lib/resume.ts.
  reviewIterationCount: number;
  nextRetryAt: string | null;
  scheduledFor: string | null;
  workspacePath: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCost: number | null;
  branchName: string | null;
  commitSha: string | null;
  prSummary: string | null;
  cronExpression: string | null;
  /** Recurring templates only: max number of scheduled runs. null = unlimited. */
  maxRuns: number | null;
  /** Recurring templates only: how many scheduled runs have fired so far. */
  runCount: number;
  pushToMain: boolean;
  targetBranch: string | null;
  createPR: boolean;
  prUrl: string | null;
  prNumber: number | null;
  /** JSON map of repo alias -> { url, number } — populated when a task creates PRs across multiple repos. */
  prUrls: string | null;
  prError: string | null;
  mergeableState: string | null;
  ciStatus: string | null;
  hasConflict: boolean;
  conflictMessage: string | null;
  noChanges: boolean;
  tokenBudget: number | null;
  costBudget: number | null;
  attachments: string | null;
  attachmentsFolder: string | null;
  contextFiles: string | null;
  notes: string | null;
  labels: string | null;
  /** Sender address, set when this task was created via the inbound-email integration. */
  sourceEmail: string | null;
  testPlan: string | null;
  reviewStatus: string | null;
  /** Review-only ticket: created straight into In Review, never run (src/lib/review-only.ts). */
  reviewOnly?: boolean;
  /** Hidden from the board's To Do column (display only; see Board Settings → "Show hidden tasks"). */
  hiddenOnBoard?: boolean;
  /** Review metadata for review-only tickets — repo URL, branch, commit SHAs (JSON array) and PR link. */
  reviewRepo?: string | null;
  reviewBranch?: string | null;
  reviewCommits?: string | null;
  reviewPrUrl?: string | null;
  systemPrompt: string | null;
  outputType: string;
  isRecurringTemplate: boolean;
  isEnabled: boolean;
  isHailMary: boolean;
  createValidationTask: boolean;
  allowSubtasks?: boolean;
  parentTaskId?: string | null;
  lastScheduledAt: string | null;
  recurringTemplateId: string | null;
  hailMaryEligible: boolean;
  hailMaryBurstLimit: number | null;
  aiProviderId: string | null;
  aiProvider?: { name: string; type: string; model: string | null } | null;
  dependsOnTaskId?: string | null;
  dependsOn?: { id: string; title: string; status: string } | null;
  /** Set when this task is executed by a Team pipeline instead of a single agent. */
  teamId?: string | null;
  team?: { id: string; name: string } | null;
  recurringInstances?: Task[];
  createdAt: string;
  updatedAt: string;
  repos: TaskRepo[];
  logs?: TaskLog[];
  files?: { id: string; isFolder?: boolean }[];
}
