import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentDestination,
  agentTelemetryEnv,
  exportTargets,
  isOtelActive,
  maskDestinations,
  mergeDestinationSecrets,
  parseStoredDestinations,
  otelConfigFingerprint,
  parseKeyValueList,
  parseOtelSettings,
  serviceNameFor,
  shouldRecordSpan,
  signalUrl,
} from "../otel-config";

test("parseOtelSettings defaults to off with sensible values", () => {
  const c = parseOtelSettings({});
  assert.equal(c.enabled, false);
  assert.equal(c.destinations.length, 1);
  assert.equal(c.destinations[0].protocol, "http/protobuf");
  assert.equal(c.destinations[0].endpoint, "http://localhost:4318");
  assert.equal(c.serviceName, "claude-task-manager");
  assert.equal(c.traces && c.metrics && c.logs && c.captureConsole, true);
  assert.equal(c.forwardToAgent, false);
  assert.equal(c.metricIntervalMs, 60_000);
  assert.equal(isOtelActive(c), false);
});

test("parseOtelSettings picks the gRPC default port and rejects unknown protocols", () => {
  assert.equal(parseOtelSettings({ otel_protocol: "grpc" }).destinations[0].endpoint, "http://localhost:4317");
  assert.equal(parseOtelSettings({ otel_protocol: "carrier-pigeon" }).destinations[0].protocol, "http/protobuf");
});

test("parseOtelSettings clamps the metric interval and ignores garbage", () => {
  assert.equal(parseOtelSettings({ otel_metric_interval_seconds: "1" }).metricIntervalMs, 5_000);
  assert.equal(parseOtelSettings({ otel_metric_interval_seconds: "30" }).metricIntervalMs, 30_000);
  assert.equal(parseOtelSettings({ otel_metric_interval_seconds: "abc" }).metricIntervalMs, 60_000);
});

test("isOtelActive needs the master switch and at least one signal", () => {
  assert.equal(isOtelActive(parseOtelSettings({ otel_enabled: "true" })), true);
  assert.equal(isOtelActive(parseOtelSettings({
    otel_enabled: "true", otel_traces_enabled: "false", otel_metrics_enabled: "false", otel_logs_enabled: "false",
  })), false);
});

test("parseKeyValueList accepts commas or newlines, decodes values, skips junk", () => {
  assert.deepEqual(parseKeyValueList("a=1, b=two\nAuthorization=Bearer%20xyz\nnovalue\n=nokey"), {
    a: "1", b: "two", Authorization: "Bearer xyz",
  });
  assert.deepEqual(parseKeyValueList("x=a=b"), { x: "a=b" });
  assert.deepEqual(parseKeyValueList(""), {});
});

test("parseKeyValueList accepts header lines pasted from collector YAML", () => {
  assert.deepEqual(parseKeyValueList('Authorization: "Bearer lsk_ingest_427"'), { Authorization: "Bearer lsk_ingest_427" });
  assert.deepEqual(parseKeyValueList("x-team: 'abc'\nx-other: plain"), { "x-team": "abc", "x-other": "plain" });
  assert.deepEqual(parseKeyValueList('Authorization="Bearer xyz"'), { Authorization: "Bearer xyz" });
  // A key=value whose value contains a colon stays in the = form.
  assert.deepEqual(parseKeyValueList("url=http://x:1"), { url: "http://x:1" });
  assert.deepEqual(parseKeyValueList("Authorization=Basic abc=="), { Authorization: "Basic abc==" });
});

test("signalUrl appends /v1/<signal> for HTTP and leaves gRPC alone", () => {
  assert.equal(signalUrl({ endpoint: "http://c:4318", protocol: "http/protobuf" }, "traces"), "http://c:4318/v1/traces");
  assert.equal(signalUrl({ endpoint: "http://c:4318/", protocol: "http/json" }, "logs"), "http://c:4318/v1/logs");
  assert.equal(signalUrl({ endpoint: "https://x/otlp", protocol: "http/protobuf" }, "metrics"), "https://x/otlp/v1/metrics");
  // A pasted full signal URL is re-pointed at each signal rather than doubled up.
  assert.equal(signalUrl({ endpoint: "http://c:4318/v1/traces", protocol: "http/protobuf" }, "metrics"), "http://c:4318/v1/metrics");
  assert.equal(signalUrl({ endpoint: "http://c:4317", protocol: "grpc" }, "traces"), "http://c:4317");
});

test("serviceNameFor suffixes the process role", () => {
  assert.equal(serviceNameFor({ serviceName: "ctm" }, "worker"), "ctm-worker");
});

