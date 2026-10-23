/**
 * What the deploy waiter needs to know about a server before it waits: does the
 * server's daemon send signs of life (`command-recovery-v1`), and how long may a
 * deploy run while it reports (a fixed 30 minutes, `DEPLOY_DEFAULT_TIMEOUT_MS`).
 */
import type { Db } from '../../db/connection.ts'
import { COMMAND_RECOVERY_FEATURE } from '../../lib/version-wire.ts'
import { DEPLOY_DEFAULT_TIMEOUT_MS } from './deploy-limits.ts'
import { getServerDaemonStateByServerId } from '../servers/server-identity-db.ts'

export type DeployWaitSettings = { recovery: boolean; runCapMs: number }

/** Does this server's daemon list `command-recovery-v1`? A read that fails counts as no. */
export async function serverHasCommandRecovery(db: Db, serverId: string): Promise<boolean> {
  try {
    const state = await getServerDaemonStateByServerId(db, serverId)
    return (state?.projection?.features ?? []).includes(COMMAND_RECOVERY_FEATURE)
  } catch {
    return false
  }
}

/** Best effort: a read that fails leaves the old fixed rule in force. */
export async function loadDeployWaitSettings(
  db: Db,
  serverId: string
): Promise<DeployWaitSettings> {
  return {
    recovery: await serverHasCommandRecovery(db, serverId),
    runCapMs: DEPLOY_DEFAULT_TIMEOUT_MS,
  }
}
