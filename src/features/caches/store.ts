/**
 * Reads and writes of the `cache` table (project caches).
 *
 * Workers rule: every function here uses the `db` it is handed (the request's
 * own client) and keeps nothing between calls.
 */

import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { cache, environment, principal } from '../../db/schema.ts'
import { isPostgresUniqueViolation, uniqueViolationMessage } from '../../db/unique-violation.ts'
import { allocateSiteListenPort } from '../compose/site.ts'
import { CACHE_PORT_MAX, CACHE_PORT_MIN, type CacheStatus } from './vocabulary.ts'

export type CacheRow = typeof cache.$inferSelect

export type CacheInsert = {
  environmentId: string
  serverId: string
  principalId: string
  name: string
  version: string
  access: 'socket' | 'port'
  port: number | null
  maxMemoryMb: number
  keyPrefix: string
  /** Sealed `tpsecret` envelope of the login password. */
  password: string
}

/** A cache row with the applied Linux name of its Hosting Account. */
export type CacheWithAccount = CacheRow & { username: string }

/** Every cache of an environment, by name. */
export async function listEnvironmentCaches(
  db: Db,
  environmentId: string
): Promise<CacheWithAccount[]> {
  const rows = await db
    .select({ row: cache, username: principal.appliedUsername })
    .from(cache)
    .innerJoin(principal, eq(principal.id, cache.principalId))
    .where(eq(cache.environmentId, environmentId))
    .orderBy(asc(cache.name))
  return rows.map((entry) => ({ ...entry.row, username: entry.username }))
}

/** One cache of an environment, or null. */
export async function getEnvironmentCache(
  db: Db,
  environmentId: string,
  cacheId: string
): Promise<CacheWithAccount | null> {
  const rows = await db
    .select({ row: cache, username: principal.appliedUsername })
    .from(cache)
    .innerJoin(principal, eq(principal.id, cache.principalId))
    .where(and(eq(cache.environmentId, environmentId), eq(cache.id, cacheId)))
    .limit(1)
  const found = rows[0]
  return found ? { ...found.row, username: found.username } : null
}

/** Caches by id (any environment), for variable delivery. */
export async function listCachesByIds(
  db: Db,
  cacheIds: readonly string[]
): Promise<CacheWithAccount[]> {
  if (cacheIds.length === 0) return []
  const rows = await db
    .select({ row: cache, username: principal.appliedUsername })
    .from(cache)
    .innerJoin(principal, eq(principal.id, cache.principalId))
    .where(inArray(cache.id, [...cacheIds]))
    .orderBy(asc(cache.name))
  return rows.map((entry) => ({ ...entry.row, username: entry.username }))
}

/**
 * Loopback ports caches hold on each server (all environments). A new
 * allocation of any host-native lane probes past these.
 */
export async function listServerCachePorts(
  db: Pick<Db, 'select'>,
  serverIds: readonly string[]
): Promise<Map<string, Set<number>>> {
  const byServer = new Map<string, Set<number>>()
  if (serverIds.length === 0) return byServer
  const rows = await db
    .select({ serverId: cache.serverId, port: cache.port })
    .from(cache)
    .where(and(inArray(cache.serverId, [...serverIds]), isNotNull(cache.port)))
  for (const row of rows) {
    if (row.port === null) continue
    const ports = byServer.get(row.serverId) ?? new Set<number>()
    ports.add(row.port)
    byServer.set(row.serverId, ports)
  }
  return byServer
}

/** A free loopback port in the listen band for a cache, avoiding every port in `used`. */
export function allocateCachePort(cacheKey: string, used: Set<number>, uniqueKey: string): number {
  const port = allocateSiteListenPort(`cache:${cacheKey}`, used, undefined, uniqueKey)
  if (port < CACHE_PORT_MIN || port > CACHE_PORT_MAX) {
    throw new RangeError('cache port outside the listen band')
  }
  return port
}

export type CacheInsertOutcome =
  { ok: true; row: CacheRow } | { ok: false; reason: 'name_taken' | 'prefix_taken' | 'port_taken' }

/** Insert one row; a unique-index clash comes back as a reason, anything else throws. */
export async function insertCache(db: Db, values: CacheInsert): Promise<CacheInsertOutcome> {
  try {
    const [row] = await db.insert(cache).values(values).returning()
    if (!row) throw new Error('cache insert returned no row')
    return { ok: true, row }
  } catch (err) {
    return classifyInsertFailure(err)
  }
}

/** The unique index a clash names, as a reason; rethrows an error that is not a clash. */
export function classifyInsertFailure(err: unknown): { ok: false; reason: CacheClash } {
  if (!isPostgresUniqueViolation(err)) throw err
  const message = uniqueViolationMessage(err) ?? ''
  if (message.includes('uniq_cache_environment_name')) return { ok: false, reason: 'name_taken' }
  if (message.includes('uniq_cache_environment_principal_prefix')) {
    return { ok: false, reason: 'prefix_taken' }
  }
  return { ok: false, reason: 'port_taken' }
}

export type CacheClash = 'name_taken' | 'prefix_taken' | 'port_taken'

export type CachePatch = Partial<
  Pick<CacheRow, 'access' | 'port' | 'maxMemoryMb' | 'keyPrefix' | 'status' | 'metadata'>
>

/** Update one row; a unique-index clash comes back as a reason. */
export async function updateCache(
  db: Pick<Db, 'update'>,
  cacheId: string,
  patch: CachePatch
): Promise<{ ok: true } | { ok: false; reason: CacheClash }> {
  try {
    await db.update(cache).set(patch).where(eq(cache.id, cacheId))
    return { ok: true }
  } catch (err) {
    return classifyInsertFailure(err)
  }
}

export async function deleteCacheRow(db: Pick<Db, 'delete'>, cacheId: string): Promise<void> {
  await db.delete(cache).where(eq(cache.id, cacheId))
}

/** Set the status of caches (only those ids), optionally merging apply metadata. */
export async function setCacheStatus(
  db: Pick<Db, 'update'>,
  cacheIds: readonly string[],
  status: CacheStatus
): Promise<void> {
  if (cacheIds.length === 0) return
  await db
    .update(cache)
    .set({ status })
    .where(inArray(cache.id, [...cacheIds]))
}

/** Number of caches an environment has on each server, for the server's removal checks. */
export async function countEnvironmentCaches(db: Pick<Db, 'select'>, environmentId: string) {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(cache)
    .where(eq(cache.environmentId, environmentId))
  return row?.total ?? 0
}

/** The server an environment is placed on, or null. */
export async function readEnvironmentServerId(
  db: Pick<Db, 'select'>,
  environmentId: string
): Promise<string | null> {
  const [row] = await db
    .select({ serverId: environment.serverId })
    .from(environment)
    .where(eq(environment.id, environmentId))
    .limit(1)
  return row?.serverId ?? null
}
