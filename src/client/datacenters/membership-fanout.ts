import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { Db } from '../../db/connection.ts'
import { getCommandQueue } from '../../features/commands/queue.ts'
import { isNoopCommandQueue } from '../../features/commands/noop-command-queue.ts'
import type { LanPairRefusal } from '../../features/fabric/lan-pair-guard.ts'
import { reconcileServerNetworking } from '../../features/fabric/server-networking.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'

/**
 * A server joined or left a datacenter: which pairs share a trusted LAN may
 * have changed, so peer lists and LAN routes are re-planned
 * (`reconcileServerNetworking`). Skipped without a queue or secrets; failures
 * are logged, the membership change already succeeded.
 */
export async function fanOutDatacenterMembershipChange(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string,
  actorId: string
): Promise<void> {
  const commandQueue = getCommandQueue(c)
  const secretsConfig = c.get('secretsConfig')
  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  if (!commandQueue || isNoopCommandQueue(commandQueue) || !secretsConfig) return
  try {
    await reconcileServerNetworking({
      db,
      commandQueue,
      actor: { type: 'user', id: actorId },
      organizationId,
      secrets: { secretsConfig, ...(dataEncryptionSecrets ? { dataEncryptionSecrets } : {}) },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    compatLogWarn('datacenters', `networking fan-out failed after a membership change: ${message}`)
  }
}

/**
 * 409 `lan_pair_in_use`: the change would cut a container network that runs
 * over a trusted LAN with no tunnel while TurboFabric is not running for it.
 */
export function lanPairRefusalResponse(c: Context, refusal: LanPairRefusal): Response {
  return c.json({ error: 'lan_pair_in_use', ...refusal }, 409)
}
