import { assertEquals } from "jsr:@std/assert";
import type { DaemonCellLiveness } from "./contracts.ts";
import {
  isStale,
  OFFLINE_SWEEP_STALE_MS,
  resetOfflineSweepNullGraceForTests,
  updateNullGraceBookkeeping,
} from "./offline-sweep.ts";

const serverId = "srv-offline-sweep-null-grace";

function connectedWithNullPing(): DaemonCellLiveness {
  return { connected: true, lastPingAtMs: null };
}

function connectedWithWarmPing(nowMs: number): DaemonCellLiveness {
  return { connected: true, lastPingAtMs: nowMs - 30_000 };
}

Deno.test("offline sweep first null auto-response observation is not stale", () => {
  resetOfflineSweepNullGraceForTests();
  const nowMs = 1_700_000_000_000;
  const liveness = connectedWithNullPing();
  const connectedAt = new Date(nowMs - 30_000).toISOString();

  updateNullGraceBookkeeping(serverId, liveness, nowMs);

  assertEquals(isStale(serverId, liveness, nowMs, connectedAt), false);
});

Deno.test("offline sweep repeated null past grace is stale", () => {
  resetOfflineSweepNullGraceForTests();
  const firstTickMs = 1_700_000_000_000;
  const liveness = connectedWithNullPing();
  const connectedAt = new Date(firstTickMs - 30_000).toISOString();

  updateNullGraceBookkeeping(serverId, liveness, firstTickMs);

  const laterMs = firstTickMs + OFFLINE_SWEEP_STALE_MS + 1;
  updateNullGraceBookkeeping(serverId, liveness, laterMs);

  assertEquals(isStale(serverId, liveness, laterMs, connectedAt), true);
});

Deno.test("offline sweep warm live ping is not stale within grace", () => {
  resetOfflineSweepNullGraceForTests();
  const nowMs = 1_700_000_000_000;
  const liveness = connectedWithWarmPing(nowMs);

  updateNullGraceBookkeeping(serverId, liveness, nowMs);

  assertEquals(isStale(serverId, liveness, nowMs, null), false);
});

Deno.test("offline sweep warm live ping clears null grace bookkeeping", () => {
  resetOfflineSweepNullGraceForTests();
  const firstTickMs = 1_700_000_000_000;
  const nullLiveness = connectedWithNullPing();
  const connectedAt = new Date(firstTickMs - 30_000).toISOString();

  updateNullGraceBookkeeping(serverId, nullLiveness, firstTickMs);
  assertEquals(isStale(serverId, nullLiveness, firstTickMs, connectedAt), false);

  const warmMs = firstTickMs + OFFLINE_SWEEP_STALE_MS + 1;
  const warmLiveness = connectedWithWarmPing(warmMs);
  updateNullGraceBookkeeping(serverId, warmLiveness, warmMs);

  assertEquals(isStale(serverId, warmLiveness, warmMs, connectedAt), false);
});

Deno.test("offline sweep disconnected liveness is stale immediately", () => {
  resetOfflineSweepNullGraceForTests();
  const nowMs = 1_700_000_000_000;

  updateNullGraceBookkeeping(serverId, { connected: false, lastPingAtMs: null }, nowMs);

  assertEquals(isStale(serverId, { connected: false, lastPingAtMs: null }, nowMs, null), true);
});

Deno.test("offline sweep old connectedAt with null ping is not stale on first observation", () => {
  resetOfflineSweepNullGraceForTests();
  const nowMs = 1_700_000_000_000;
  const liveness = connectedWithNullPing();
  const oldConnectedAt = new Date(
    nowMs - OFFLINE_SWEEP_STALE_MS - 1,
  ).toISOString();

  assertEquals(isStale(serverId, liveness, nowMs, oldConnectedAt), false);
});

Deno.test("offline sweep old connectedAt becomes stale after null grace persists", () => {
  resetOfflineSweepNullGraceForTests();
  const firstTickMs = 1_700_000_000_000;
  const liveness = connectedWithNullPing();
  const oldConnectedAt = new Date(
    firstTickMs - OFFLINE_SWEEP_STALE_MS - 1,
  ).toISOString();

  updateNullGraceBookkeeping(serverId, liveness, firstTickMs);

  const laterMs = firstTickMs + OFFLINE_SWEEP_STALE_MS + 1;
  updateNullGraceBookkeeping(serverId, liveness, laterMs);

  assertEquals(isStale(serverId, liveness, laterMs, oldConnectedAt), true);
});
