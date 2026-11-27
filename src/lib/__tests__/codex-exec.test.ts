/**
 * Unit tests for the shared Codex CLI plumbing (`src/lib/providers/codex-exec.ts`).
 *
 * Only the pure parts are covered — event parsing, auth inspection, argument building and
 * the failure-phrase detectors. Anything that spawns a process is left to manual testing,
 * since it needs a real `codex` install and a real login.
 *
 * Run with:
 *   npm test
 *   # or directly:
 *   npx tsx --test src/lib/__tests__/codex-exec.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CODEX_MAX_ATTEMPTS,
  CodexSignalTracker,
  classifyCodexFailure,
  classifyCodexStderr,
  codexAuthLooksValid,
  codexExecArgs,
  codexReasoningEffort,
  codexResumeNotice,
  codexRetryDelayMs,
  createLineBuffer,
  decideCodexOutcome,
  detectCodexAuthError,
  detectCodexUsageLimit,
  extractCodexExpiresAt,
  isCodexNoiseLine,
  parseCodexEvent,
  stripCodexLogPrefix,
} from "../providers/codex-exec.js";

/** Build a JWT with the given `exp` claim (seconds). Signature is irrelevant — we never verify. */
function jwt(expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds }), "utf8").toString("base64url");
  return `header.${payload}.signature`;
}

describe("parseCodexEvent", () => {
  it("surfaces a completed agent message and flags it as the model's own output", () => {
    const event = parseCodexEvent(
      JSON.stringify({ type: "item.completed", item: { item_type: "agent_message", text: "All done." } }),
    );
    assert.equal(event?.text, "All done.");
    assert.equal(event?.isAgentMessage, true);
    assert.equal(event?.level, "info");
    assert.equal(event?.failed, false);
  });

  it("accepts the newer `item.type` spelling as well as `item_type`", () => {
    const event = parseCodexEvent(
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Hi" } }),
    );
    assert.equal(event?.isAgentMessage, true);
  });

  it("drops started/updated events so streaming items aren't logged three times", () => {
    for (const type of ["item.started", "item.updated"]) {
      const event = parseCodexEvent(JSON.stringify({ type, item: { item_type: "agent_message", text: "partial" } }));
      assert.equal(event, null, `${type} should not be logged`);
    }
  });

  it("renders a command execution as a shell line at system level", () => {
    const event = parseCodexEvent(
      JSON.stringify({ type: "item.completed", item: { item_type: "command_execution", command: "npm test" } }),
    );
    assert.equal(event?.text, "$ npm test");
    assert.equal(event?.level, "system");
    assert.equal(event?.isAgentMessage, false);
  });

  it("reports token usage from turn.completed without emitting log text", () => {
    const event = parseCodexEvent(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 7 },
      }),
    );
    // Cached input still cost the plan window, so it counts toward the task's input tokens.
    // The cached part is also reported on its own, for telemetry's cache hit rate.
    assert.deepEqual(event?.usage, { inputTokens: 120, outputTokens: 7, cachedInputTokens: 20 });
    assert.equal(event?.text, undefined);
  });

  it("marks genuinely fatal errors as failures and keeps the message", () => {
    const event = parseCodexEvent(JSON.stringify({ type: "error", message: "model refused the request" }));
    assert.equal(event?.failed, true);
    assert.equal(event?.level, "error");
    assert.equal(event?.failureKind, "fatal");
    assert.equal(event?.text, "model refused the request");
  });

  it("does not fail the run on a dropped stream — Codex reconnects, and we re-spawn", () => {
    const event = parseCodexEvent(JSON.stringify({ type: "error", message: "stream disconnected before completion" }));
    assert.equal(event?.failed, false);
    assert.equal(event?.failureKind, "transient");
    assert.equal(event?.level, "system");
    assert.equal(event?.text, "stream disconnected before completion");
  });

  it("does not fail the run on an apply_patch error — the model is handed it and retries", () => {
    const event = parseCodexEvent(
      JSON.stringify({
        type: "error",
        message: "apply_patch verification failed: Failed to find expected lines in /w/a.md",
      }),
    );
    assert.equal(event?.failed, false);
    assert.equal(event?.failureKind, "recoverable");
  });

  it("flags turn.completed so a recovered reconnect can be told from an exhausted one", () => {
    const event = parseCodexEvent(JSON.stringify({ type: "turn.completed", usage: {} }));
    assert.equal(event?.turnCompleted, true);
    assert.equal(parseCodexEvent(JSON.stringify({ type: "error", message: "boom" }))?.turnCompleted, undefined);
  });

  it("logs reconnect progress at system level rather than as an error", () => {
    const event = parseCodexEvent("Reconnecting... 2/5 (stream disconnected before completion: WebSocket error)");
    assert.equal(event?.level, "system");
    assert.equal(event?.failed, false);
    assert.equal(event?.failureKind, "transient");
  });

  it("passes non-JSON lines through so plain-text warnings still reach the log", () => {
    const event = parseCodexEvent("warning: model fell back to gpt-5.5");
    assert.equal(event?.text, "warning: model fell back to gpt-5.5");
    assert.equal(event?.isAgentMessage, false);
  });

  it("ignores blank lines", () => {
    assert.equal(parseCodexEvent("   "), null);
  });
});

