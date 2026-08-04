/**
 * Replaceable dispatch seam for system-component operate actions.
 *
 * Production callers use {@link systemComponentOperations}. Tests may replace
 * `restart` on the mutable seam.
 */

import type { Db } from '../../db.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import { enqueueSystemReconcile } from './reconcile.ts'

export type SystemRestartSuccess = {
  ok: true
  commandId: string
  serverId: string
}

export type SystemRestartFailure = {
  ok: false
  reason: 'transport_unavailable' | 'not_provisioned'
}

export type SystemRestartResult = SystemRestartSuccess | SystemRestartFailure

export type SystemRestartParams = Readonly<{
  serverId: string
  environmentId: string
  component: string
  actorId: string
  db: Db
  commandQueue: CommandQueue
}>

async function restartSystemComponent(
  params: SystemRestartParams,
): Promise<SystemRestartResult> {
  const result = await enqueueSystemReconcile(params.db, params.commandQueue, {
    serverId: params.serverId,
    environmentId: params.environmentId,
    actorType: 'user',
    actorId: params.actorId,
    action: 'restart',
  })
  if (!result.ok) {
    if (result.reason === 'not_provisioned') {
      return { ok: false, reason: 'not_provisioned' }
    }
    return { ok: false, reason: 'transport_unavailable' }
  }
  return {
    ok: true,
    commandId: result.commandId,
    serverId: result.serverId,
  }
}

/**
 * Mutable operate hooks — tests / transport phase may replace `restart`.
 * Production callers use {@link systemComponentOperations}.
 */
export const systemComponentOperations = {
  restart: restartSystemComponent,
}
