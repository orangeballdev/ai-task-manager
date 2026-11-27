import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gatewayPausedMessage, gatewayPauseValue, gatewayRetryAfterSeconds, parseGatewayPause, serializeGatewayPause,
} from "../llm-gateway/pause";

const now = new Date("2026-11-19T10:00:00Z");

test("no value, junk or a past time means running", () => {
  assert.deepEqual(parseGatewayPause(null, now), { paused: false });
  assert.deepEqual(parseGatewayPause("", now), { paused: false });
  assert.deepEqual(parseGatewayPause("not a date", now), { paused: false });
  assert.deepEqual(parseGatewayPause("2026-11-19T09:59:59Z", now), { paused: false });
  assert.deepEqual(parseGatewayPause(now.toISOString(), now), { paused: false });
});

test("a future time or indefinite means paused", () => {
  assert.deepEqual(parseGatewayPause("2026-11-19T11:00:00.000Z", now), { paused: true, until: new Date("2026-11-19T11:00:00Z") });
  assert.deepEqual(parseGatewayPause("indefinite", now), { paused: true, until: null });
});

test("durations map to setting values", () => {
  assert.equal(gatewayPauseValue("1h", now), "2026-11-19T11:00:00.000Z");
  assert.equal(gatewayPauseValue("15m", now), "2026-11-19T10:15:00.000Z");
  assert.equal(gatewayPauseValue("7d", now), "2026-11-26T10:00:00.000Z");
  assert.equal(gatewayPauseValue("indefinite", now), "indefinite");
  assert.equal(gatewayPauseValue("2h", now), null);
  assert.equal(gatewayPauseValue(undefined, now), null);
});

test("round trip: a paused value is paused until it expires", () => {
  const value = gatewayPauseValue("4h", now)!;
  assert.equal(parseGatewayPause(value, now).paused, true);
  assert.equal(parseGatewayPause(value, new Date(now.getTime() + 4 * 3_600_000)).paused, false);
});

test("retry-after and message", () => {
  const timed = parseGatewayPause("2026-11-19T10:01:30Z", now);
  assert.equal(gatewayRetryAfterSeconds(timed, now), 90);
  assert.match(gatewayPausedMessage(timed), /until 2026-11-19T10:01:30\.000Z/);
  const forever = parseGatewayPause("indefinite", now);
  assert.equal(gatewayRetryAfterSeconds(forever, now), null);
  assert.match(gatewayPausedMessage(forever), /temporarily disabled/);
  assert.equal(gatewayRetryAfterSeconds({ paused: false }, now), null);
  assert.deepEqual(serializeGatewayPause(forever), { paused: true, until: null });
  assert.deepEqual(serializeGatewayPause({ paused: false }), { paused: false, until: null });
});
