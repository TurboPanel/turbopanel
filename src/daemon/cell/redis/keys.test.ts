import { assertEquals } from "@std/assert";
import {
  cellKeyPattern,
  connKey,
  deliveryLeaseKey,
  HEARTBEAT_COALESCE_MS,
  LEASE_TTL_MS,
  leaseKey,
  metaKey,
  onlineSetKey,
  OUTBOX_GROUP,
  outboxKey,
  rateLimitKey,
  requestKey,
  requestsKey,
  snapshotKey,
} from "./keys.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const serverId = "00000000-0000-4000-8000-000000000099";
const requestId = "req-abc";
const connectionId = "conn-xyz";

test("redis cell key helpers use the tp:cell namespace", () => {
  assertEquals(metaKey(serverId), `tp:cell:${serverId}:meta`);
  assertEquals(snapshotKey(serverId), `tp:cell:${serverId}:snapshot`);
  assertEquals(outboxKey(serverId), `tp:cell:${serverId}:outbox`);
  assertEquals(requestsKey(serverId), `tp:cell:${serverId}:requests`);
  assertEquals(
    requestKey(serverId, requestId),
    `tp:cell:${serverId}:request:${requestId}`,
  );
  assertEquals(leaseKey(serverId), `tp:cell:${serverId}:lease:daemon-socket`);
  assertEquals(deliveryLeaseKey(serverId), `tp:cell:${serverId}:lease:delivery`);
  assertEquals(
    connKey(serverId, connectionId),
    `tp:cell:${serverId}:conn:${connectionId}`,
  );
  assertEquals(cellKeyPattern(serverId), `tp:cell:${serverId}:*`);
  assertEquals(onlineSetKey(), "tp:cell:online");
});

test("rateLimitKey prefixes shared daemon limiter ids", () => {
  assertEquals(
    rateLimitKey("daemon:connect:server-1"),
    "tp:ratelimit:daemon:connect:server-1",
  );
});

test("redis cell timing constants match protocol coalesce window", () => {
  assertEquals(OUTBOX_GROUP, "daemon");
  assertEquals(HEARTBEAT_COALESCE_MS, 60_000);
  assertEquals(LEASE_TTL_MS, 120_000);
});
