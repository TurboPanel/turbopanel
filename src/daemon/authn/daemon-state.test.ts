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

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test("parseServerDaemonState prefers explicit status over projection", () => {
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
  assertEquals(parsed?.status?.connected, false);
  assertEquals(parsed?.status?.lastSeenAt, "2020-02-01T00:00:00.000Z");
  assertEquals(parsed?.projection?.hostname, "legacy-host");
});

test("parseServerDaemonState without status uses no status field", () => {
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