test("fingerprint is 'off' when inactive and ignores header order and the agent flag", () => {
  assert.equal(otelConfigFingerprint(parseOtelSettings({ otel_endpoint: "http://a" })), "off");
  const a = parseOtelSettings({ otel_enabled: "true", otel_headers: "a=1,b=2" });
  const b = parseOtelSettings({ otel_enabled: "true", otel_headers: "b=2\na=1", otel_forward_to_agent: "true" });
  assert.equal(otelConfigFingerprint(a), otelConfigFingerprint(b));
  const c = parseOtelSettings({ otel_enabled: "true", otel_headers: "a=1,b=3" });
  assert.notEqual(otelConfigFingerprint(a), otelConfigFingerprint(c));
});

test("agentTelemetryEnv is empty unless export and forwarding are both on", () => {
  assert.deepEqual(agentTelemetryEnv(parseOtelSettings({ otel_forward_to_agent: "true" })), {});
  assert.deepEqual(agentTelemetryEnv(parseOtelSettings({ otel_enabled: "true" })), {});
});

test("agentTelemetryEnv forwards collector settings and tags the task", () => {
  const env = agentTelemetryEnv(parseOtelSettings({
    otel_enabled: "true",
    otel_forward_to_agent: "true",
    otel_endpoint: "https://collector:4318/v1/traces",
    otel_headers: "Authorization=Bearer abc",
    otel_resource_attributes: "env=prod",
    otel_logs_enabled: "false",
  }), { "ctm.task.id": "t1" });
  assert.equal(env.CLAUDE_CODE_ENABLE_TELEMETRY, "1");
  assert.equal(env.OTEL_METRICS_EXPORTER, "otlp");
  assert.equal(env.OTEL_LOGS_EXPORTER, "none");
  assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, "https://collector:4318");
  assert.equal(env.OTEL_EXPORTER_OTLP_PROTOCOL, "http/protobuf");
  assert.equal(env.OTEL_EXPORTER_OTLP_HEADERS, "Authorization=Bearer%20abc");
  assert.deepEqual(parseKeyValueList(env.OTEL_RESOURCE_ATTRIBUTES), { env: "prod", "ctm.task.id": "t1" });
});

test("database spans default off", () => {
  assert.equal(parseOtelSettings({}).dbSpans, false);
  assert.equal(parseOtelSettings({ otel_db_spans: "true" }).dbSpans, true);
  assert.equal(parseOtelSettings({}).toolArguments, false);
  assert.equal(parseOtelSettings({ otel_tool_arguments: "true" }).toolArguments, true);
});

test("shouldRecordSpan drops root-level Prisma spans and follows the parent otherwise", () => {
  assert.equal(shouldRecordSpan("prisma:client:operation", undefined), false);
  assert.equal(shouldRecordSpan("prisma:client:operation", { sampled: true }), true);
  assert.equal(shouldRecordSpan("prisma:client:db_query", { sampled: false }), false);
  assert.equal(shouldRecordSpan("task.run", undefined), true);
  assert.equal(shouldRecordSpan("GET /tasks", { sampled: false }), false);
});

// ---------------------------------------------------------------------------
// Multiple destinations
// ---------------------------------------------------------------------------

const dests = (...list: Record<string, unknown>[]) => JSON.stringify(list);

test("legacy single-collector settings become one destination until the list is saved", () => {
  const legacy = parseOtelSettings({
    otel_enabled: "true",
    otel_endpoint: "https://old:4318",
    otel_protocol: "http/json",
    otel_headers: "Authorization=Bearer abc",
  });
  assert.equal(legacy.destinations.length, 1);
  assert.deepEqual(
    { endpoint: legacy.destinations[0].endpoint, protocol: legacy.destinations[0].protocol, headers: legacy.destinations[0].headers },
    { endpoint: "https://old:4318", protocol: "http/json", headers: { Authorization: "Bearer abc" } },
  );
  // Once saved, the list wins — even an empty one — and the old keys are ignored.
  const saved = parseOtelSettings({ otel_enabled: "true", otel_endpoint: "https://old:4318", otel_destinations: "[]" });
  assert.equal(saved.destinations.length, 0);
  assert.equal(isOtelActive(saved), false);
});

test("parseStoredDestinations drops junk and duplicate ids and fills defaults", () => {
  const list = parseStoredDestinations(dests(
    { id: "a", endpoint: " http://a:4318 ", protocol: "grpc" },
    { id: "a", endpoint: "http://dupe" },
    { endpoint: "no-id" },
    { id: "b", enabled: false, logs: false, protocol: "nope" },
  ));
  assert.deepEqual(list.map((d) => d.id), ["a", "b"]);
  assert.equal(list[0].endpoint, "http://a:4318");
  assert.equal(list[0].protocol, "grpc");
  assert.equal(list[0].enabled && list[0].traces && list[0].metrics && list[0].logs, true);
  assert.equal(list[1].protocol, "http/protobuf");
  assert.equal(list[1].enabled, false);
  assert.equal(list[1].logs, false);
  assert.deepEqual(parseStoredDestinations("not json"), []);
  assert.deepEqual(parseStoredDestinations("{}"), []);
});

