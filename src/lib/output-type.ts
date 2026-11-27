/**
 * Output type helpers shared between client components, API routes, the
 * prompt-builder, and the worker.
 *
 * - `repository` — the agent clones repos, writes code, and pushes commits/PRs.
 * - `file`       — the agent writes documents/files into the workspace `output/`
 *                  directory; they surface in the Files viewer.
 * - `design`     — a specialised file output: the agent produces polished,
 *                  self-contained HTML design mockups (app/UI screens) into
 *                  `output/`, rendered live in the Files viewer.
 * - `result`     — no files and no commits: the agent's final message *is* the
 *                  output, shown inline in the Result section of the task
 *                  details page. Repos (if any) are cloned as read-only context.
 */
export type OutputType = "repository" | "file" | "design" | "result";

/**
 * File-based outputs (`file` and `design`) both write to the workspace
 * `output/` directory, clone repos as read-only context only, and surface their
 * results in the Files viewer rather than as a git branch/PR.
 */
export function isFileBasedOutput(outputType?: string | null): boolean {
  return outputType === "file" || outputType === "design";
}

/** True only for the design flavour of file output. */
export function isDesignOutput(outputType?: string | null): boolean {
  return outputType === "design";
}

/** True for the inline-result output type (no files, no commits). */
export function isResultOutput(outputType?: string | null): boolean {
  return outputType === "result";
}

/**
 * Every non-repository output type: repos are cloned as read-only context and
 * the worker never creates a branch, commits, pushes or opens a PR.
 */
export function isReadOnlyOutput(outputType?: string | null): boolean {
  return isFileBasedOutput(outputType) || isResultOutput(outputType);
}

/** Coerce arbitrary input to a valid stored output type. */
export function normalizeOutputType(value: unknown): OutputType {
  return value === "file" || value === "design" || value === "result" ? value : "repository";
}

/**
 * Where a task's "View files" link should point. `files` is the task's
 * top-level file entries — a task's output normally lives in one wrapper
 * folder, so that folder opens directly in the file browser
 * (`/files?folder=<id>`). A single top-level file opens its detail view, and
 * anything else falls back to the Files root.
 *
 * Never link to `/tasks/<id>/files` here: that is the raw workspace browser,
 * not the task's output.
 */
export function getTaskFilesHref(files?: { id: string; isFolder?: boolean }[] | null): string {
  if (!files || files.length !== 1) return "/files";
  const entry = files[0]!;
  // Entries without isFolder (older payloads) go through /files/[id], which
  // itself redirects folders to /files?folder=<id>.
  return entry.isFolder
    ? `/files?folder=${encodeURIComponent(entry.id)}`
    : `/files/${encodeURIComponent(entry.id)}`;
}
