import { assert, assertEquals, assertExists } from "jsr:@std/assert";
import type { DaemonCellSnapshot, PendingRequestStatus } from "./contracts.ts";
import { mergeSnapshotPresence } from "./snapshot-merge.ts";

const TERMINAL_STATUSES = new Set<PendingRequestStatus>([
  "acked",
  "done",
  "failed",
  "expired",
]);

function isTerminalStatus(status: PendingRequestStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

Deno.test("mergeSnapshotPresence prefers meta-layer presence fields", () => {
  const stored: DaemonCellSnapshot = {
    serverId: "srv-1",
    version: 1,
    updatedAt: "2020-01-01T00:00:00.000Z",
    connected: false,
    connectedAt: "2020-01-01T00:00:00.000Z",
    lastHeartbeatAt: "2020-01-01T00:00:00.000Z",
    hostname: "stored-host",
  };
  const meta: DaemonCellSnapshot = {
    serverId: "srv-1",
    version: 1,
    updatedAt: "2020-01-02T00:00:00.000Z",
    connected: true,
    connectedAt: "2020-01-02T00:00:00.000Z",
    lastHeartbeatAt: "2020-01-02T00:00:00.000Z",
    hostname: "live-host",
  };

  const merged = mergeSnapshotPresence(stored, meta);
  assertEquals(merged.connected, true);
  assertEquals(merged.connectedAt, "2020-01-02T00:00:00.000Z");
  assertEquals(merged.lastHeartbeatAt, "2020-01-02T00:00:00.000Z");
  assertEquals(merged.hostname, "live-host");
  assertEquals(merged.updatedAt, "2020-01-02T00:00:00.000Z");
});

Deno.test("mergeSnapshotPresence falls back when meta fields are absent", () => {
  const stored: DaemonCellSnapshot = {
    serverId: "srv-1",
    version: 2,
    updatedAt: "2020-01-01T00:00:00.000Z",
    connected: true,
    connectedAt: "2020-01-01T00:00:00.000Z",
    lastHeartbeatAt: "2020-01-01T00:00:00.000Z",
  };
  const meta: DaemonCellSnapshot = {
    serverId: "srv-1",
    version: 2,
    updatedAt: "2020-01-01T00:00:00.000Z",
    connected: false,
  };

  const merged = mergeSnapshotPresence(stored, meta);
  assertEquals(merged.connected, false);
  assertEquals(merged.connectedAt, "2020-01-01T00:00:00.000Z");
  assertEquals(merged.lastHeartbeatAt, "2020-01-01T00:00:00.000Z");
});

Deno.test("PendingRequestStatus terminal check mirrors Redis cell semantics", () => {
  for (const status of ["acked", "done", "failed", "expired"] as const) {
    assert(isTerminalStatus(status), `${status} should be terminal`);
  }
  for (const status of ["queued", "sent"] as const) {
    assert(!isTerminalStatus(status), `${status} should not be terminal`);
  }
});

Deno.test("DaemonCellSnapshot minimal shape has required fields", () => {
  const snapshot: DaemonCellSnapshot = {
    serverId: "srv-test",
    version: 0,
    updatedAt: new Date().toISOString(),
    connected: false,
  };
  assertExists(snapshot.serverId);
  assertEquals(typeof snapshot.version, "number");
  assertExists(snapshot.updatedAt);
  assertEquals(typeof snapshot.connected, "boolean");
});
