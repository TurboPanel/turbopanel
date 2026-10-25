/**
 * What the deploy waiter needs to know about a server before it waits: does the
 * server's daemon send signs of life (`command-recovery-v1`), and how long may a
 * deploy run while it reports (the organization's deploy time limit, 30 minutes
 * unless an organization manager set another).
 */
import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { organization, server } from '../../db/schema.ts'
import { resolveDeployTimeoutMs } from '../organizations/organization-options.ts'
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

/**
 * The deploy time limit for a server's organization, from the stored
 * `organization.deploy_timeout_minutes` (null, or any value outside 5 to 240
 * whole minutes, means 30 minutes).
 */
export function deployRunCapFromMinutes(minutes: unknown): number {
  return resolveDeployTimeoutMs(minutes)
}

/** The organization's deploy time limit for this server; 30 minutes when it cannot be read. */
export async function loadDeployRunCapMs(db: Db, serverId: string): Promise<number> {
  try {
    const [row] = await db
      .select({ minutes: organization.deployTimeoutMinutes })
      .from(server)
      .innerJoin(organization, eq(organization.id, server.organizationId))
      .where(eq(server.id, serverId))
      .limit(1)
    return deployRunCapFromMinutes(row?.minutes)
  } catch {
    return DEPLOY_DEFAULT_TIMEOUT_MS
  }
}

/** Best effort: a read that fails leaves the old fixed rule in force. */
export async function loadDeployWaitSettings(
  db: Db,
  serverId: string
): Promise<DeployWaitSettings> {
  return {
    recovery: await serverHasCommandRecovery(db, serverId),
    runCapMs: await loadDeployRunCapMs(db, serverId),
  }
}
