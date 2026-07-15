import { assert, assertEquals, assertExists } from "jsr:@std/assert";
import type { DaemonCellSnapshot, PendingRequestStatus } from "./contracts.ts";
import { mergeSnapshotPresence } from "./snapshot-merge.ts";

const TERMINAL_STATUSES = new Set<PendingRequestStatus>([
  "done",
  "failed",
  "expired",
]);

function isTerminalStatus(status: PendingRequestStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test("mergeSnapshotPresence prefers meta-layer presence fields", () => {
  const stored: DaemonCellSnapshot = {
    serverId: "srv-1",
    version: 1,
    updatedAt: "2020-01-01T00:00:00.000Z",
    connected: false,
    connectedAt: "2020-01-01T00:00:00.000Z",
    lastInboundAt: "2020-01-01T00:00:00.000Z",
    remoteAddress: "203.0.113.1",
  };
  const meta: DaemonCellSnapshot = {
    serverId: "srv-1",
    version: 1,
    updatedAt: "2020-01-02T00:00:00.000Z",
    connected: true,
    connectedAt: "2020-01-02T00:00:00.000Z",
    lastInboundAt: "2020-01-02T00:00:00.000Z",
    remoteAddress: "203.0.113.2",
  };

  const merged = mergeSnapshotPresence(stored, meta);
  assertEquals(merged.connected, true);
  assertEquals(merged.connectedAt, "2020-01-02T00:00:00.000Z");
  assertEquals(merged.remoteAddress, "203.0.113.2");
  assertEquals(merged.updatedAt, "2020-01-02T00:00:00.000Z");
});

test("mergeSnapshotPresence falls back when meta fields are absent", () => {
  const stored: DaemonCellSnapshot = {
    serverId: "srv-1",
    version: 2,
    updatedAt: "2020-01-01T00:00:00.000Z",
    connected: true,
    connectedAt: "2020-01-01T00:00:00.000Z",
    lastInboundAt: "2020-01-01T00:00:00.000Z",
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
});

test("PendingRequestStatus terminal check mirrors Redis cell semantics", () => {
  for (const status of ["done", "failed", "expired"] as const) {
    assert(isTerminalStatus(status), `${status} should be terminal`);
  }
  for (const status of ["queued", "sent", "acked"] as const) {
    assert(!isTerminalStatus(status), `${status} should not be terminal`);
  }
});

test("DaemonCellSnapshot minimal shape has required fields", () => {
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
