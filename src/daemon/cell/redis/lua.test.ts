import { assert, assertEquals } from "jsr:@std/assert";
import {
  COMPARE_AND_DELETE,
  COMPARE_AND_RENEW,
  RATE_LIMIT_TOKEN_BUCKET,
  RECONCILE_STALE_SOCKET_PRESENCE,
} from "./lua.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("COMPARE_AND_DELETE atomically deletes only when the token matches", () => {
  assert(COMPARE_AND_DELETE.includes('redis.call("GET", KEYS[1])'));
  assert(COMPARE_AND_DELETE.includes('redis.call("DEL", KEYS[1])'));
  assertEquals(COMPARE_AND_DELETE.includes("else"), true);
});

test("COMPARE_AND_RENEW atomically renews only when the token matches", () => {
  assert(COMPARE_AND_RENEW.includes('"PX"'));
  assert(COMPARE_AND_RENEW.includes('redis.call("SET", KEYS[1], ARGV[2], "PX", ARGV[3])'));
});

test("RECONCILE_STALE_SOCKET_PRESENCE demotes stale meta and trims the online set", () => {
  assert(RECONCILE_STALE_SOCKET_PRESENCE.includes('HGET", KEYS[2], "connected"'));
  assert(RECONCILE_STALE_SOCKET_PRESENCE.includes('SREM", KEYS[3], ARGV[1]'));
  assert(RECONCILE_STALE_SOCKET_PRESENCE.includes("lastInboundAt"));
  assert(RECONCILE_STALE_SOCKET_PRESENCE.includes("lastSeenAt"));
  assert(RECONCILE_STALE_SOCKET_PRESENCE.includes("connectedAt"));
  assert(RECONCILE_STALE_SOCKET_PRESENCE.includes("tp:cell:"));
});

test("RATE_LIMIT_TOKEN_BUCKET refills tokens and returns allow/deny", () => {
  assert(RATE_LIMIT_TOKEN_BUCKET.includes("HMGET"));
  assert(RATE_LIMIT_TOKEN_BUCKET.includes("math.min(capacity"));
  assert(RATE_LIMIT_TOKEN_BUCKET.includes("PEXPIRE"));
  assertEquals(RATE_LIMIT_TOKEN_BUCKET.includes("return allowed"), true);
});