describe("codexAuthLooksValid", () => {
  it("accepts a ChatGPT login", () => {
    assert.equal(codexAuthLooksValid(JSON.stringify({ tokens: { access_token: "a", refresh_token: "r" } })), true);
  });

  it("accepts an API-key login", () => {
    assert.equal(codexAuthLooksValid(JSON.stringify({ OPENAI_API_KEY: "sk-test" })), true);
  });

  it("rejects empty, malformed and contentless auth blobs", () => {
    assert.equal(codexAuthLooksValid(null), false);
    assert.equal(codexAuthLooksValid("   "), false);
    assert.equal(codexAuthLooksValid("not json"), false);
    assert.equal(codexAuthLooksValid(JSON.stringify({ tokens: {}, OPENAI_API_KEY: "" })), false);
  });
});

describe("extractCodexExpiresAt", () => {
  it("reads the exp claim off the access token, in milliseconds", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    assert.equal(extractCodexExpiresAt(JSON.stringify({ tokens: { access_token: jwt(exp) } })), exp * 1000);
  });

  it("falls back to the id token when there is no access token", () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    assert.equal(extractCodexExpiresAt(JSON.stringify({ tokens: { id_token: jwt(exp) } })), exp * 1000);
  });

  it("returns 0 (unknown, not expired) for API-key logins and junk", () => {
    assert.equal(extractCodexExpiresAt(JSON.stringify({ OPENAI_API_KEY: "sk-test" })), 0);
    assert.equal(extractCodexExpiresAt("not json"), 0);
    assert.equal(extractCodexExpiresAt(JSON.stringify({ tokens: { access_token: "nonsense" } })), 0);
    assert.equal(extractCodexExpiresAt(null), 0);
  });
});

describe("detectCodexUsageLimit / detectCodexAuthError", () => {
  it("recognises Codex's plan-exhausted phrasings", () => {
    assert.ok(detectCodexUsageLimit("You've hit your usage limit for this plan"));
    assert.ok(detectCodexUsageLimit("Error: 429 Too Many Requests"));
    assert.ok(detectCodexUsageLimit("quota exceeded, try again later"));
  });

  it("does not flag ordinary output as a usage limit", () => {
    assert.equal(detectCodexUsageLimit("Refactored the parser and ran the tests."), null);
  });

  it("recognises expired / missing logins", () => {
    assert.ok(detectCodexAuthError("Not logged in. Please run `codex login`."));
    assert.ok(detectCodexAuthError("401 Unauthorized"));
    assert.equal(detectCodexAuthError("Everything went fine"), false);
  });
});

describe("codexExecArgs", () => {
  it("runs read-only by default and never without --skip-git-repo-check", () => {
    const args = codexExecArgs({});
    assert.deepEqual(args, ["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only"]);
  });

  it("grants full access only when asked, and passes cwd/model/effort through", () => {
    const args = codexExecArgs({ cd: "/workspaces/t1", model: "gpt-5.6-sol", effort: "high", fullAccess: true });
    assert.ok(args.includes("--dangerously-bypass-approvals-and-sandbox"));
    assert.ok(!args.includes("read-only"));
    assert.deepEqual(args.slice(args.indexOf("--cd"), args.indexOf("--cd") + 2), ["--cd", "/workspaces/t1"]);
    assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "gpt-5.6-sol"]);
    assert.ok(args.includes('model_reasoning_effort="high"'));
  });
});

