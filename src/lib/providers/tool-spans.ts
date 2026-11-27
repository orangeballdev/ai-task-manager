/**
 * `execute_tool <tool>` spans (gen_ai semantic conventions) for tools an agent CLI runs in its
 * own process, rebuilt from its event stream: a span opens at the `tool_use` event and closes
 * at the matching `tool_result`, so its duration is how long the tool took to run.
 *
 * Spans are parented to the context active when the tracker was created — the agent's
 * `invoke_agent` span — since stream callbacks can't be relied on to carry it. Uses the
 * API's global (delegating) tracer, so providers need no SDK import.
 */
import { SpanStatusCode, context, trace, type Context, type Span } from "@opentelemetry/api";
import { describeToolError } from "../tool-error";
import { toolCallArguments } from "../tool-arguments";
import { currentOtelConfig } from "../otel-config";

const MCP_TOOL = /^mcp__(.+?)__(.+)$/;

export class ToolSpanTracker {
  private readonly open = new Map<string, Span>();
  private readonly parent: Context = context.active();

  /**
   * A tool call started (`tool_use` block). `input` is recorded only when "Record tool call
   * arguments" is on, and then only as the redacted summary from `toolCallArguments()`.
   */
  start(callId: string | undefined, toolName: string, input?: unknown): void {
    if (!callId || this.open.has(callId)) return;
    try {
      const mcp = MCP_TOOL.exec(toolName);
      const args = currentOtelConfig()?.toolArguments ? toolCallArguments(toolName, input) : null;
      const span = trace.getTracer("claude-task-manager").startSpan(`execute_tool ${toolName}`, {
        attributes: {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": toolName,
          "gen_ai.tool.call.id": callId,
          // MCP server tools are extensions; the CLI's built-ins (Bash, Edit, …) are functions.
          "gen_ai.tool.type": mcp ? "extension" : "function",
          ...(mcp ? { "ctm.tool.mcp_server": mcp[1] } : {}),
          ...(args ? { "gen_ai.tool.call.arguments": args } : {}),
        },
      }, this.parent);
      this.open.set(callId, span);
    } catch {
      /* telemetry must never affect the run */
    }
  }

  /**
   * The tool call's result arrived (`tool_result` block). `content` is only used to derive a
   * content-free status message (see `describeToolError`); it is never recorded.
   */
  end(callId: string | undefined, isError?: boolean, content?: unknown): void {
    const span = callId ? this.open.get(callId) : undefined;
    if (!span) return;
    this.open.delete(callId!);
    try {
      if (isError) {
        const { message, exitCode } = describeToolError(content);
        span.setStatus({ code: SpanStatusCode.ERROR, message });
        span.setAttribute("error.type", "tool_error");
        if (exitCode !== undefined) span.setAttribute("process.exit.code", exitCode);
      }
    } catch {
      /* telemetry must never affect the run */
    }
    span.end();
  }

  /** Closes calls still open when the run ended (killed, timed out, budget hit). */
  endAll(): void {
    for (const span of this.open.values()) {
      span.setAttribute("ctm.tool.unfinished", true);
      span.end();
    }
    this.open.clear();
  }
}
