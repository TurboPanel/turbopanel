import type {
  DaemonCell,
  DaemonCellRegistry,
  DaemonCellSnapshot,
} from "../contracts.ts";
import type { RedisClientOptions } from "./client.ts";
import { createRedisCellClient, RedisCellClient } from "./client.ts";
import { RedisDaemonCell } from "./cell.ts";
import { onlineSetKey } from "./keys.ts";

export type RedisDaemonCellRegistry = DaemonCellRegistry & {
  client: RedisCellClient;
  maintain(): Promise<void>;
  purge(serverId: string): Promise<void>;
  close(): Promise<void>;
};

export function createRedisDaemonCellRegistry(
  opts?: RedisClientOptions,
): RedisDaemonCellRegistry {
  const client = createRedisCellClient(opts);
  const cells = new Map<string, RedisDaemonCell>();

  const getCell = (serverId: string): DaemonCell => {
    let cell = cells.get(serverId);
    if (!cell) {
      cell = new RedisDaemonCell(client, serverId);
      cells.set(serverId, cell);
    }
    return cell;
  };

  return {
    client,
    getCell,

    async listOnlineServerIds(): Promise<string[]> {
      return await client.smembers(onlineSetKey());
    },

    async getSnapshots(
      serverIds: string[],
    ): Promise<Map<string, DaemonCellSnapshot>> {
      const snapshots = await Promise.all(
        serverIds.map(async (id) => {
          const snapshot = await getCell(id).getSnapshot();
          return [id, snapshot] as const;
        }),
      );
      return new Map(snapshots);
    },

    async maintain(): Promise<void> {
      const onlineServerIds = await client.smembers(onlineSetKey());
      await Promise.all(
        onlineServerIds.map(async (serverId) => {
          const cell = getCell(serverId) as RedisDaemonCell;
          await cell.prune();
        }),
      );
    },

    async purge(serverId: string): Promise<void> {
      await getCell(serverId).purge();
    },

    async close(): Promise<void> {
      await client.close();
    },
  };
}

export { createRedisCellClient, RedisCellClient } from "./client.ts";
export { RedisDaemonCell } from "./cell.ts";
