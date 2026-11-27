/**
 * State + block helpers for the Slack task-proposal form.
 *
 * The proposal message the Slack bot posts is a full configuration form built out of
 * Slack blocks: the provider/model menus, plus scheduling (run now / at a specific time /
 * recurring cron), repos and their branches, what happens to the changes (new branch,
 * existing branch, push to main, open a PR) and a free-text context field.
 *
 * Every widget writes straight back onto the stored proposal JSON
 * (`SlackConversation.proposed`), which is the single source of truth read by the
 * "Create Task" button — there is no separate draft state anywhere. Everything in this
 * module is pure so it can be unit-tested without a Slack app or a database;
 * `src/integrations/slack.ts` owns the I/O (rendering the message, DB reads/writes).
 */

import { type ProposedTask, normalizeGitUrl } from "./chat";
import { normalizeMaxRuns } from "./max-runs";

export interface SlackProposedTask extends ProposedTask {
  providerId?: string;
  model?: string;
  /**
   * UI-only: the repo URL currently typed into the "add a repo" field. Kept on the
   * stored proposal so a re-render doesn't wipe what the user was in the middle of
   * typing; cleared as soon as the repo is added and never written to the Task.
   */
  newRepoUrl?: string;
  /**
   * UI-only: the git-output mode the user picked. Needed because "push to an existing
   * branch" can't be derived from the push flags until the branch name is typed — without
   * it the menu would snap back to "new branch" the moment it was selected.
   */
  gitMode?: GitMode;
}

export type ScheduleMode = "now" | "scheduled" | "recurring";
export type GitMode = "branch" | "target" | "main" | "pr";

export const SCHEDULE_MODE_LABELS: Record<ScheduleMode, string> = {
  now: "Run now",
  scheduled: "Run at a specific time",
  recurring: "Recurring (cron)",
};

export const GIT_MODE_LABELS: Record<GitMode, string> = {
  branch: "New branch",
  target: "Push to existing branch",
  main: "Push to main",
  pr: "Create pull request",
};

/** The schedule mode implied by the proposal — recurring wins over a one-off datetime. */
export function scheduleModeOf(proposed: SlackProposedTask): ScheduleMode {
  if (proposed.isRecurring) return "recurring";
  if (proposed.scheduledFor) return "scheduled";
  return "now";
}

/**
 * The git-output mode the user picked, falling back to whatever the model's
 * pushToMain/createPR/targetBranch flags imply for a freshly proposed task.
 */
export function gitModeOf(proposed: SlackProposedTask): GitMode {
  if (proposed.gitMode) return proposed.gitMode;
  if (proposed.createPR) return "pr";
  if (proposed.pushToMain) return "main";
  if (proposed.targetBranch) return "target";
  return "branch";
}

export function applyGitMode(proposed: SlackProposedTask, mode: GitMode) {
  proposed.gitMode = mode;
  proposed.createPR = mode === "pr";
  proposed.pushToMain = mode === "main";
  if (mode !== "target") proposed.targetBranch = undefined;
}

/**
 * Switch the proposal between run-now / scheduled / recurring, clearing the fields that
 * belong to the other modes so a stale cron expression can't leak onto a one-off task.
 */
