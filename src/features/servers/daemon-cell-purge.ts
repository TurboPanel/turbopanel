import type { DaemonCellRegistry } from '../../contracts/cell.ts'

/**
 * Purge one server's daemon cell after its key was revoked, so its live
 * socket closes and its queued work is dropped instead of waiting out the
 * token. Best effort, never thrown: the key is already revoked, and the key
 * checks on connect and on every inbound frame still refuse the host if this
 * fails. The error goes to the log only (it names hosts and keys of the
 * Redis or Durable Object backend); callers get `false`.
 */
export async function purgeDaemonCellBestEffort(
  registry: DaemonCellRegistry,
  serverId: string,
  reason: string
): Promise<boolean> {
  try {
    await registry.getCell(serverId).purge()
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`Failed to purge daemon cell ${reason} for server ${serverId}: ${message}`)
    return false
  }
}
