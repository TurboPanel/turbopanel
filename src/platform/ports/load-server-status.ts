/**
 * Loader for live server-status records. Registered at the composition root
 * so features never import `client/servers/update-status`.
 */

import type { Db } from '../../db/connection.ts'

export type ServerStatusConnectedRecord = {
  serverId: string
  connected: boolean
}

export type LoadServerStatusRecords = (
  db: Db,
  registry: unknown,
  serverIds: string[],
) => Promise<ServerStatusConnectedRecord[]>

let loader: LoadServerStatusRecords | null = null

export function setLoadServerStatusRecords(next: LoadServerStatusRecords | null): void {
  loader = next
}

export function getLoadServerStatusRecords(): LoadServerStatusRecords {
  if (!loader) {
    throw new Error('loadServerStatusRecords port is not registered')
  }
  return loader
}
