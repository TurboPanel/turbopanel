/**
 * What has to happen when a cluster's exposure setting changes.
 *
 * The exposure setting only says where the database's shared ProxySQL listens
 * (see `access-scope.ts`). The listener itself lives on each server, so saving
 * the setting is not enough: every server that fronts the cluster has to be
 * told the new addresses, or it keeps listening where it was. This module owns
 * the "did it change", "can it be applied" and "tell the servers" steps for the
 * settings route.
 */

import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import type { Db } from '../../db/connection.ts'
import { replica } from '../../db/schema.ts'
import { consumerServerIdsForManaged } from '../bindings/resolve-endpoint.ts'
import { preflightManagedApplyInfrastructure } from './apply-prepare.ts'
import type { ManagedApplyPrepareError } from './apply-prepare.ts'
import { enqueueManagedIngressReconcile } from './ingress-desired.ts'
import { requestedExposureScope } from './host-exposure.ts'
import type { ManagedSettings } from './settings.ts'
import type { CommandQueue } from '../commands/queue.ts'
import { firstSequential, forEachSequential } from '../../lib/sequential.ts'

/** True when the two settings ask for a different host listener. */
export function managedExposureChanged(
  before: ManagedSettings['exposure'],
  after: ManagedSettings['exposure']
): boolean {
  return requestedExposureScope(before) !== requestedExposureScope(after)
}

/** Every server whose ProxySQL fronts the cluster: its members and bound consumers. */
export async function loadManagedFrontendServerIds(db: Db, managedId: string): Promise<string[]> {
  const members = await db
    .select({ serverId: replica.serverId })
    .from(replica)
    .where(eq(replica.managedId, managedId))
  const consumers = await consumerServerIdsForManaged(db, managedId)
  return [...new Set([...members.map((row) => row.serverId), ...consumers])]
}

/**
 * Refuse a new scope before it is saved when one of the servers has no address
 * for it (a datacenter or TurboFabric scope on a server without one), or cannot
 * be sent commands. Saving it anyway would leave the old listener in place with
 * the screen claiming otherwise.
 */
export async function preflightManagedExposureChange(
  c: Context,
  db: Db,
  params: Readonly<{ serverIds: readonly string[]; scope: ManagedSettings['exposure']['scope'] }>
): Promise<ManagedApplyPrepareError | null> {
  // One server at a time: the first refusal is the one reported.
  return (
    (await firstSequential(params.serverIds, async (serverId) => {
      const failure = await preflightManagedApplyInfrastructure(c, db, {
        serverId,
        scope: params.scope,
      })
      return failure ?? undefined
    })) ?? null
  )
}

export type ManagedExposureReconcileOutcome = {
  queuedServerIds: string[]
  failedServerIds: string[]
}

/**
 * Queue one ingress reconcile per fronting server so the new addresses reach
 * the hosts now, not whenever the next unrelated apply happens to run.
 */
export async function enqueueManagedExposureReconcile(
  c: Context,
  db: Db,
  commandQueue: CommandQueue,
  params: Readonly<{ serverIds: readonly string[]; userId: string }>
): Promise<ManagedExposureReconcileOutcome> {
  const secretsConfig = c.get('secretsConfig')
  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  if (!secretsConfig || !dataEncryptionSecrets) {
    return { queuedServerIds: [], failedServerIds: [...params.serverIds] }
  }
  const outcome: ManagedExposureReconcileOutcome = { queuedServerIds: [], failedServerIds: [] }
  await forEachSequential(params.serverIds, async (serverId) => {
    const result = await enqueueManagedIngressReconcile(db, commandQueue, {
      serverId,
      actorType: 'user',
      actorId: params.userId,
      secretsConfig,
      dataEncryptionSecrets,
    })
    if (result.ok) outcome.queuedServerIds.push(serverId)
    else if (result.reason !== 'not_needed') outcome.failedServerIds.push(serverId)
  })
  return outcome
}
