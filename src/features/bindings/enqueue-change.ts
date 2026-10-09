/**
 * After a binding create/update/delete, publish or tear down the engine
 * private listener (`managed.apply`) then refresh ProxySQL
 * (`managed.ingress.reconcile`). Apply always runs first so ingress never
 * emits frontend users against a listener that is not on the wire yet.
 */

import type { Context } from 'hono'
import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { managed, slot } from '../../db/schema.ts'
import { isNoopCommandQueue } from '../commands/noop-command-queue.ts'
import { getCommandQueue } from '../commands/queue.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import {
  enqueuePreparedManagedApply,
  isPrepareError,
  prepareManagedApplyPayloads,
} from '../managed/apply-prepare.ts'
import { enqueueManagedIngressReconcile } from '../managed/ingress-desired.ts'
import { getManagedEngineSpec } from '../managed/index.ts'
import { parseManagedRowOptions } from '../managed/options.ts'
import { parseManagedResidual } from '../managed/serialize.ts'
import {
  consumerServerIdsForManaged,
  loadServicePlacementServerId,
  memberServerIdsForManaged,
} from './resolve-endpoint.ts'
import { hasRemoteConsumerServers } from './remote-consumers.ts'

export type BindingListenerSync = {
  c: Context
  actorId: string
  organizationId: string
}

export type EnqueueBindingChangeParams = Readonly<{
  serviceIds: readonly string[]
  managedId: string
  actorId: string
  organizationId: string
  /**
   * When false, skip `managed.apply` (a PATCH that only renamed keys does not
   * change consumer hosts). Ingress reconcile still runs.
   */
  apply?: boolean
}>

export type BindingChangePlan = {
  apply: boolean
  ingressServerIds: string[]
}

/** Returned on binding create/update/delete when listener sync is incomplete. */
export type BindingListenerSyncOutcome = Readonly<{
  warning?: string
}>

export const BINDING_PRIVATE_LISTENER_PENDING_WARNING =
  'The binding was saved, but the database could not publish its private listener yet; the next managed apply or binding change will retry.'

export type BindingManagedApplyEnqueueStatus = 'enqueued' | 'failed' | 'skipped'

/** When apply was required but did not enqueue, ingress must not run ahead of the listener. */
export function bindingListenerSyncWarning(
  plan: Pick<BindingChangePlan, 'apply'>,
  applyStatus: BindingManagedApplyEnqueueStatus
): string | undefined {
  if (!plan.apply) return undefined
  if (applyStatus === 'enqueued') return undefined
  return BINDING_PRIVATE_LISTENER_PENDING_WARNING
}

/** Hosts this service may run on: env pin / project default, plus any slot. */
export async function loadServiceConsumerServerIds(db: Db, serviceId: string): Promise<string[]> {
  const ids = new Set<string>()
  const placement = await loadServicePlacementServerId(db, serviceId)
  if (placement) ids.add(placement)
  const tasks = await db
    .select({ serverId: slot.serverId })
    .from(slot)
    .where(eq(slot.serviceId, serviceId))
  for (const row of tasks) {
    if (row.serverId) ids.add(row.serverId)
  }
  return [...ids]
}

/**
 * Apply when remaining consumers or the services in this change still need a
 * private listener (including a slot-only remote host). `apply: false` skips it.
 */
export function planBindingChangeCommands(
  params: Readonly<{
    memberServerIds: readonly string[]
    remainingConsumerServerIds: readonly string[]
    affectedConsumerServerIds: readonly string[]
    ingressServerIds: readonly string[]
    apply: boolean
  }>
): BindingChangePlan {
  const apply =
    params.apply &&
    (hasRemoteConsumerServers(params.memberServerIds, params.remainingConsumerServerIds) ||
      hasRemoteConsumerServers(params.memberServerIds, params.affectedConsumerServerIds))
  return {
    apply,
    ingressServerIds: [...new Set(params.ingressServerIds.filter((id) => id.length > 0))],
  }
}

