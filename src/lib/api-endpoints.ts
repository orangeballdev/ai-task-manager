// Machine-readable description of the public API (/api/v1/*), used to render both the
// written docs at /docs/api and the interactive "Try it" console embedded in that page.
// Keeping the two views driven by one spec means the docs can't drift from what the
// playground actually sends — and describing a new endpoint here is the only step
// needed to document it (see src/app/docs/api/page.tsx, which just maps over this array).
//
// This deliberately mirrors OpenAPI's shape (params/requestBody/responses) without
// pulling in a dependency — swap it for a real OpenAPI doc later if this grows.

export interface ApiParam {
  name: string;
  type: string;
  required?: boolean;
  description: string;
  example?: string;
}

export interface ApiEndpoint {
  /** Also used as the in-page anchor id and DOCS_NAV target. */
  id: string;
  method: "GET" | "POST" | "PATCH";
  /** Path template, e.g. "/api/v1/tasks/{id}". */
  path: string;
  summary: string;
  description: string;
  pathParams?: ApiParam[];
  queryParams?: ApiParam[];
  bodyParams?: ApiParam[];
  /** Pretty-printed JSON string used to prefill the "Try it" request body editor. */
  bodyExample?: string;
  successStatus: number;
  /** Pretty-printed JSON string shown as the example response. */
  responseExample: string;
}

export const API_BASE_PATH = "/api/v1";

