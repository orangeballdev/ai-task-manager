import { test } from "node:test";
import assert from "node:assert/strict";
import { context, trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { ToolSpanTracker } from "../providers/tool-spans";

const exporter = new InMemorySpanExporter();
trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

test("tool_use → tool_result becomes one execute_tool span under the agent span", () => {
  exporter.reset();
  const agent = trace.getTracer("t").startSpan("invoke_agent Developer");
  const tracker = context.with(trace.setSpan(context.active(), agent), () => new ToolSpanTracker());
  tracker.start("toolu_1", "Bash");
  tracker.start("toolu_1", "Bash"); // duplicate event: ignored
  tracker.start("toolu_2", "mcp__github__create_issue");
  tracker.end("toolu_1");
  tracker.end("toolu_2", true, "Exit code 1\nboom");
  tracker.end("toolu_unknown");
  agent.end();

  const spans = exporter.getFinishedSpans().filter((s) => s.name.startsWith("execute_tool"));
  assert.deepEqual(spans.map((s) => s.name), ["execute_tool Bash", "execute_tool mcp__github__create_issue"]);
  const [bash, mcp] = spans;
  assert.equal(bash.parentSpanContext?.spanId, agent.spanContext().spanId);
  assert.equal(bash.attributes["gen_ai.operation.name"], "execute_tool");
  assert.equal(bash.attributes["gen_ai.tool.type"], "function");
  assert.equal(bash.attributes["gen_ai.tool.call.id"], "toolu_1");
  assert.equal(mcp.attributes["gen_ai.tool.type"], "extension");
  assert.equal(mcp.attributes["ctm.tool.mcp_server"], "github");
  assert.equal(mcp.attributes["error.type"], "tool_error");
  assert.equal(mcp.status.message, "Exit code 1");
  assert.equal(mcp.attributes["process.exit.code"], 1);
});

test("endAll closes calls the run never finished", () => {
  exporter.reset();
  const tracker = new ToolSpanTracker();
  tracker.start("toolu_9", "Edit");
  tracker.endAll();
  const [span] = exporter.getFinishedSpans();
  assert.equal(span.attributes["ctm.tool.unfinished"], true);
});

test("tool arguments are recorded, redacted, only when the setting is on", () => {
  const g = globalThis as unknown as { __ctmOtel?: { config: { toolArguments: boolean } } };
  const saved = g.__ctmOtel;
  try {
    for (const on of [false, true]) {
      exporter.reset();
      g.__ctmOtel = { config: { toolArguments: on } };
      const tracker = new ToolSpanTracker();
      tracker.start("toolu_a", "Bash", { command: "GH_TOKEN=abc123 gh pr list", description: "List PRs" });
      tracker.end("toolu_a");
      const [span] = exporter.getFinishedSpans();
      const args = span.attributes["gen_ai.tool.call.arguments"];
      if (!on) assert.equal(args, undefined);
      else assert.deepEqual(JSON.parse(String(args)), { command: "GH_TOKEN=*** gh pr list", description: "List PRs" });
    }
  } finally {
    g.__ctmOtel = saved;
  }
});
