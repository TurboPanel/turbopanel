import { assertEquals } from "jsr:@std/assert";
import { it } from "@std/testing/bdd";
import {
  evaluateSocketHealth,
  HALF_OPEN_CLOSE_MS,
  MAX_WS_CONNECTION_AGE_MS,
} from "./socket-health.ts";

const NOW = 1_000_000_000_000;

it("evaluateSocketHealth keeps a fresh, recently-pinged socket", () => {
  const decision = evaluateSocketHealth({
    nowMs: NOW,
    connectedAtMs: NOW - 30_000,
    lastPingAtMs: NOW - 5_000,
  });
  assertEquals(decision, { reap: false, reason: null });
});

it("evaluateSocketHealth reaps a half-open socket (stale auto-response)", () => {
  const decision = evaluateSocketHealth({
    nowMs: NOW,
    connectedAtMs: NOW - 5 * 60_000,
    lastPingAtMs: NOW - (HALF_OPEN_CLOSE_MS + 1),
  });
  assertEquals(decision, { reap: true, reason: "half_open" });
});

it("evaluateSocketHealth reaps a socket past the max age cap", () => {
  const decision = evaluateSocketHealth({
    nowMs: NOW,
    connectedAtMs: NOW - (MAX_WS_CONNECTION_AGE_MS + 1),
    lastPingAtMs: NOW - 1_000, // healthy pings — age cap still wins
  });
  assertEquals(decision, { reap: true, reason: "max_age" });
});

it("evaluateSocketHealth never half-open-reaps a socket that has not pinged yet", () => {
  const decision = evaluateSocketHealth({
    nowMs: NOW,
    connectedAtMs: NOW - 10_000,
    lastPingAtMs: null,
  });
  assertEquals(decision, { reap: false, reason: null });
});

it("evaluateSocketHealth tolerates an unknown connect time (older build)", () => {
  const healthy = evaluateSocketHealth({
    nowMs: NOW,
    connectedAtMs: null,
    lastPingAtMs: NOW - 1_000,
  });
  assertEquals(healthy, { reap: false, reason: null });

  const stale = evaluateSocketHealth({
    nowMs: NOW,
    connectedAtMs: null,
    lastPingAtMs: NOW - (HALF_OPEN_CLOSE_MS + 1),
  });
  assertEquals(stale, { reap: true, reason: "half_open" });
});

it("evaluateSocketHealth half-open threshold stays above the 60s ping cadence", () => {
  // Guards against a regression that would reap healthy sockets between pings.
  assertEquals(HALF_OPEN_CLOSE_MS > 60_000, true);
});