describe("codexReasoningEffort", () => {
  it("passes through the levels Codex knows", () => {
    assert.equal(codexReasoningEffort("low"), "low");
    assert.equal(codexReasoningEffort("medium"), "medium");
    assert.equal(codexReasoningEffort("high"), "high");
  });

  it("clamps our extra rungs to high instead of sending a value Codex rejects", () => {
    assert.equal(codexReasoningEffort("xhigh"), "high");
    assert.equal(codexReasoningEffort("max"), "high");
  });

  it("returns null for unset/unknown effort so no override is added at all", () => {
    assert.equal(codexReasoningEffort(undefined), null);
    assert.equal(codexReasoningEffort(""), null);
    assert.equal(codexReasoningEffort("turbo"), null);
  });
});

describe("classifyCodexFailure", () => {
  it("treats patch problems as recoverable — Codex hands them back to the model", () => {
    for (const text of [
      "apply_patch verification failed: Failed to find expected lines in /w/spec.md",
      "invalid patch: multiple operations target /w/packages/db/src/access/dashboards.ts",
      "patch application failed",
    ]) {
      assert.equal(classifyCodexFailure(text), "recoverable", text);
    }
  });

  it("treats transport and sub-process wobbles as transient", () => {
    for (const text of [
      "stream disconnected before completion: WebSocket protocol error: Connection reset without closing handshake",
      "failed to lookup address information: Try again",
      "idle timeout sending websocket request",
      "failed to refresh available models: timeout waiting for child process to exit",
      "connect ECONNRESET",
      "502 Bad Gateway",
    ]) {
      assert.equal(classifyCodexFailure(text), "transient", text);
    }
  });

  it("leaves everything else fatal, including nothing at all", () => {
    assert.equal(classifyCodexFailure("model refused: unsupported request"), "fatal");
    assert.equal(classifyCodexFailure(""), "fatal");
    assert.equal(classifyCodexFailure(null), "fatal");
  });
});

describe("classifyCodexStderr / isCodexNoiseLine / stripCodexLogPrefix", () => {
  const traceLine =
    "2026-08-31T09:03:29.559511Z ERROR codex_core::tools::router: error=apply_patch verification failed: nope";

  it("strips the tracing prefix so classification sees the real message", () => {
    assert.equal(stripCodexLogPrefix(traceLine), "apply_patch verification failed: nope");
    assert.equal(stripCodexLogPrefix("plain message"), "plain message");
  });

  it("recognises Codex's own diagnostics as noise, not as the run failing", () => {
    assert.equal(isCodexNoiseLine(traceLine), true);
    assert.equal(isCodexNoiseLine("Reconnecting... 2/5 (stream disconnected before completion)"), true);
    assert.equal(isCodexNoiseLine("Reading additional input from stdin..."), true);
    assert.equal(isCodexNoiseLine("Something the model actually said"), false);
  });

  it("keeps ERROR-level tracing out of the task log's error level", () => {
    const lines = classifyCodexStderr(`${traceLine}\n\nReconnecting... 3/5 (idle timeout)\n`);
    assert.equal(lines.length, 2);
    assert.deepEqual(
      lines.map((l) => l.level),
      ["system", "system"],
    );
    assert.equal(lines[0].failureKind, "recoverable");
    assert.equal(lines[1].failureKind, "transient");
  });

  it("still surfaces a real error at error level", () => {
    const [line] = classifyCodexStderr("error: unknown flag --nope\n");
    assert.equal(line.level, "error");
    assert.equal(line.failureKind, "fatal");
  });

  it("keeps an unexplained ERROR trace visible but not an INFO one", () => {
    const [err] = classifyCodexStderr("2026-08-31T00:32:01Z ERROR codex_core::codex: the model refused\n");
    assert.equal(err.level, "error");
    const [info] = classifyCodexStderr("2026-08-31T00:32:01Z INFO codex_core::codex: turn started\n");
    assert.equal(info.level, "system");
  });

  it("does not read a DNS 'Try again' as a plan reset", () => {
    // `detectCodexUsageLimit` looks for "try again in/later/after"; the resolver's bare
    // "Try again" must not throttle the provider for an hour.
    assert.equal(detectCodexUsageLimit("failed to lookup address information: Try again"), null);
  });
});

