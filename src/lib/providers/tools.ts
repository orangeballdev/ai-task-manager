import { exec } from "child_process";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { recordCommandResult } from "../verification-state";
import { applyEnvOverlay, type AgentEnvOverlay } from "../agent-tools";
import { describeToolError } from "../tool-error";
import { toolCallArguments } from "../tool-arguments";
import { currentOtelConfig } from "../otel-config";

const execAsync = promisify(exec);

/**
 * Runs one agent tool call in an `execute_tool <tool>` span (gen_ai semantic conventions), a
 * child of the active span — the task's `invoke_agent`. Only the API providers run tools in
 * this process; the CLI agents' tools run inside the claude/codex process, out of reach.
 * Uses the API's global (delegating) tracer, so this module needs no SDK import.
 */
export async function executeTool(name: string, input: Record<string, string>, cwd: string, agentEnv?: AgentEnvOverlay): Promise<string> {
  // Redacted input summary, only with "Record tool call arguments" on (src/lib/tool-arguments.ts).
  const args = currentOtelConfig()?.toolArguments ? toolCallArguments(name, input) : null;
  return trace.getTracer("claude-task-manager").startActiveSpan(`execute_tool ${name}`, {
    attributes: {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": name,
      "gen_ai.tool.type": "function",
      ...(args ? { "gen_ai.tool.call.arguments": args } : {}),
    },
  }, async (span) => {
    try {
      const result = await runTool(name, input, cwd, agentEnv);
      // Tools report failure in their text result rather than by throwing.
      if (/^(Error|Unknown tool)\b/.test(result)) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: describeToolError(result).message });
        span.setAttribute("error.type", "tool_error");
      }
      return result;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      span.setAttribute("error.type", err instanceof Error && err.name !== "Error" ? err.name : "_OTHER");
      throw err;
    } finally {
      span.end();
    }
  });
}

async function runTool(name: string, input: Record<string, string>, cwd: string, agentEnv?: AgentEnvOverlay): Promise<string> {
  const resolvePath = (p: string) =>
    path.isAbsolute(p) ? p : path.resolve(cwd, p);

  switch (name) {
    case "bash": {
      try {
        const { stdout, stderr } = await execAsync(input.command, { cwd, timeout: 120000, env: applyEnvOverlay(process.env, agentEnv) });
        const out = (stdout + (stderr ? `\nSTDERR: ${stderr}` : "")).trim();
        // Remember build/lint/test outcomes so a resumed run doesn't redo them.
        recordCommandResult(cwd, input.command, true);
        return out || "(no output)";
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; message: string };
        recordCommandResult(cwd, input.command, false);
        const out = [e.message, e.stdout, e.stderr].filter(Boolean).join("\n");
        return `Error: ${out}`;
      }
    }
    case "read_file": {
      try {
        return fs.readFileSync(resolvePath(input.path), "utf-8");
      } catch (err: unknown) {
        return `Error reading file: ${(err as Error).message}`;
      }
    }
    case "write_file": {
      try {
        const filePath = resolvePath(input.path);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, input.content);
        return `Written: ${input.path}`;
      } catch (err: unknown) {
        return `Error writing file: ${(err as Error).message}`;
      }
    }
    case "str_replace": {
      try {
        const filePath = resolvePath(input.path);
        const content = fs.readFileSync(filePath, "utf-8");
        const count = content.split(input.old_str).length - 1;
        if (count === 0) return `Error: old_str not found in ${input.path}`;
        if (count > 1) return `Error: old_str found ${count} times in ${input.path} (must be unique)`;
        fs.writeFileSync(filePath, content.replace(input.old_str, input.new_str));
        return `Replaced in ${input.path}`;
      } catch (err: unknown) {
        return `Error in str_replace: ${(err as Error).message}`;
      }
    }
    default:
      return `Unknown tool: ${name}`;
  }
}
