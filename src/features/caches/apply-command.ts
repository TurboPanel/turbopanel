/**
 * Queue `cache.apply` for one environment: the complete set its caches have on
 * its server, plus the caches to remove. Only sent to a daemon that lists
 * `project-cache-v1`; the routes check that first.
 */

import type { Db } from '../../db/connection.ts'
import {
  parseCacheApplyPayload,
  type CacheApplyCommandPayload,
} from '../../contracts/commands/schemas.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import { createCommandRecord, transitionCommand } from '../commands/command-records.ts'
import type { CommandEnvelope } from '../commands/envelope.ts'
import { isNoopCommandQueue } from '../commands/noop-command-queue.ts'
import type { CommandQueue } from '../commands/queue.ts'
import { listEnvironmentCaches, setCacheStatus } from './store.ts'
import { cacheWireSet } from './wire.ts'
import { CACHE_APPLY_COMMAND } from './feature.ts'

export type CacheRemoval = { id: string; username: string; deleteData: boolean }

export type CacheApplyActor = { actorType: 'user' | 'system'; actorId: string }

export type CacheApplyDeps = {
  queue: CommandQueue | undefined
  secrets: DerivedSecretsConfig | undefined
  accountLimits: Parameters<typeof cacheWireSet>[3]
}

export type CacheApplyOutcome =
  { queued: true; commandId: string } | { queued: false; reason: string }

/** Build the payload for `serverId`, parsed by the contract parser so a set the host would refuse is never queued. */
export async function buildCacheApplyPayload(
  db: Db,
  params: { environmentId: string; serverId: string; removed: readonly CacheRemoval[] },
  deps: Pick<CacheApplyDeps, 'secrets' | 'accountLimits'>
): Promise<CacheApplyCommandPayload> {
  const rows = await listEnvironmentCaches(db, params.environmentId)
  const caches = await cacheWireSet(rows, params.serverId, deps.secrets, deps.accountLimits)
  return parseCacheApplyPayload({
    environmentId: params.environmentId,
    caches,
    ...(params.removed.length > 0 ? { removed: params.removed } : {}),
  })
}

/** Queue one `cache.apply`; marks the environment's caches on that server `applying`. Never throws. */
export async function enqueueCacheApply(
  db: Db,
  actor: CacheApplyActor,
  params: { environmentId: string; serverId: string; removed: readonly CacheRemoval[] },
  deps: CacheApplyDeps
): Promise<CacheApplyOutcome> {
  const queue = deps.queue
  if (!queue || isNoopCommandQueue(queue))
    return { queued: false, reason: 'Command queue unavailable' }
  try {
    const payload = await buildCacheApplyPayload(db, params, deps)
    const record = await createCommandRecord(db, {
      serverId: params.serverId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      type: CACHE_APPLY_COMMAND,
      payload,
    })
    await setCacheStatus(
      db,
      payload.caches.map((entry) => entry.id),
      'applying'
    )
    const envelope: CommandEnvelope = {
      commandId: record.id,
      serverId: params.serverId,
      type: CACHE_APPLY_COMMAND,
      attempt: 1,
      queuedAt: record.queuedAt ?? record.createdAt,
    }
    try {
      await queue.enqueue(envelope)
    } catch {
      await transitionCommand(db, record.id, {
        status: 'failed',
        error: 'Failed to enqueue cache apply',
      })
      await setCacheStatus(
        db,
        payload.caches.map((entry) => entry.id),
        'failed'
      )
      return { queued: false, reason: 'Failed to enqueue cache apply' }
    }
    return { queued: true, commandId: record.id }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error'
    compatLogWarn(
      'caches',
      `cache apply for environment ${params.environmentId} failed: ${message}`
    )
    return { queued: false, reason: 'Could not build the cache set' }
  }
}