describe("decideCodexOutcome", () => {
  const base = {
    exitCode: 0,
    sawCompletionMarker: false,
    sawTurnCompleted: true,
    fatalErrors: [] as string[],
    lastTransient: null as string | null,
    limitMessage: null as string | null,
  };

  it("succeeds on a clean exit", () => {
    assert.deepEqual(decideCodexOutcome(base), { success: true, shouldRetry: false, transient: false });
  });

  it("succeeds when the run recovered from a mid-run reconnect", () => {
    // Codex prints "Reconnecting… 2/5" for blips it survives, and the turn still completed.
    const outcome = decideCodexOutcome({ ...base, lastTransient: "stream disconnected before completion" });
    assert.equal(outcome.success, true);
  });

  it("succeeds when apply_patch errors were the only trouble", () => {
    // Recoverable errors never reach `fatalErrors`, so this is exit 0 with a completed turn.
    assert.equal(decideCodexOutcome({ ...base, exitCode: 0 }).success, true);
  });

  it("reports the transport failure, not 'exited with code 0', when reconnects ran out", () => {
    const outcome = decideCodexOutcome({
      ...base,
      exitCode: 0,
      sawTurnCompleted: false,
      lastTransient: "WebSocket protocol error: Connection reset without closing handshake",
    });
    assert.equal(outcome.success, false);
    assert.equal(outcome.transient, true);
    assert.equal(outcome.shouldRetry, false);
    assert.match(outcome.error!, /WebSocket protocol error/);
    assert.doesNotMatch(outcome.error!, /exited with code 0/);
  });

  it("still honours the completion marker after a broken stream", () => {
    const outcome = decideCodexOutcome({
      ...base,
      exitCode: 1,
      sawCompletionMarker: true,
      sawTurnCompleted: false,
      lastTransient: "connection reset",
    });
    assert.equal(outcome.success, true);
  });

  it("asks the worker to throttle only for a real usage limit", () => {
    const outcome = decideCodexOutcome({
      ...base,
      exitCode: 1,
      sawTurnCompleted: false,
      limitMessage: "You've hit your usage limit",
    });
    assert.equal(outcome.shouldRetry, true);
    assert.equal(outcome.transient, false);
  });

  it("flags a dead login so the worker can hand the task to another provider", () => {
    const outcome = decideCodexOutcome({
      ...base,
      exitCode: 1,
      sawTurnCompleted: false,
      fatalErrors: ["unexpected status 401 Unauthorized: token expired"],
    });
    assert.equal(outcome.success, false);
    assert.equal(outcome.authFailed, true);
    assert.equal(outcome.transient, false);
    assert.equal(outcome.shouldRetry, false);
  });

  it("keeps a genuinely fatal error fatal", () => {
    const outcome = decideCodexOutcome({
      ...base,
      exitCode: 1,
      sawTurnCompleted: false,
      fatalErrors: ["first problem", "unknown flag --nope"],
    });
    assert.equal(outcome.success, false);
    assert.equal(outcome.transient, false);
    assert.equal(outcome.error, "unknown flag --nope");
  });

  it("falls back to the exit code when nothing else explains the failure", () => {
    const outcome = decideCodexOutcome({ ...base, exitCode: 3, sawTurnCompleted: false });
    assert.equal(outcome.error, "Codex CLI exited with code 3");
    assert.equal(outcome.transient, false);
  });
});

describe("createLineBuffer", () => {
  it("re-assembles a line split across chunks instead of classifying half of it", () => {
    const buffer = createLineBuffer();
    // This is exactly how Codex's stderr arrives: an ERROR line cut at an arbitrary byte.
    assert.deepEqual(buffer.push("2026-01-01T00:00:00Z ERROR codex_core::tools: error=apply_"), []);
    assert.deepEqual(buffer.push("patch verification failed: no match\n"), [
      "2026-01-01T00:00:00Z ERROR codex_core::tools: error=apply_patch verification failed: no match",
    ]);
    // Half a line reads as fatal; the whole one is the recoverable patch error it really is.
    assert.equal(classifyCodexFailure(stripCodexLogPrefix("error=apply_")), "fatal");
    assert.equal(
      classifyCodexStderr(
        "2026-01-01T00:00:00Z ERROR codex_core::tools: error=apply_patch verification failed: no match\n",
      )[0].level,
      "system",
    );
  });

  it("returns every complete line in a multi-line chunk and keeps the remainder", () => {
    const buffer = createLineBuffer();
    assert.deepEqual(buffer.push("a\nb\nc"), ["a", "b"]);
    assert.equal(buffer.flush(), "c");
    // flush() empties the buffer, and blank remainders are dropped.
    assert.equal(buffer.flush(), null);
  });

  it("keeps nothing back when the stream ends on a newline", () => {
    const buffer = createLineBuffer();
    assert.deepEqual(buffer.push("done\n"), ["done"]);
    assert.equal(buffer.flush(), null);
  });
});