test("exportTargets needs the master switch, the global signal, and the destination's own toggles", () => {
  const config = parseOtelSettings({
    otel_enabled: "true",
    otel_logs_enabled: "false",
    otel_destinations: dests(
      { id: "a", endpoint: "http://a" },
      { id: "b", endpoint: "http://b", metrics: false },
      { id: "c", endpoint: "http://c", enabled: false },
    ),
  });
  assert.deepEqual(exportTargets(config, "traces").map((d) => d.id), ["a", "b"]);
  assert.deepEqual(exportTargets(config, "metrics").map((d) => d.id), ["a"]);
  assert.deepEqual(exportTargets(config, "logs"), []);
  assert.deepEqual(exportTargets({ ...config, enabled: false }, "traces"), []);
});

test("isOtelActive is false when every destination is off", () => {
  assert.equal(isOtelActive(parseOtelSettings({
    otel_enabled: "true",
    otel_destinations: dests({ id: "a", enabled: false }, { id: "b", traces: false, metrics: false, logs: false }),
  })), false);
});

test("fingerprint changes with any enabled destination but not with disabled ones", () => {
  const base = { otel_enabled: "true" };
  const one = otelConfigFingerprint(parseOtelSettings({ ...base, otel_destinations: dests({ id: "a", endpoint: "http://a" }) }));
  const two = otelConfigFingerprint(parseOtelSettings({ ...base, otel_destinations: dests({ id: "a", endpoint: "http://a" }, { id: "b", endpoint: "http://b" }) }));
  const twoOff = otelConfigFingerprint(parseOtelSettings({ ...base, otel_destinations: dests({ id: "a", endpoint: "http://a" }, { id: "b", endpoint: "http://b", enabled: false }) }));
  assert.notEqual(one, two);
  assert.equal(one, twoOff);
  // Picking a different destination for the CLI needs no exporter restart.
  const agent = otelConfigFingerprint(parseOtelSettings({ ...base, otel_agent_destination: "a", otel_destinations: dests({ id: "a", endpoint: "http://a" }) }));
  assert.equal(one, agent);
});

test("masking and merging round-trips headers without ever sending them", () => {
  const saved = parseStoredDestinations(dests({ id: "a", headers: "k=secret" }, { id: "b", headers: "" }));
  const masked = maskDestinations(saved);
  assert.deepEqual(masked.map((d) => d.headers), ["***", ""]);
  const back = mergeDestinationSecrets([...masked, { ...masked[0], id: "new", headers: "***" }], saved);
  assert.deepEqual(back.map((d) => d.headers), ["k=secret", "", ""]);
  // An explicit new value replaces the saved one.
  assert.equal(mergeDestinationSecrets([{ ...masked[0], headers: "k=rotated" }], saved)[0].headers, "k=rotated");
});

test("agentDestination uses the chosen destination and falls back to the first usable one", () => {
  const list = dests(
    { id: "a", endpoint: "http://a", metrics: false, logs: false },
    { id: "b", endpoint: "http://b" },
    { id: "c", endpoint: "http://c" },
  );
  const pick = (extra: Record<string, string>) =>
    agentDestination(parseOtelSettings({ otel_enabled: "true", otel_destinations: list, ...extra }))?.id;
  assert.equal(pick({ otel_agent_destination: "c" }), "c");
  assert.equal(pick({}), "b"); // "a" takes neither metrics nor logs
  assert.equal(pick({ otel_agent_destination: "a" }), "b");
  assert.equal(pick({ otel_agent_destination: "gone" }), "b");
});

test("agentTelemetryEnv forwards the chosen destination only", () => {
  const env = agentTelemetryEnv(parseOtelSettings({
    otel_enabled: "true",
    otel_forward_to_agent: "true",
    otel_agent_destination: "b",
    otel_destinations: dests(
      { id: "a", endpoint: "http://a:4318", headers: "k=a" },
      { id: "b", endpoint: "http://b:4317", protocol: "grpc", headers: "k=b", logs: false },
    ),
  }));
  assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, "http://b:4317");
  assert.equal(env.OTEL_EXPORTER_OTLP_PROTOCOL, "grpc");
  assert.equal(env.OTEL_EXPORTER_OTLP_HEADERS, "k=b");
  assert.equal(env.OTEL_METRICS_EXPORTER, "otlp");
  assert.equal(env.OTEL_LOGS_EXPORTER, "none");
});