export async function enqueueIngressForBindingChange(
  c: Context,
  db: Db,
  params: EnqueueBindingChangeParams
): Promise<BindingListenerSyncOutcome> {
  const secretsConfig = c.get('secretsConfig')
  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  const commandQueue = getCommandQueue(c)
  if (
    !secretsConfig ||
    !dataEncryptionSecrets ||
    !commandQueue ||
    isNoopCommandQueue(commandQueue)
  ) {
    return {}
  }

  const ingressServerIds = new Set<string>()
  const affectedHosts: string[] = []
  for (const serviceId of params.serviceIds) {
    const hosts = await loadServiceConsumerServerIds(db, serviceId)
    for (const host of hosts) {
      ingressServerIds.add(host)
      affectedHosts.push(host)
    }
  }
  const memberServerIds = await memberServerIdsForManaged(db, params.managedId)
  for (const memberServerId of memberServerIds) {
    ingressServerIds.add(memberServerId)
  }

  const remainingConsumers = await consumerServerIdsForManaged(db, params.managedId)
  const plan = planBindingChangeCommands({
    memberServerIds,
    remainingConsumerServerIds: remainingConsumers,
    affectedConsumerServerIds: affectedHosts,
    ingressServerIds: [...ingressServerIds],
    apply: params.apply !== false,
  })

  let applyStatus: BindingManagedApplyEnqueueStatus = 'skipped'
  if (plan.apply) {
    try {
      applyStatus = await enqueueApplyForBindingManaged(c, db, {
        actorId: params.actorId,
        organizationId: params.organizationId,
        managedId: params.managedId,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      compatLogWarn(
        'bindings',
        `managed.apply after remote binding change failed for ${params.managedId}: ${message}`
      )
      applyStatus = 'failed'
    }
  }

  const warning = bindingListenerSyncWarning(plan, applyStatus)
  if (warning) {
    return { warning }
  }

  await forEachSequential(plan.ingressServerIds, async (serverId) => {
    try {
      await enqueueManagedIngressReconcile(db, commandQueue, {
        serverId,
        actorType: 'user',
        actorId: params.actorId,
        secretsConfig,
        dataEncryptionSecrets,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      compatLogWarn(
        'bindings',
        `managed.ingress.reconcile after binding change failed for ${serverId}: ${message}`
      )
    }
  })
  return {}
}

async function enqueueApplyForBindingManaged(
  c: Context,
  db: Db,
  params: Readonly<{
    actorId: string
    organizationId: string
    managedId: string
  }>
): Promise<BindingManagedApplyEnqueueStatus> {
  const commandQueue = getCommandQueue(c)
  if (!commandQueue || isNoopCommandQueue(commandQueue)) return 'skipped'

  const [row] = await db
    .select({
      id: managed.id,
      environmentId: managed.environmentId,
      serverId: managed.serverId,
      engine: managed.engine,
      metadata: managed.metadata,
      options: managed.options,
    })
    .from(managed)
    .where(eq(managed.id, params.managedId))
    .limit(1)
  if (!row?.serverId || !row.engine) {
    compatLogWarn(
      'bindings',
      `managed.apply after binding change skipped for ${params.managedId}: cluster is missing`
    )
    return 'failed'
  }

  const spec = getManagedEngineSpec(row.engine)
  if (!spec) {
    compatLogWarn(
      'bindings',
      `managed.apply after binding change skipped for ${params.managedId}: engine is unknown`
    )
    return 'failed'
  }
  const parsed = parseManagedRowOptions(spec, row.options)
  if (!parsed) {
    compatLogWarn(
      'bindings',
      `managed.apply after binding change skipped for ${params.managedId}: settings are invalid`
    )
    return 'failed'
  }

  const residual = parseManagedResidual(row.metadata)
  const prepared = await prepareManagedApplyPayloads(c, db, {
    managedRow: row,
    spec,
    settings: parsed.settings,
    databases: parsed.databases,
    serverId: row.serverId,
    environmentId: row.environmentId,
    organizationId: params.organizationId,
    rootUsername: residual.rootUsername ?? spec.rootUsername,
  })
  if (isPrepareError(prepared)) {
    compatLogWarn(
      'bindings',
      `managed.apply after binding change failed for ${params.managedId}: ${prepared.kind}`
    )
    return 'failed'
  }

  const enqueued = await enqueuePreparedManagedApply(c, db, commandQueue, {
    userId: params.actorId,
    managedId: row.id,
    members: prepared.members,
  })
  if (enqueued instanceof Response) {
    compatLogWarn(
      'bindings',
      `managed.apply after binding change failed for ${params.managedId}: command queue unavailable`
    )
    return 'failed'
  }
  if (enqueued.length === 0 || enqueued.some((entry) => entry.status === 'failed')) {
    compatLogWarn(
      'bindings',
      `managed.apply after binding change failed for ${params.managedId}: enqueue returned no queued commands`
    )
    return 'failed'
  }
  return 'enqueued'
}