export function applyScheduleMode(proposed: SlackProposedTask, mode: ScheduleMode) {
  proposed.isRecurring = mode === "recurring";
  if (mode === "recurring") {
    proposed.scheduledFor = undefined;
    return;
  }
  proposed.cronExpression = undefined;
  proposed.maxRuns = null;
  if (mode === "now") {
    proposed.scheduledFor = undefined;
  } else if (!proposed.scheduledFor) {
    // Keep whatever the model proposed; otherwise seed the pickers with the next hour.
    const parts = scheduledForParts();
    proposed.scheduledFor = composeScheduledFor(parts.date, parts.time);
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Default when the user switches to "run at a specific time": the next full hour. */
function defaultScheduleDate(): Date {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

/**
 * Split a stored `scheduledFor` into the `YYYY-MM-DD` / `HH:mm` pair the Slack date and
 * time pickers need. Values are interpreted (and rendered) in the server's local timezone,
 * which is also how `new Date(scheduledFor)` resolves them at task-creation time.
 */
export function scheduledForParts(value?: string): { date: string; time: string } {
  const parsed = value ? new Date(value) : null;
  const d = parsed && !Number.isNaN(parsed.getTime()) ? parsed : defaultScheduleDate();
  return {
    date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
  };
}

export function composeScheduledFor(date: string, time: string): string {
  return `${date}T${time}`;
}

export function formatScheduledFor(value?: string): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

export function isValidScheduledFor(value?: string): boolean {
  return !!value && !Number.isNaN(new Date(value).getTime());
}

// --- Block ids ---
//
// Every interactive element lives in a block whose id encodes the thread it belongs to
// (and, for per-repo widgets, which repo) so the action handlers can find the right
// conversation straight from the payload: `kind__[index__]threadTs`.

const BLOCK_SEP = "__";

export function blockId(kind: string, threadTs: string, index?: number): string {
  return index === undefined
    ? `${kind}${BLOCK_SEP}${threadTs}`
    : `${kind}${BLOCK_SEP}${index}${BLOCK_SEP}${threadTs}`;
}

export function decodeBlockId(id: string): { kind: string; index?: number; threadTs: string } {
  if (id.includes(BLOCK_SEP)) {
    const parts = id.split(BLOCK_SEP);
    const index = parts.length > 2 ? Number(parts[1]) : undefined;
    return {
      kind: parts[0],
      index: Number.isInteger(index) ? index : undefined,
      threadTs: parts[parts.length - 1],
    };
  }
  // Legacy proposal messages, posted before the full form existed, used `cfg_<threadTs>`.
  return { kind: id.split("_")[0], threadTs: id.replace(/^[^_]*_/, "") };
}

export function threadTsFromBlockId(id: string): string {
  return decodeBlockId(id).threadTs;
}

// --- Reading widget values ---

/** Widget payload shape shared by `state.values` entries and the action that fired. */
export interface SlackFieldValue {
  value?: string | null;
  selected_date?: string | null;
  selected_time?: string | null;
}

/**
 * Write one widget's value onto the proposal. Menus that need extra work when they change
 * (provider, schedule mode, git mode) have their own handlers and are ignored here.
 */
export function applyFieldValue(
  proposed: SlackProposedTask,
  actionId: string,
  raw: SlackFieldValue,
  index?: number,
) {
  const text = typeof raw?.value === "string" ? raw.value.trim() : undefined;
  switch (actionId) {
    case "input_context":
      proposed.context = text || undefined;
      break;
    case "input_cron":
      proposed.cronExpression = text || undefined;
      break;
    case "input_max_runs":
      proposed.maxRuns = normalizeMaxRuns(text);
      break;
    case "input_target_branch":
      proposed.targetBranch = text || undefined;
      break;
    case "input_new_repo":
      proposed.newRepoUrl = text || undefined;
      break;
    case "input_repo_branch":
      if (index !== undefined && proposed.repos?.[index]) {
        proposed.repos[index].branch = text || undefined;
      }
      break;
    case "pick_schedule_date":
      if (raw.selected_date) {
        proposed.scheduledFor = composeScheduledFor(raw.selected_date, scheduledForParts(proposed.scheduledFor).time);
      }
      break;
    case "pick_schedule_time":
      if (raw.selected_time) {
        proposed.scheduledFor = composeScheduledFor(scheduledForParts(proposed.scheduledFor).date, raw.selected_time);
      }
      break;
    default:
      break;
  }
}

/**
 * Merge the message's current input values into the proposal.
 *
 * Slack ships the state of the message's input blocks with each `block_actions` payload,
 * so text the user typed but never submitted (no Enter pressed) is still captured — both
 * when another widget is used and when "Create Task" is finally clicked. Without this,
 * re-rendering the message after any interaction would silently discard it. Handlers also
 * apply their own action's value directly, so nothing depends on `state` being populated.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyFormState(proposed: SlackProposedTask, state: any): SlackProposedTask {
  const values = state?.values as Record<string, Record<string, SlackFieldValue>> | undefined;
  if (!values) return proposed;

  for (const [id, blockValues] of Object.entries(values)) {
    const { index } = decodeBlockId(id);
    for (const [actionId, raw] of Object.entries(blockValues ?? {})) {
      applyFieldValue(proposed, actionId, raw ?? {}, index);
    }
  }
  return proposed;
}

/** Append a repo, normalizing the clone URL. Returns false for blanks and duplicates. */
export function addRepo(proposed: SlackProposedTask, url: string): boolean {
  if (!url?.trim()) return false;
  const normalized = normalizeGitUrl(url);
  const repos = proposed.repos ?? (proposed.repos = []);
  if (repos.some((r) => r.url === normalized)) return false;
  repos.push({ url: normalized });
  return true;
}

export function removeRepo(proposed: SlackProposedTask, index: number) {
  if (!Number.isInteger(index) || !proposed.repos?.[index]) return;
  proposed.repos.splice(index, 1);
  // Git output only means something with a repo attached — reset it once the last one goes.
  if (!proposed.repos.length) applyGitMode(proposed, "branch");
}

/**
 * Clean up a proposal fresh out of the model before it's rendered as a form.
 *
 * The AI is free to invent a `scheduledFor` like "tomorrow morning"; anything Date can't
 * parse is dropped back to "run now" rather than rendering a form the user can't submit.
 */
export function sanitizeProposal(proposed: SlackProposedTask): SlackProposedTask {
  if (proposed.scheduledFor && !isValidScheduledFor(proposed.scheduledFor)) {
    proposed.scheduledFor = undefined;
  }
  if (proposed.isRecurring) proposed.scheduledFor = undefined;
  return proposed;
}

/**
 * Why the proposal can't be created yet, or null when it's good to go.
 */
export function validateProposal(proposed: SlackProposedTask): string | null {
  const scheduleMode = scheduleModeOf(proposed);
  if (scheduleMode === "recurring" && !proposed.cronExpression?.trim()) {
    return "Add a cron expression before creating this recurring task.";
  }
  if (scheduleMode === "scheduled" && !isValidScheduledFor(proposed.scheduledFor)) {
    return "That scheduled date/time isn't valid — pick one and try again.";
  }
  if (gitModeOf(proposed) === "target" && !proposed.targetBranch?.trim()) {
    return "Enter the target branch to push to, then click Create Task again.";
  }
  return null;
}

// --- Rendering ---

/** Head-truncate for summary lines. */
function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/** The read-only recap shown above the form (and left behind once the task is created). */
export function summariseProposal(proposed: SlackProposedTask, providerLabel?: string): string {
  const mode = scheduleModeOf(proposed);
  const schedule = mode === "recurring"
    ? `\`${proposed.cronExpression ?? "cron not set"}\`${proposed.maxRuns ? ` (max ${proposed.maxRuns} runs)` : " (unlimited runs)"}`
    : mode === "scheduled"
      ? formatScheduledFor(proposed.scheduledFor)
      : "Run now";

  const repoLines = proposed.repos?.map((r) => (r.branch ? `${r.url} (branch: \`${r.branch}\`)` : r.url));
  const gitMode = gitModeOf(proposed);
  const gitOutput = gitMode === "target"
    ? `Push to \`${proposed.targetBranch}\``
    : GIT_MODE_LABELS[gitMode];

  return [
    `*Title:* ${proposed.title}`,
    `*Description:* ${proposed.description}`,
    `*Schedule:* ${schedule}`,
    repoLines?.length ? `*Repos:* ${repoLines.join(", ")}` : "*Repos:* none",
    repoLines?.length ? `*Git output:* ${gitOutput}` : null,
    proposed.context ? `*Context:* ${clip(proposed.context, 500)}` : null,
    providerLabel ? `*Runs with:* ${providerLabel}` : null,
  ].filter(Boolean).join("\n");
}

/**
 * An `input` block with a text field. By default it dispatches an action when the user
 * presses Enter, which is how single-line fields save themselves. Multi-line fields must
 * pass `dispatch: false` — Enter inserts a newline there, so they're picked up from the
 * message `state` the next time any other widget (or "Create Task") fires instead.
 */
export function textInputBlock(opts: {
  id: string;
  actionId: string;
  label: string;
  placeholder: string;
  initial?: string;
  multiline?: boolean;
  dispatch?: boolean;
  hint?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): any {
  const dispatch = opts.dispatch ?? true;
  return {
    type: "input",
    block_id: opts.id,
    ...(dispatch ? { dispatch_action: true } : {}),
    optional: true,
    label: { type: "plain_text", text: opts.label },
    ...(opts.hint ? { hint: { type: "plain_text", text: opts.hint } } : {}),
    element: {
      type: "plain_text_input",
      action_id: opts.actionId,
      ...(opts.multiline ? { multiline: true } : {}),
      ...(opts.initial ? { initial_value: opts.initial } : {}),
      placeholder: { type: "plain_text", text: opts.placeholder },
      ...(dispatch ? { dispatch_action_config: { trigger_actions_on: ["on_enter_pressed"] } } : {}),
    },
  };
}

/** A select option, with the label clamped to Slack's 75-character limit. */
export function option(text: string, value: string) {
  return {
    text: { type: "plain_text" as const, text: text.length > 75 ? `${text.slice(0, 74)}…` : text },
    value,
  };
}
