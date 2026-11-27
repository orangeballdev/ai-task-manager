/**
 * What an agent asked a tool to do, as the `gen_ai.tool.call.arguments` span attribute — only
 * when "Record tool call arguments" (Settings → Observability, `otel_tool_arguments`) is on.
 *
 * Pure and unit-tested. Two layers keep content out:
 *  1. A per-tool allow-list: the Bash command and its description, file paths, search
 *     patterns, URLs. Never file contents, edit strings, prompts or todo lists.
 *  2. `redactSecrets()` over every kept value: bearer/basic credentials, `KEY=…` style
 *     assignments, `--token …` flags, credentials in URLs and query strings, well-known
 *     token prefixes, JWTs and private-key blocks.
 * Redaction is best effort, which is why the whole feature is opt-in.
 */

const MAX_VALUE = 1000;
const MAX_UNKNOWN_VALUE = 200;
const MASK = "***";

/** Fields kept per tool. Claude CLI built-ins first, then the API providers' in-process tools. */
const ALLOWED_FIELDS: Record<string, string[]> = {
  Bash: ["command", "description", "timeout", "run_in_background"],
  BashOutput: ["bash_id"],
  KillShell: ["shell_id"],
  Read: ["file_path", "offset", "limit"],
  Write: ["file_path"],
  Edit: ["file_path", "replace_all"],
  MultiEdit: ["file_path"],
  NotebookEdit: ["notebook_path", "cell_id", "edit_mode"],
  Grep: ["pattern", "path", "glob", "type", "output_mode"],
  Glob: ["pattern", "path"],
  LS: ["path"],
  WebFetch: ["url"],
  WebSearch: ["query"],
  Task: ["description", "subagent_type"],
  Agent: ["description", "subagent_type"],
  Skill: ["skill"],
  // In-process tools (src/lib/providers/tools.ts).
  bash: ["command"],
  read_file: ["path"],
  write_file: ["path"],
  str_replace: ["path"],
};

/** Field names never recorded for tools outside the allow-list (MCP tools and the like). */
const CONTENT_FIELD = /^(content|contents|text|body|data|prompt|messages?|old_str(ing)?|new_str(ing)?|edits|todos|input|payload|query_text|html|markdown|code|patch|diff)$/i;
const SECRET_FIELD = /pass(word|wd)?|secret|token|api_?key|auth|credential|private|cookie|session/i;

const SECRET_RULES: Array<[RegExp, string]> = [
  // PEM private keys.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, `-----BEGIN PRIVATE KEY-----${MASK}`],
  // Authorization: Bearer xxx / Basic xxx / token xxx, and bare "Bearer xxx".
  [/\b(Authorization\s*[:=]\s*["']?\s*(?:Bearer|Basic|Token|Bot)?\s*)[^\s"']+/gi, `$1${MASK}`],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/g, `$1${MASK}`],
  // user:pass@host in URLs.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${MASK}:${MASK}@`],
  // Secret-looking query parameters.
  [/([?&](?:access_token|refresh_token|id_token|token|api_?key|key|secret|client_secret|sig|signature|password|auth)=)[^&\s"']+/gi, `$1${MASK}`],
  // FOO_TOKEN=…, password: …, "apiKey": "…".
  [
    /\b([A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|passwd|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|auth)[A-Za-z0-9_.-]*["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s"'&;|]+)/gi,
    `$1${MASK}`,
  ],
  // --token xxx, --password=xxx, -p xxx is too ambiguous to catch.
  [/(--?(?:[a-z0-9-]*-)?(?:token|secret|password|passwd|api-?key|access-key|auth|credentials?)(?:=|\s+))("[^"]*"|'[^']*'|[^\s"']+)/gi, `$1${MASK}`],
  // Well-known token formats.
  [/\b(?:gh[pousr]_|github_pat_|glpat-|sk-(?:ant-|proj-)?|sk_live_|rk_live_|pk_live_|xox[abprs]-|tm_live_|tm_mcp_|npm_|hf_|AIza)[A-Za-z0-9_-]{8,}/g, MASK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
  // JWTs.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, MASK],
];

/** Masks anything in `text` that looks like a credential. Best effort. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_RULES) out = out.replace(pattern, replacement);
  return out;
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function cleanValue(value: unknown, max: number): string | number | boolean | undefined {
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return clip(redactSecrets(value), max);
  return undefined;
}

/**
 * The JSON string for `gen_ai.tool.call.arguments`, or null when nothing is worth recording.
 * Known tools keep only their allow-listed fields; any other tool (e.g. MCP) keeps short
 * scalar fields whose names don't suggest content or a secret.
 */
export function toolCallArguments(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const source = input as Record<string, unknown>;
  const allowed = ALLOWED_FIELDS[toolName];
  const out: Record<string, string | number | boolean> = {};

  if (allowed) {
    for (const field of allowed) {
      const v = cleanValue(source[field], MAX_VALUE);
      if (v !== undefined && v !== "") out[field] = v;
    }
  } else {
    for (const [field, raw] of Object.entries(source)) {
      if (CONTENT_FIELD.test(field) || SECRET_FIELD.test(field)) continue;
      const v = cleanValue(raw, MAX_UNKNOWN_VALUE);
      if (v !== undefined && v !== "") out[field] = v;
    }
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}
