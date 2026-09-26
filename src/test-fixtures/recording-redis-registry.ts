import type { DaemonCellRegistry } from "../contracts/cell.ts";
import { RedisDaemonCell } from "../daemon/cell/redis/cell.ts";
import type { RedisCellClient } from "../daemon/cell/redis/client.ts";
import { createFakeRedisCellClient } from "../daemon/cell/redis/fake-redis-cell-client.ts";

/**
 * A registry whose one cell is the real {@link RedisDaemonCell} over the
 * in-memory Redis client, recording every stream entry the cell writes — the
 * exact fields a self-hosted outbox would hold. `createRequestAndWait` waits
 * `waitMs` instead of the caller's timeout, so a request no daemon answers
 * expires quickly.
 */
export function recordingRedisRegistry(
  serverId: string,
  waitMs = 20,
): {
  registry: DaemonCellRegistry;
  outboxWrites: Record<string, string>[];
} {
  const client = createFakeRedisCellClient();
  const outboxWrites: Record<string, string>[] = [];
  const xadd = client.xadd.bind(client);
  client.xadd = (key, id, fields) => {
    outboxWrites.push({ ...fields });
    return xadd(key, id, fields);
  };
  const cell = new RedisDaemonCell(
    client as unknown as RedisCellClient,
    serverId,
  );
  const fastCell = new Proxy(cell, {
    get(target, prop) {
      if (prop === "createRequestAndWait") {
        return (
          envelope: Parameters<RedisDaemonCell["createRequestAndWait"]>[0],
        ) => target.createRequestAndWait(envelope, waitMs);
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const registry = { getCell: () => fastCell } as unknown as DaemonCellRegistry;
  return { registry, outboxWrites };
}