describe("CodexSignalTracker", () => {
  const errorEvent = (message: string) => parseCodexEvent(JSON.stringify({ type: "error", message }))!;
  const agentMessage = (text: string) =>
    parseCodexEvent(JSON.stringify({ type: "item.completed", item: { item_type: "agent_message", text } }))!;
  const turnCompleted = () => parseCodexEvent(JSON.stringify({ type: "turn.completed" }))!;

  it("reports a clean run as success", () => {
    const tracker = new CodexSignalTracker();
    tracker.event(agentMessage("Refactored the parser."));
    tracker.event(turnCompleted());
    const signals = tracker.signals(0);
    assert.deepEqual(signals.fatalErrors, []);
    assert.equal(signals.lastTransient, null);
    assert.equal(signals.limitMessage, null);
    assert.equal(decideCodexOutcome(signals).success, true);
  });

  it("counts patch errors as recovered rather than failing the run", () => {
    const tracker = new CodexSignalTracker();
    tracker.event(errorEvent("apply_patch verification failed: file changed"));
    tracker.event(errorEvent("invalid patch: multiple operations target src/a.ts"));
    tracker.event(turnCompleted());
    assert.equal(tracker.recoveredCount, 2);
    assert.equal(decideCodexOutcome(tracker.signals(0)).success, true);
  });

  it("does not throttle the provider because the agent wrote about rate limits", () => {
    const tracker = new CodexSignalTracker();
    // The transcript is full of the words the limit detector looks for — and it is not a
    // limit. Only Codex's own diagnostics are searched.
    tracker.event(agentMessage("Added rate limiting to the API and a 429 response on line 429."));
    tracker.event(agentMessage("If it fails, try again later."));
    tracker.event(turnCompleted());
    const signals = tracker.signals(0);
    assert.equal(signals.limitMessage, null);
    assert.equal(decideCodexOutcome(signals).shouldRetry, false);
  });

  it("does not throttle because a command Codex ran printed the words", () => {
    const tracker = new CodexSignalTracker();
    tracker.event(
      parseCodexEvent(
        JSON.stringify({
          type: "item.completed",
          item: { item_type: "command_execution", command: "npm test", aggregated_output: "429 too many requests" },
        }),
      )!,
    );
    tracker.event(turnCompleted());
    assert.equal(tracker.signals(0).limitMessage, null);
  });

  it("still catches the plain-text usage limit Codex prints on stdout", () => {
    const tracker = new CodexSignalTracker();
    // Not a JSON event — Codex says this in plain English, and it is still a real limit.
    tracker.event(parseCodexEvent("You've hit your usage limit. Try again in 3 hours.")!);
    assert.equal(decideCodexOutcome(tracker.signals(1)).shouldRetry, true);
  });

  it("still catches a usage limit reported on stderr", () => {
    const tracker = new CodexSignalTracker();
    for (const line of classifyCodexStderr("error: 429 Too Many Requests\n")) tracker.stderrLine(line);
    assert.equal(decideCodexOutcome(tracker.signals(1)).shouldRetry, true);
  });

  it("still catches a real usage limit reported by Codex", () => {
    const tracker = new CodexSignalTracker();
    tracker.event(errorEvent("You've hit your usage limit. Try again in 3 hours."));
    const signals = tracker.signals(1);
    assert.match(signals.limitMessage!, /usage limit/i);
    assert.equal(decideCodexOutcome(signals).shouldRetry, true);
  });

  it("does not read a transient DNS 'Try again' as a plan reset", () => {
    const tracker = new CodexSignalTracker();
    tracker.event(errorEvent("failed to lookup address information: Try again"));
    const signals = tracker.signals(0);
    assert.equal(signals.limitMessage, null);
    assert.equal(signals.lastTransient, "failed to lookup address information: Try again");
  });

  it("treats a turn that completed after a wobble as a recovery", () => {
    const tracker = new CodexSignalTracker();
    tracker.event(errorEvent("stream disconnected before completion; retrying"));
    tracker.event(turnCompleted());
    const signals = tracker.signals(0);
    assert.equal(signals.sawTurnCompleted, true);
    assert.equal(decideCodexOutcome(signals).success, true);
  });

  it("does not let an earlier completed turn excuse a stream that died later", () => {
    const tracker = new CodexSignalTracker();
    tracker.event(turnCompleted());
    tracker.event(errorEvent("WebSocket protocol error: Connection reset without closing handshake"));
    const signals = tracker.signals(0);
    assert.equal(signals.sawTurnCompleted, false);
    const outcome = decideCodexOutcome(signals);
    assert.equal(outcome.success, false);
    assert.equal(outcome.transient, true, "a run cut off mid-task should be re-spawned, not called a success");
  });

  it("keeps stderr diagnostics out of fatalErrors but uses them for context", () => {
    const tracker = new CodexSignalTracker();
    for (const line of classifyCodexStderr(
      "2026-01-01T00:00:00Z ERROR codex_models_manager::manager: failed to refresh available models: timeout\n",
    )) {
      tracker.stderrLine(line);
    }
    const signals = tracker.signals(0);
    assert.deepEqual(signals.fatalErrors, []);
    assert.match(signals.lastTransient!, /failed to refresh available models/);
  });

  it("keeps a genuinely fatal stdout error fatal", () => {
    const tracker = new CodexSignalTracker();
    tracker.event(errorEvent("model refused: unsupported configuration"));
    const outcome = decideCodexOutcome(tracker.signals(1));
    assert.equal(outcome.success, false);
    assert.equal(outcome.transient, false);
    assert.match(outcome.error!, /unsupported configuration/);
  });

  it("honours the completion marker even after a bad exit", () => {
    const tracker = new CodexSignalTracker();
    tracker.markCompletionMarker();
    tracker.event(errorEvent("connection reset"));
    assert.equal(decideCodexOutcome(tracker.signals(1)).success, true);
  });

  it("does not grow without bound on a long, noisy run", () => {
    const tracker = new CodexSignalTracker();
    for (let i = 0; i < 5000; i++) tracker.event(errorEvent(`apply_patch verification failed: attempt ${i}`));
    assert.equal(tracker.recoveredCount, 5000);
    // The retained diagnostics are capped; the signals stay cheap to compute.
    assert.equal(tracker.signals(0).limitMessage, null);
  });
});

