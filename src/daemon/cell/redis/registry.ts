import type { Db } from "../../db.ts";
import type {
  DaemonCell,
  DaemonCellRegistry,
  DaemonCellSnapshot,
} from "../contracts.ts";
import { logWarn } from "../../../logger.ts";
import type { RedisClientOptions } from "./client.ts";
import { createRedisCellClient, RedisCellClient } from "./client.ts";
import { RedisDaemonCell } from "./cell.ts";
import { onlineSetKey } from "./keys.ts";

export type RedisDaemonCellRegistryOptions = RedisClientOptions & {
  db?: Db;
};

export type RedisDaemonCellRegistry = DaemonCellRegistry & {
  client: RedisCellClient;
  maintain(): Promise<void>;
  reclaimOrphanedSocketLeasesOnStartup(): Promise<void>;
  purge(serverId: string): Promise<void>;
  close(): Promise<void>;
};

export function createRedisDaemonCellRegistry(
  opts?: RedisDaemonCellRegistryOptions,
): RedisDaemonCellRegistry {
  const client = createRedisCellClient(opts);
  const db = opts?.db;
  const cells = new Map<string, RedisDaemonCell>();

  const getCell = (serverId: string): DaemonCell => {
    let cell = cells.get(serverId);
    if (!cell) {
      cell = new RedisDaemonCell(client, serverId, db);
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
          try {
            await cell.prune();
          } catch (err) {
            logWarn(
              "daemon-cell",
              `prune error for ${serverId}: ${String(err)}`,
            );
          }
        }),
      );
    },

    async reclaimOrphanedSocketLeasesOnStartup(): Promise<void> {
      const leaseKeys = await client.scanKeys("tp:cell:*:lease:daemon-socket");
      await Promise.all(
        leaseKeys.map(async (key) => {
          const match = /^tp:cell:(.+):lease:daemon-socket$/.exec(key);
          if (!match) return;
          const cell = getCell(match[1]) as RedisDaemonCell;
          await cell.reclaimOrphanedSocketLeaseOnStartup();
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
