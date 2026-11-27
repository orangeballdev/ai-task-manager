/**
 * A short, content-free description of why a tool call failed, for the `execute_tool` span's
 * status message. Tool output is agent content (file contents, command output, possibly
 * secrets) and is never recorded, so this only ever returns a message from a fixed allow-list
 * of shapes: an exit code, a timeout, a permission denial, a Node error code, or the first
 * line of the Claude CLI's own `<tool_use_error>` text (written by the CLI, not the tool).
 * Anything else gets a generic message rather than a slice of the output.
 */
export interface ToolErrorDescription {
  message: string;
  /** Process exit code, when the failure was a command exiting non-zero. */
  exitCode?: number;
}

const GENERIC = "Tool returned an error (output not recorded)";
const MAX_CLI_MESSAGE = 160;

/** Flattens a `tool_result` content value (string or content blocks) to its text. */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
      .join("\n");
  }
  return "";
}

export function describeToolError(content: unknown): ToolErrorDescription {
  const text = toolResultText(content).trim();
  if (!text) return { message: GENERIC };

  // Claude CLI Bash: "Exit code 1\n<output>".
  const exit = /^Exit code (\d+)\b/.exec(text);
  if (exit) return { message: `Exit code ${exit[1]}`, exitCode: Number(exit[1]) };

  if (/^Command timed out\b/i.test(text)) return { message: "Command timed out" };
  if (/requested permissions to use|permission to use .* (was|has been) denied|haven't granted it/i.test(text)) {
    return { message: "Permission denied" };
  }
  if (/^(The user doesn't want to proceed|\[Request interrupted)/i.test(text)) return { message: "Interrupted" };

  // The CLI's own validation errors ("File has not been read yet…", "String to replace not
  // found in file."). Only the first line: later lines can quote file content.
  const cli = /<tool_use_error>([\s\S]*?)(?:<\/tool_use_error>|$)/.exec(text);
  if (cli) {
    const line = cli[1].trim().split("\n")[0].trim();
    if (line) return { message: line.length > MAX_CLI_MESSAGE ? `${line.slice(0, MAX_CLI_MESSAGE - 1)}…` : line };
  }

  // In-process tools (API providers): "Error: Command failed: <cmd>…", "Error reading file: ENOENT…".
  if (/^Error: Command failed\b/.test(text)) return { message: "Command failed" };
  if (/^Error: old_str not found\b/.test(text)) return { message: "old_str not found" };
  if (/^Error: old_str found \d+ times\b/.test(text)) return { message: "old_str not unique" };
  if (/^Unknown tool\b/.test(text)) return { message: "Unknown tool" };
  const code = /\b(E[A-Z]{3,})\b/.exec(text.split("\n")[0]);
  if (code && /^Error\b/.test(text)) return { message: code[1] };

  return { message: GENERIC };
}
