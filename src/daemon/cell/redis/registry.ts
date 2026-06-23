import type { Db } from "../../db.ts";
import type {
  DaemonCell,
  DaemonCellRegistry,
  DaemonCellSnapshot,
} from "../contracts.ts";
import type { RedisClientOptions } from "./client.ts";
import { createRedisCellClient, RedisCellClient } from "./client.ts";
import { RedisDaemonCell } from "./cell.ts";
import { runControlPlaneMaintenance } from "../notification-delivery.ts";
import { projectServerDaemon } from "../postgres-projection.ts";
import { monitorMaintenanceSetKey, onlineSetKey } from "./keys.ts";

export type RedisDaemonCellRegistry = DaemonCellRegistry & {
  client: RedisCellClient;
  maintain(db?: Db): Promise<void>;
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

    async maintain(db?: Db): Promise<void> {
      const [onlineServerIds, maintenanceServerIds] = await Promise.all([
        client.smembers(onlineSetKey()),
        client.smembers(monitorMaintenanceSetKey()),
      ]);
      const serverIds = [
        ...new Set([...onlineServerIds, ...maintenanceServerIds]),
      ];
      const offlineServerIds: string[] = [];
      await Promise.all(
        serverIds.map(async (serverId) => {
          const offlineApplied = await getCell(serverId).prune();
          if (offlineApplied) offlineServerIds.push(serverId);
        }),
      );
      if (db) {
        await Promise.all(
          offlineServerIds.map(async (serverId) => {
            await projectServerDaemon(db, serverId, { kind: "offline" }, {
              cell: getCell(serverId),
            });
          }),
        );
        await runControlPlaneMaintenance(db, this, maintenanceServerIds);
      }
    },

    async close(): Promise<void> {
      await client.close();
    },
  };
}

export { createRedisCellClient, RedisCellClient } from "./client.ts";
export { RedisDaemonCell } from "./cell.ts";
