import { assertEquals } from "@std/assert";
import {
  buildDefaultDaemonStatus,
  featuresMatch,
  isDaemonKeyActive,
  mapServerDaemonStatusFromColumns,
  parseServerDaemonKeyRow,
  parseServerDaemonState,
  projectionWithFeatures,
} from "./daemon-state.ts";

const baseKey = {
  id: "key-1",
  algorithm: "Ed25519" as const,
  publicJwk: { kty: "OKP", crv: "Ed25519", x: "abc" },
  fingerprint: "fp-1",
  createdAt: "2020-01-01T00:00:00.000Z",
  revokedAt: null,
  lastUsedAt: null,
};

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test("parseServerDaemonState parses the projection — the key lives in the key table, not this jsonb", () => {
  const row = {
    projection: {
      hostname: "legacy-host",
    },
  };

  const parsed = parseServerDaemonState(row);
  assertEquals(parsed?.projection?.hostname, "legacy-host");
  assertEquals(parsed && "key" in parsed, false);
});

test("parseServerDaemonState ignores an unknown status key on the jsonb blob", () => {
  // `server.daemon` does not carry `status` — fleet liveness lives on dedicated
  // columns. The parser is allowlist-shaped, so an extra key on the jsonb blob
  // must not surface on the parsed state.
  const row = {
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
  const parsed = parseServerDaemonState({});
  assertEquals(parsed?.projection, undefined);
});

test("parseServerDaemonState returns null for a null jsonb column", () => {
  // `server.daemon` is null for an unenrolled server or after clearServerDaemonState.
  assertEquals(parseServerDaemonState(null), null);
});

test("buildDefaultDaemonStatus returns unknown/disconnected defaults", () => {
  const status = buildDefaultDaemonStatus();
  assertEquals(status.connected, false);
  assertEquals(status.daemonStatus, "unknown");
  assertEquals(status.statusChangedAt, null);
});

test("mapServerDaemonStatusFromColumns derives online when connected + statusChangedAt", () => {
  const status = mapServerDaemonStatusFromColumns({
    connected: true,
    statusChangedAt: "2020-01-15T00:00:00.000Z",
  });

  assertEquals(status.connected, true);
  assertEquals(status.daemonStatus, "online");
  assertEquals(status.statusChangedAt, "2020-01-15T00:00:00.000Z");
});

test("mapServerDaemonStatusFromColumns derives offline when !connected + statusChangedAt", () => {
  const status = mapServerDaemonStatusFromColumns({
    connected: false,
    statusChangedAt: "2020-02-01T00:00:00.000Z",
  });

  assertEquals(status.connected, false);
  assertEquals(status.daemonStatus, "offline");
  assertEquals(status.statusChangedAt, "2020-02-01T00:00:00.000Z");
});

test("mapServerDaemonStatusFromColumns derives unknown when statusChangedAt is null", () => {
  const status = mapServerDaemonStatusFromColumns({
    connected: false,
    statusChangedAt: null,
  });

  assertEquals(status.daemonStatus, "unknown");
  assertEquals(status.statusChangedAt, null);
});

test("mapServerDaemonStatusFromColumns coerces null/undefined connected to false", () => {
  const status = mapServerDaemonStatusFromColumns({
    connected: null,
    statusChangedAt: undefined,
  });

  assertEquals(status.connected, false);
  assertEquals(status.daemonStatus, "unknown");
  assertEquals(status.statusChangedAt, null);
});

test("mapServerDaemonStatusFromColumns treats blank statusChangedAt as unknown", () => {
  const status = mapServerDaemonStatusFromColumns({
    connected: true,
    statusChangedAt: "   ",
  });
  assertEquals(status.daemonStatus, "unknown");
});

test("parseServerDaemonState rejects invalid shapes", () => {
  assertEquals(parseServerDaemonState(null), null);
  assertEquals(parseServerDaemonState([]), null);
  assertEquals(parseServerDaemonState("nope"), null);
});

test("parseServerDaemonState ignores a non-object projection", () => {
  const parsed = parseServerDaemonState({
    projection: [],
  });
  assertEquals(parsed?.projection, undefined);
});

test("parseServerDaemonState parses daemonBuild and update projection fields", () => {
  const parsed = parseServerDaemonState({
    projection: {
      hostname: "host-1",
      machineKey: "mk-1",
      remoteAddress: "203.0.113.1",
      keyId: "key-1",
      daemonBuild: {
        commit: "abc123",
        buildId: "build-1",
        builtAt: "2020-01-01T00:00:00.000Z",
        channel: "trunk",
      },
      update: {
        status: "updating",
        channel: "trunk",
        requestId: "req-1",
        queuedAt: "2020-01-01T00:00:00.000Z",
        finishedAt: "2020-01-02T00:00:00.000Z",
        error: "boom",
      },
    },
  });

  assertEquals(parsed?.projection?.hostname, "host-1");
  assertEquals(parsed?.projection?.daemonBuild?.commit, "abc123");
  assertEquals(parsed?.projection?.update?.status, "updating");
  assertEquals(parsed?.projection?.update?.error, "boom");
});

test("parseServerDaemonState drops empty projection objects", () => {
  const parsed = parseServerDaemonState({
    projection: {
      hostname: "   ",
      daemonBuild: {},
      update: { status: "not-a-status" },
    },
  });
  assertEquals(parsed?.projection, undefined);
});

test("isDaemonKeyActive reflects revokedAt", () => {
  assertEquals(isDaemonKeyActive({ ...baseKey, revokedAt: null }), true);
  assertEquals(isDaemonKeyActive({ ...baseKey, revokedAt: undefined }), true);
  assertEquals(
    isDaemonKeyActive({
      ...baseKey,
      revokedAt: "2020-01-01T00:00:00.000Z",
    }),
    false,
  );
});

test("parseServerDaemonKeyRow narrows a valid key table row", () => {
  const parsed = parseServerDaemonKeyRow(baseKey);
  assertEquals(parsed?.id, "key-1");
  assertEquals(parsed?.algorithm, "Ed25519");
  assertEquals(parsed?.fingerprint, "fp-1");
  assertEquals(parsed?.revokedAt, null);
  assertEquals(parsed?.lastUsedAt, null);
});

test("parseServerDaemonKeyRow rejects a non-Ed25519 algorithm", () => {
  assertEquals(parseServerDaemonKeyRow({ ...baseKey, algorithm: "RSA" }), null);
});

test("parseServerDaemonState keeps an empty features list and drops a non-array", () => {
  const empty = parseServerDaemonState({ projection: { features: [] } });
  assertEquals(empty?.projection?.features, []);
  assertEquals(featuresMatch(undefined, []), false);
  assertEquals(featuresMatch([], []), true);
  const merged = projectionWithFeatures(
    { hostname: "host-1", features: ["old"] },
    ["managed-upgrade-v1"],
  );
  assertEquals(merged.hostname, "host-1");
  assertEquals(merged.features, ["managed-upgrade-v1"]);
  const bad = parseServerDaemonState({
    projection: { hostname: "host-1", features: ["ok", 1] },
  });
  assertEquals(bad?.projection?.hostname, "host-1");
  assertEquals(bad?.projection?.features, undefined);
});

test("parseServerDaemonKeyRow rejects a malformed publicJwk", () => {
  assertEquals(
    parseServerDaemonKeyRow({ ...baseKey, publicJwk: { kty: "RSA" } }),
    null,
  );
  assertEquals(parseServerDaemonKeyRow({ ...baseKey, publicJwk: [] }), null);
});
