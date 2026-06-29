import { assertEquals } from "jsr:@std/assert";
import {
  buildDefaultDaemonStatus,
  parseServerDaemonState,
} from "./daemon-state.ts";

const baseKey = {
  id: "key-1",
  algorithm: "Ed25519" as const,
  publicJwk: { kty: "OKP", crv: "Ed25519", x: "abc" },
  fingerprint: "fp-1",
  createdAt: "2020-01-01T00:00:00.000Z",
};

Deno.test("parseServerDaemonState synthesizes connected status from legacy projection", () => {
  const legacy = {
    key: baseKey,
    projection: {
      hostname: "legacy-host",
      machineId: "legacy-mid",
      connected: true,
      connectedAt: "2020-06-01T12:00:00.000Z",
      lastProjectedAt: "2020-06-01T12:05:00.000Z",
    },
  };

  const parsed = parseServerDaemonState(legacy);
  assertEquals(parsed?.status?.connected, true);
  assertEquals(parsed?.status?.daemonStatus, "online");
  assertEquals(parsed?.status?.connectedAt, "2020-06-01T12:00:00.000Z");
  assertEquals(parsed?.status?.lastSeenAt, "2020-06-01T12:05:00.000Z");
  assertEquals(parsed?.projection?.hostname, "legacy-host");
  assertEquals(parsed?.projection?.machineId, "legacy-mid");
  assertEquals(
    (parsed?.projection as Record<string, unknown> | undefined)?.connected,
    undefined,
  );
});

Deno.test("parseServerDaemonState synthesizes offline status from legacy projection", () => {
  const legacy = {
    key: baseKey,
    projection: {
      hostname: "legacy-host",
      connected: false,
      lastProjectedAt: "2020-06-01T12:05:00.000Z",
    },
  };

  const parsed = parseServerDaemonState(legacy);
  assertEquals(parsed?.status?.connected, false);
  assertEquals(parsed?.status?.daemonStatus, "offline");
  assertEquals(parsed?.status?.lastSeenAt, "2020-06-01T12:05:00.000Z");
});

Deno.test("parseServerDaemonState prefers explicit status over legacy projection", () => {
  const row = {
    key: baseKey,
    projection: {
      connected: true,
      lastProjectedAt: "2020-01-01T00:00:00.000Z",
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
  assertEquals(parsed?.status?.connected, false);
  assertEquals(parsed?.status?.lastSeenAt, "2020-02-01T00:00:00.000Z");
});

Deno.test("parseServerDaemonState without status or legacy liveness uses no status field", () => {
  const row = {
    key: baseKey,
    projection: {
      hostname: "host-only",
    },
  };

  const parsed = parseServerDaemonState(row);
  assertEquals(parsed?.status, undefined);
  assertEquals(parsed?.projection?.hostname, "host-only");
  assertEquals(buildDefaultDaemonStatus().connected, false);
});
