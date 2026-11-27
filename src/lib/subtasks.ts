/**
 * Agent-created subtasks.
 *
 * A task with `allowSubtasks` lets its agent queue follow-up tasks, e.g. "go
 * through each exam on the platform and create a task to clean up its
 * questions". The agent can't reach the DB or the API, so the hand-off is a
 * file: it writes a JSON array to `.subtasks.json` at the root of its
 * workspace (outside every repo, so it is never committed). After a successful
 * run the worker reads it with `parseSubtaskRequests()`, creates one Task per
 * entry (inheriting the parent's repos/provider/settings, `parentTaskId` set),
 * and renames the file so a later re-run doesn't create them twice.
 *
 * Everything here is pure (no DB, no fs) so it can be unit-tested; the worker
 * owns the I/O.
 */

/** File name, relative to the workspace root, that the agent writes requests to. */
export const SUBTASKS_FILE = ".subtasks.json";

/** Name the worker renames the file to once its requests have been turned into tasks. */
export const SUBTASKS_PROCESSED_FILE = ".subtasks.processed.json";

/** Hard cap on how many subtasks a single run may create. */
export const MAX_SUBTASKS_PER_RUN = 50;

const MAX_TITLE_LENGTH = 200;
const MAX_TEXT_LENGTH = 20_000;

export interface SubtaskRequest {
  title: string;
  description: string;
  context: string | null;
  /** Repo aliases this subtask needs. `null` = all of the parent's repos. */
  repos: string[] | null;
  /** Wait for the previous subtask in the list to finish before starting. */
  dependsOnPrevious: boolean;
}

export interface ParsedSubtasks {
  subtasks: SubtaskRequest[];
  /** Human-readable problems (skipped entries, truncation). Logged by the worker. */
  warnings: string[];
}

function asText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * Parse and validate the contents of `.subtasks.json`.
 *
 * Accepts either a bare array or `{ "subtasks": [...] }`. Each entry needs a
 * `description` (or at least a `title`, which then doubles as the
 * description). Unknown repo aliases are dropped with a warning; an entry
 * whose aliases are all unknown falls back to every parent repo rather than
 * being created with none.
 */
export function parseSubtaskRequests(raw: string, parentRepoAliases: string[] = []): ParsedSubtasks {
  const warnings: string[] = [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return { subtasks: [], warnings: [`${SUBTASKS_FILE} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }

  const list = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { subtasks?: unknown }).subtasks)
      ? (data as { subtasks: unknown[] }).subtasks
      : null;
  if (!list) {
    return { subtasks: [], warnings: [`${SUBTASKS_FILE} must contain a JSON array of subtasks (or {"subtasks": [...]})`] };
  }

  const known = new Set(parentRepoAliases);
  const subtasks: SubtaskRequest[] = [];
  list.forEach((entry, i) => {
    if (!entry || typeof entry !== "object") {
      warnings.push(`Subtask #${i + 1} skipped: not an object`);
      return;
    }
    const e = entry as Record<string, unknown>;
    let title = asText(e.title, MAX_TITLE_LENGTH);
    let description = asText(e.description, MAX_TEXT_LENGTH);
    if (!title && !description) {
      warnings.push(`Subtask #${i + 1} skipped: needs a title or description`);
      return;
    }
    if (!description) description = title;
    if (!title) title = description.split("\n")[0].slice(0, 80);
    const context = asText(e.context, MAX_TEXT_LENGTH) || null;

    let repos: string[] | null = null;
    if (Array.isArray(e.repos)) {
      const requested = e.repos.filter((r): r is string => typeof r === "string").map((r) => r.trim()).filter(Boolean);
      const unknown = requested.filter((r) => !known.has(r));
      if (unknown.length > 0) {
        warnings.push(`Subtask #${i + 1} ("${title}"): unknown repo alias(es) ${unknown.join(", ")} ignored`);
      }
      const valid = [...new Set(requested.filter((r) => known.has(r)))];
      repos = valid.length > 0 ? valid : null;
    }

    subtasks.push({
      title,
      description,
      context,
      repos,
      dependsOnPrevious: e.dependsOnPrevious === true,
    });
  });

  if (subtasks.length > MAX_SUBTASKS_PER_RUN) {
    warnings.push(`${subtasks.length} subtasks requested; only the first ${MAX_SUBTASKS_PER_RUN} were created`);
    subtasks.length = MAX_SUBTASKS_PER_RUN;
  }
  return { subtasks, warnings };
}

/**
 * Context stored on each created subtask: a short note about where it came
 * from, followed by whatever the agent wrote for it.
 */
export function buildSubtaskContext(parent: { id: string; title: string }, requestContext: string | null): string {
  const origin = `This task was created as a subtask of "${parent.title}" (task ${parent.id}). Focus only on the work described here; other subtasks handle the rest.`;
  return requestContext ? `${origin}\n\n${requestContext}` : origin;
}

/** System-prompt section that tells the agent it may create subtasks and how. */
export function buildSubtasksPromptSection(workspacePath: string, repoAliases: string[]): string {
  const filePath = `${workspacePath.replace(/\/+$/, "")}/${SUBTASKS_FILE}`;
  const repoNote = repoAliases.length > 0
    ? `Each subtask gets all of this task's repositories (${repoAliases.join(", ")}) unless you list a subset in \`repos\`.`
    : "Subtasks run with the same settings as this task.";
  return `## Creating Subtasks
This task is allowed to create subtasks: separate tasks that are queued and run by other agents after you finish. Use them when the user asks you to, or when the work splits naturally into many independent pieces (for example "for each exam, create a task to clean up its questions"). In that case, do the discovery yourself (find every item that needs work), then create one subtask per item instead of doing all of it in this run.

To create subtasks, write a JSON array to \`${filePath}\` (the workspace root, not inside a repository, so it is never committed). Each entry:
\`\`\`json
[
  {
    "title": "Clean up questions for exam: Biology 101",
    "description": "What this subtask must do. Be specific: it will be read by an agent that has not seen this conversation.",
    "context": "Optional extra instructions, IDs, file paths or findings the subtask needs.",
    "repos": ["optional-repo-alias"],
    "dependsOnPrevious": false
  }
]
\`\`\`
- Only \`description\` (or \`title\`) is required. ${repoNote}
- Set \`dependsOnPrevious: true\` if a subtask must wait for the one before it in the list to complete; otherwise subtasks may run in parallel.
- Make every subtask self-contained. It will not see your conversation, only its own title, description and context.
- At most ${MAX_SUBTASKS_PER_RUN} subtasks per run. Subtasks cannot create further subtasks.
- Subtasks are created only if this run completes successfully. Write the file once, with the complete list, before you finish. In your final message, say how many subtasks you created and what they cover.`;
}
