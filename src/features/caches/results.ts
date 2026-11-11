/**
 * What a host reports about caches (`cache.apply` result, or the `caches` of an
 * `environment.deploy` result) becomes `cache.status` and `cache.metadata`.
 * Only ids the command itself carried are touched: a host never writes a row it
 * was not asked about.
 */

import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { cache } from '../../db/schema.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import {
  parseCacheApplyPayload,
  parseCacheApplyResult,
  parseEnvironmentDeployPayload,
  parseEnvironmentDeployResult,
  parseEnvironmentStopPayload,
  type CacheApplyResult,
} from '../../contracts/commands/schemas.ts'
import { CACHE_APPLY_COMMAND } from './feature.ts'
import type { CacheStatus } from './vocabulary.ts'

type CommandRecordLike = { id: string; type: string; payload: unknown }

const STATE_TO_STATUS: Record<CacheApplyResult['state'], CacheStatus> = {
  ready: 'ready',
  failed: 'failed',
  pending: 'pending',
}

/** Row patch for one reported result. */
export function cacheResultPatch(
  result: CacheApplyResult,
  appliedAt: string
): { status: CacheStatus; metadata: Record<string, string> } {
  return {
    status: STATE_TO_STATUS[result.state],
    metadata: {
      appliedAt,
      ...(result.runtimeVersion === undefined ? {} : { runtimeVersion: result.runtimeVersion }),
      ...(result.error === undefined ? {} : { lastError: result.error }),
    },
  }
}

/** Write each reported result whose id is in `allowed`. */
export async function writeCacheResults(
  db: Db,
  results: readonly CacheApplyResult[],
  allowed: ReadonlySet<string>,
  appliedAt: string
): Promise<number> {
  const wanted = results.filter((result) => allowed.has(result.id))
  await forEachSequential(wanted, (result) =>
    db.update(cache).set(cacheResultPatch(result, appliedAt)).where(eq(cache.id, result.id))
  )
  return wanted.length
}

/** Succeeded `cache.apply` or `environment.deploy`: write the reported caches. */
export async function applyCacheResultSideEffect(
  db: Db,
  record: CommandRecordLike,
  result: unknown
): Promise<void> {
  try {
    if (record.type === CACHE_APPLY_COMMAND) {
      const sent = parseCacheApplyPayload(record.payload)
      await writeCacheResults(
        db,
        parseCacheApplyResult(result).caches,
        new Set(sent.caches.map((entry) => entry.id)),
        new Date().toISOString()
      )
      // A listed cache the host did not mention is not trusted as ready.
      return
    }
    if (record.type === 'environment.stop') {
      // The host removed the units; the rows stay, and the next deploy starts them again.
      const { environmentId } = parseEnvironmentStopPayload(record.payload)
      await db
        .update(cache)
        .set({ status: 'stopped' })
        .where(eq(cache.environmentId, environmentId))
      return
    }
    if (record.type !== 'environment.deploy') return
    const sentCaches = parseEnvironmentDeployPayload(record.payload).caches
    if (sentCaches === undefined || sentCaches.length === 0) return
    await writeCacheResults(
      db,
      parseEnvironmentDeployResult(result).caches ?? [],
      new Set(sentCaches.map((entry) => entry.id)),
      new Date().toISOString()
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error'
    compatLogWarn('caches', `cache result side effect failed for command ${record.id}: ${message}`)
  }
}

/** A failed or timed-out `cache.apply`: the caches it carried that are still `applying` become `failed`. */
export async function applyCacheFailureSideEffect(
  db: Db,
  record: CommandRecordLike,
  error: string
): Promise<void> {
  if (record.type !== CACHE_APPLY_COMMAND) return
  try {
    const sent = parseCacheApplyPayload(record.payload)
    const ids = sent.caches.map((entry) => entry.id)
    if (ids.length === 0) return
    await db
      .update(cache)
      .set({
        status: 'failed',
        metadata: { appliedAt: new Date().toISOString(), lastError: error.slice(0, 500) },
      })
      .where(and(inArray(cache.id, ids), eq(cache.status, 'applying')))
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error'
    compatLogWarn('caches', `cache failure side effect failed for command ${record.id}: ${message}`)
  }
}