export const API_ENDPOINTS: ApiEndpoint[] = [
  {
    id: "create-task",
    method: "POST",
    path: "/api/v1/tasks",
    summary: "Create a task",
    description:
      "Creates a task. By default it's queued immediately (`autoStart: true`) and the worker " +
      "picks it up on its next poll (within ~5s). Pass `autoStart: false` to create it " +
      "disabled and start it later with the start endpoint below.\n\n" +
      "Review-only tickets: pass `reviewOnly: true` to create a reminder to review work done somewhere else " +
      "(a commit pushed by hand, another Claude session) instead of an agent task. It goes straight to In Review " +
      "(`status: 'completed'`, `reviewStatus: 'in_review'`), the worker never picks it up and it spends no tokens. " +
      "The description says what to review and why (e.g. the commit message); attach what to look at in " +
      "`reviewMetadata`. Run options (`repos`, `autoStart: false`, schedules, teams, dependencies, subtasks) are " +
      "rejected on it. Approving moves it to Done as usual. Request changes is refused (409) — there's no agent run " +
      "to continue, so create a normal task on the referenced branch instead. Start/re-run is refused the same way.",
    bodyParams: [
      { name: "description", type: "string", required: true, description: "What the agent should do. The only required field." },
      { name: "title", type: "string", description: "Short title. Derived from the description when omitted." },
      { name: "context", type: "string", description: "Extra background/instructions kept separate from the description." },
      { name: "repos", type: "array", description: "Repos to check out: [{ alias, url, branch? }]. Required unless outputType is 'file', 'design' or 'result'." },
      { name: "outputType", type: "string", description: "'repository' (default), 'file', 'design', or 'result' (agent's answer shown inline on the task page — no files or commits)." },
      { name: "priority", type: "string", description: "'low' | 'normal' (default) | 'high' | 'urgent'." },
      { name: "effort", type: "string", description: "'low' | 'medium' | 'high' | 'xhigh' | 'max'. Omit to use the provider default." },
      { name: "model", type: "string", description: "Override model id. Omit to use the configured default." },
      { name: "toolAccess", type: "object", description: "Per-task external tool access, e.g. { \"github-cli\": true } to let the agent use the GitHub CLI, or false to deny it. Tools left out follow Settings → Agent Tools." },
      { name: "labels", type: "array", description: "Freeform string labels, e.g. [\"bug\", \"backend\"]." },
      { name: "pushToMain", type: "boolean", description: "Push directly to the default branch instead of opening a PR." },
      { name: "createPR", type: "boolean", description: "Open a pull request when the task finishes." },
      { name: "targetBranch", type: "string", description: "Branch to base work/PRs off of. Defaults to the repo's default branch." },
      { name: "tokenBudget", type: "number", description: "Kill the task if it exceeds this many tokens." },
      { name: "costBudget", type: "number", description: "Kill the task if estimated cost exceeds this (USD)." },
      { name: "allowSubtasks", type: "boolean", description: "Let the agent split the work into follow-up tasks of its own, created when it finishes (e.g. one task per item it discovered). Subtasks inherit this task's repos and settings and can't create further subtasks. Defaults to false." },
      { name: "autoStart", type: "boolean", description: "Queue immediately. Defaults to true; pass false to start it later." },
      { name: "notes", type: "string", description: "Private notes on the task (not shown to the agent)." },
      { name: "reviewOnly", type: "boolean", description: "true = a review-only ticket: created straight into In Review, never run by an agent. See above." },
      { name: "reviewMetadata", type: "object", description: "Review-only tickets: { repo?, branch?, commits?, prUrl? }, all optional. repo: a saved repo's URL or any Git URL; branch: a branch name; commits: an array of commit SHAs (7–40 hex chars, short or full, stored as given); prUrl: an http(s) link to the PR. A bad value is a 400 naming the field, e.g. 'reviewMetadata.commits'." },
    ],
    bodyExample: JSON.stringify(
      {
        description: "Add a health check endpoint at /api/health that returns { ok: true }.",
        repos: [{ alias: "app", url: "https://github.com/your-org/your-repo.git" }],
        priority: "normal",
        createPR: true,
      },
      null,
      2
    ),
    successStatus: 201,
    responseExample: JSON.stringify(
      {
        data: {
          id: "clx1a2b3c0000",
          title: "Add a health check endpoint at /api/health...",
          description: "Add a health check endpoint at /api/health that returns { ok: true }.",
          status: "pending",
          outputType: "repository",
          priority: "normal",
          effort: null,
          repos: [{ alias: "app", url: "https://github.com/your-org/your-repo.git", branch: null }],
          branchName: null,
          commitSha: null,
          prUrl: null,
          prNumber: null,
          createdAt: "2026-08-01T12:00:00.000Z",
          updatedAt: "2026-08-01T12:00:00.000Z",
        },
      },
      null,
      2
    ),
  },
  {
    id: "start-task",
    method: "POST",
    path: "/api/v1/tasks/{id}/start",
    summary: "Start a task",
    description:
      "Queues a task for the worker: sets it enabled, status 'pending', and clears any " +
      "retry/schedule delay so it's picked up on the very next poll. Mainly for tasks " +
      "created with `autoStart: false`, but works on any non-running task — including " +
      "kicking a failed/paused one back into the queue. Returns 409 if the task is already running.",
    pathParams: [{ name: "id", type: "string", required: true, description: "Task id, from the create-task response." }],
    successStatus: 200,
    responseExample: JSON.stringify(
      { data: { id: "clx1a2b3c0000", status: "pending", updatedAt: "2026-08-01T12:00:05.000Z" } },
      null,
      2
    ),
  },
  {
    id: "get-task",
    method: "GET",
    path: "/api/v1/tasks/{id}",
    summary: "Get a task",
    description:
      "Fetches a task's current status and results: branch/commit/PR info for repository " +
      "tasks, generated files for file/design tasks, and token/cost usage. Pass `?logs=true` " +
      "to include the full run log.",
    pathParams: [{ name: "id", type: "string", required: true, description: "Task id." }],
    queryParams: [{ name: "logs", type: "boolean", description: "Include the full TaskLog history. Defaults to false." }],
    successStatus: 200,
    responseExample: JSON.stringify(
      {
        data: {
          id: "clx1a2b3c0000",
          status: "completed",
          outputType: "repository",
          branchName: "task/clx1a2b3c0000",
          commitSha: "a1b2c3d",
          prUrl: "https://github.com/your-org/your-repo/pull/42",
          prNumber: 42,
          inputTokens: 18342,
          outputTokens: 2110,
          estimatedCost: 0.41,
          files: [],
          updatedAt: "2026-08-01T12:04:32.000Z",
        },
      },
      null,
      2
    ),
  },
  {
    id: "update-task",
    method: "PATCH",
    path: "/api/v1/tasks/{id}",
    summary: "Update a task",
    description:
      "Edits a task's ticket fields — title, description, context, priority, labels and notes — and, on a " +
      "review-only ticket, its `reviewMetadata`. Only the fields you send change; inside `reviewMetadata` only the " +
      "keys you send change, and `null`, `\"\"` or `[]` clears one. Description and context can't change while the " +
      "task is running. Run settings (repos, provider, schedule, …) are edited from the UI or the MCP update_task tool.",
    pathParams: [{ name: "id", type: "string", required: true, description: "Task id." }],
    bodyParams: [
      { name: "title", type: "string", description: "New title. Empty falls back to the start of the description." },
      { name: "description", type: "string", description: "New description. Can't be empty." },
      { name: "context", type: "string", description: "New context; null clears it." },
      { name: "priority", type: "string", description: "'low' | 'normal' | 'high' | 'urgent'." },
      { name: "labels", type: "array", description: "Replaces the labels; null or [] clears them." },
      { name: "notes", type: "string", description: "Replaces the notes; null clears them." },
      { name: "reviewMetadata", type: "object", description: "Review-only tickets: { repo?, branch?, commits?, prUrl? } — same rules as on create." },
    ],
    bodyExample: JSON.stringify(
      { reviewMetadata: { commits: ["65948886", "a1b2c3d4e5"], prUrl: "https://github.com/your-org/your-repo/pull/42" } },
      null,
      2
    ),
    successStatus: 200,
    responseExample: JSON.stringify(
      {
        data: {
          id: "clx1a2b3c0000",
          title: "Show the executive summary read-only until the poster chooses Edit",
          status: "completed",
          reviewStatus: "in_review",
          reviewOnly: true,
          reviewMetadata: {
            repo: "git@github.com:your-org/your-repo.git",
            branch: "develop",
            commits: ["65948886", "a1b2c3d4e5"],
            prUrl: "https://github.com/your-org/your-repo/pull/42",
          },
        },
      },
      null,
      2
    ),
  },
  {
    id: "list-tasks",
    method: "GET",
    path: "/api/v1/tasks",
    summary: "List tasks",
    description: "Lists tasks, most recent first. Recurring templates are excluded.",
    queryParams: [
      { name: "q", type: "string", description: "Free text found in the title, description or context, or a commit SHA / PR URL (review metadata and agents' commits and PRs)." },
      { name: "reviewOnly", type: "boolean", description: "true = only review-only tickets; false = only agent tasks." },
      { name: "status", type: "string", description: "Filter to one status, e.g. 'pending', 'running', 'completed', 'failed'." },
      { name: "limit", type: "number", description: "Max results, 1-100. Defaults to 20." },
    ],
    successStatus: 200,
    responseExample: JSON.stringify(
      { data: [{ id: "clx1a2b3c0000", title: "Add a health check endpoint", status: "completed" }] },
      null,
      2
    ),
  },
  {
    id: "list-task-files",
    method: "GET",
    path: "/api/v1/tasks/{id}/files",
    summary: "List a task's output files",
    description:
      "Lists the files a task produced in its workspace. Defaults to the `output` directory, " +
      "where file and design tasks write their results. Pass `?recursive=true` to walk the " +
      "whole tree in one call instead of a request per directory level.",
    pathParams: [{ name: "id", type: "string", required: true, description: "Task id." }],
    queryParams: [
      { name: "path", type: "string", description: "Directory to list, relative to the workspace. Defaults to 'output'." },
      { name: "recursive", type: "boolean", description: "Walk subdirectories too. Defaults to false." },
    ],
    successStatus: 200,
    responseExample: JSON.stringify(
      {
        data: {
          path: "output",
          entries: [
            { name: "findings.json", path: "output/findings.json", type: "file", size: 8213, modifiedAt: "2026-08-01T12:04:32.000Z" },
          ],
        },
      },
      null,
      2
    ),
  },
  {
    id: "read-task-file",
    method: "GET",
    path: "/api/v1/tasks/{id}/files/content",
    summary: "Read a task's output file",
    description:
      "Returns the contents of one text file from a task's workspace. This is how a caller " +
      "that created a file-output task collects the result: poll GET /api/v1/tasks/{id} until " +
      "the status is terminal, then read the file the task was asked to write. Binary files " +
      "and anything over 5MB are refused.",
    pathParams: [{ name: "id", type: "string", required: true, description: "Task id." }],
    queryParams: [
      { name: "path", type: "string", required: true, description: "File path relative to the workspace, e.g. 'output/findings.json'.", example: "output/findings.json" },
    ],
    successStatus: 200,
    responseExample: JSON.stringify(
      {
        data: {
          path: "output/findings.json",
          content: '{"findings": []}',
          size: 17,
          modifiedAt: "2026-08-01T12:04:32.000Z",
        },
      },
      null,
      2
    ),
  },
];
