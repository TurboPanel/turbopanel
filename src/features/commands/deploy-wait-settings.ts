/**
 * What the deploy waiter needs to know about a server before it waits: does the
 * server's daemon send signs of life (`command-recovery-v1`), and how long may a
 * deploy run for the server's organization.
 */
import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { organization, server } from '../../db/schema.ts'
import { COMMAND_RECOVERY_FEATURE } from '../../lib/version-wire.ts'
import {
  parseOrganizationOptions,
  resolveDeployTimeoutMs,
} from '../organizations/organization-options.ts'
import { getServerDaemonStateByServerId } from '../servers/server-identity-db.ts'

export type DeployWaitSettings = { recovery: boolean; runCapMs: number }

async function organizationDeployTimeoutMs(db: Db, serverId: string): Promise<number> {
  const [row] = await db
    .select({ options: organization.options })
    .from(server)
    .innerJoin(organization, eq(organization.id, server.organizationId))
    .where(eq(server.id, serverId))
    .limit(1)
  return resolveDeployTimeoutMs(parseOrganizationOptions(row?.options))
}

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
  const recovery = await serverHasCommandRecovery(db, serverId)
  try {
    return { recovery, runCapMs: await organizationDeployTimeoutMs(db, serverId) }
  } catch {
    return { recovery, runCapMs: resolveDeployTimeoutMs({}) }
  }
}
