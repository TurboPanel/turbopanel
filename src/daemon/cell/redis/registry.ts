import type {
  DaemonCell,
  DaemonCellRegistry,
  DaemonCellSnapshot,
} from '../contracts.ts'
import type { RedisClientOptions } from './client.ts'
import { createRedisCellClient, RedisCellClient } from './client.ts'
import { RedisDaemonCell } from './cell.ts'
import { onlineSetKey } from './keys.ts'

export type RedisDaemonCellRegistry = DaemonCellRegistry & {
  client: RedisCellClient
  maintain(): Promise<void>
  close(): Promise<void>
}

export function createRedisDaemonCellRegistry(
  opts?: RedisClientOptions,
): RedisDaemonCellRegistry {
  const client = createRedisCellClient(opts)
  const cells = new Map<string, RedisDaemonCell>()

  const getCell = (serverId: string): DaemonCell => {
    let cell = cells.get(serverId)
    if (!cell) {
      cell = new RedisDaemonCell(client, serverId)
      cells.set(serverId, cell)
    }
    return cell
  }

  return {
    client,
    getCell,

    async listOnlineServerIds(): Promise<string[]> {
      return await client.smembers(onlineSetKey())
    },

    async getSnapshots(
      serverIds: string[],
    ): Promise<Map<string, DaemonCellSnapshot>> {
      const snapshots = await Promise.all(
        serverIds.map(async (id) => {
          const snapshot = await getCell(id).getSnapshot()
          return [id, snapshot] as const
        }),
      )
      return new Map(snapshots)
    },

    async maintain(): Promise<void> {
      const serverIds = await client.smembers(onlineSetKey())
      await Promise.all(
        serverIds.map(async (serverId) => {
          await getCell(serverId).prune()
        }),
      )
    },

    async close(): Promise<void> {
      await client.close()
    },
  }
}

export { RedisCellClient, createRedisCellClient } from './client.ts'
export { RedisDaemonCell } from './cell.ts'