describe("detectCodexUsageLimit false positives", () => {
  it("ignores ordinary prose that merely mentions limits or a 429", () => {
    assert.equal(detectCodexUsageLimit("Added rate limiting middleware to the API."), null);
    assert.equal(detectCodexUsageLimit("The diff touches line 429 of server.ts."), null);
    assert.equal(detectCodexUsageLimit("If the build fails, try again later."), null);
    assert.equal(detectCodexUsageLimit("Wrote a test for the rate limiter."), null);
  });

  it("still recognises the real thing", () => {
    assert.ok(detectCodexUsageLimit("You've hit your usage limit for this plan"));
    assert.ok(detectCodexUsageLimit("stream error: 429 Too Many Requests"));
    assert.ok(detectCodexUsageLimit("error: status 429 returned by the API"));
    assert.ok(detectCodexUsageLimit("quota exceeded, try again later"));
    assert.ok(detectCodexUsageLimit("rate limit exceeded; resets at 14:00"));
    assert.ok(detectCodexUsageLimit("usage limit reached — try again in 4 hours"));
  });
});

describe("retry policy", () => {
  it("backs off increasingly but never past a minute", () => {
    assert.equal(codexRetryDelayMs(1), 5000);
    assert.equal(codexRetryDelayMs(2), 15000);
    assert.equal(codexRetryDelayMs(9), 60000);
    assert.equal(codexRetryDelayMs(0), 5000);
  });

  it("tells a re-spawned run to continue from the work already on disk", () => {
    const notice = codexResumeNotice(1, "WebSocket protocol error");
    assert.match(notice, /Automatic retry 1 of 3/);
    assert.match(notice, /WebSocket protocol error/);
    assert.match(notice, /still on disk/);
    assert.match(notice, /instead of starting over/);
    assert.equal(CODEX_MAX_ATTEMPTS, 3);
  });
});
