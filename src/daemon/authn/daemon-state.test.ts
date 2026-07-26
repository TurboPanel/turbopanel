import { assertEquals } from "jsr:@std/assert";
import {
  buildDefaultDaemonStatus,
  mapServerDaemonStatusFromColumns,
  parseServerDaemonState,
} from "./daemon-state.ts";

const baseKey = {
  id: "key-1",
  algorithm: "Ed25519" as const,
  publicJwk: { kty: "OKP", crv: "Ed25519", x: "abc" },
  fingerprint: "fp-1",
  createdAt: "2020-01-01T00:00:00.000Z",
};

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test("parseServerDaemonState parses key + projection only", () => {
  const row = {
    key: baseKey,
    projection: {
      hostname: "legacy-host",
    },
  };

  const parsed = parseServerDaemonState(row);
  assertEquals(parsed?.key.id, "key-1");
  assertEquals(parsed?.projection?.hostname, "legacy-host");
});

test("parseServerDaemonState ignores a legacy status field on the jsonb blob", () => {
  // `server.daemon` no longer carries `status` — fleet liveness lives on
  // dedicated columns. A stray legacy `status` key (e.g. from an old row that
  // has not been migrated) must not surface on the parsed state.
  const row = {
    key: baseKey,
    projection: {
      hostname: "legacy-host",
    },
    status: {
      connected: false,
      daemonStatus: "offline",
      lastSeenAt: "2020-02-01T00:00:00.000Z",
      connectedAt: null,
      disconnectedAt: "2020-02-01T00:00:00.000Z",
      statusChangedAt: "2020-02-01T00:00:00.000Z",
    },
  };

  const parsed = parseServerDaemonState(row);
  assertEquals(parsed && "status" in parsed, false);
  assertEquals(parsed?.projection?.hostname, "legacy-host");
});

test("parseServerDaemonState without projection omits the projection field", () => {
  const row = { key: baseKey };

  const parsed = parseServerDaemonState(row);
  assertEquals(parsed?.projection, undefined);
  assertEquals(parsed?.key.id, "key-1");
});

test("buildDefaultDaemonStatus returns unknown/disconnected defaults", () => {
  const status = buildDefaultDaemonStatus();
  assertEquals(status.connected, false);
  assertEquals(status.daemonStatus, "unknown");
  assertEquals(status.lastSeenAt, null);
  assertEquals(status.connectedAt, null);
  assertEquals(status.disconnectedAt, null);
  assertEquals(status.statusChangedAt, null);
});

test("mapServerDaemonStatusFromColumns maps connected/online columns", () => {
  const status = mapServerDaemonStatusFromColumns({
    connected: true,
    daemonStatus: "online",
    lastSeenAt: "2020-02-01T00:00:00.000Z",
    connectedAt: "2020-01-15T00:00:00.000Z",
    disconnectedAt: null,
    statusChangedAt: "2020-01-15T00:00:00.000Z",
  });

  assertEquals(status.connected, true);
  assertEquals(status.daemonStatus, "online");
  assertEquals(status.lastSeenAt, "2020-02-01T00:00:00.000Z");
  assertEquals(status.connectedAt, "2020-01-15T00:00:00.000Z");
  assertEquals(status.disconnectedAt, null);
  assertEquals(status.statusChangedAt, "2020-01-15T00:00:00.000Z");
});

test("mapServerDaemonStatusFromColumns maps disconnected/offline columns", () => {
  const status = mapServerDaemonStatusFromColumns({
    connected: false,
    daemonStatus: "offline",
    lastSeenAt: "2020-02-01T00:00:00.000Z",
    connectedAt: null,
    disconnectedAt: "2020-02-01T00:00:00.000Z",
    statusChangedAt: "2020-02-01T00:00:00.000Z",
  });

  assertEquals(status.connected, false);
  assertEquals(status.daemonStatus, "offline");
  assertEquals(status.disconnectedAt, "2020-02-01T00:00:00.000Z");
});

test("mapServerDaemonStatusFromColumns falls back to unknown for invalid daemonStatus", () => {
  const status = mapServerDaemonStatusFromColumns({
    connected: false,
    daemonStatus: "bogus",
    lastSeenAt: null,
    connectedAt: null,
    disconnectedAt: null,
    statusChangedAt: null,
  });

  assertEquals(status.daemonStatus, "unknown");
});

test("mapServerDaemonStatusFromColumns coerces null/undefined connected to false", () => {
  const status = mapServerDaemonStatusFromColumns({
    connected: null,
    daemonStatus: "unknown",
    lastSeenAt: undefined,
    connectedAt: undefined,
    disconnectedAt: undefined,
    statusChangedAt: undefined,
  });

  assertEquals(status.connected, false);
  assertEquals(status.lastSeenAt, null);
  assertEquals(status.connectedAt, null);
  assertEquals(status.disconnectedAt, null);
  assertEquals(status.statusChangedAt, null);
});
