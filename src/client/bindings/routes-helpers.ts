/**
 * Pure helpers for the bindings API (prefix validation, collision detection).
 */

import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { binding, hosting, variable } from '../../lib/db/schema.ts'
import {
  assertSafeBindingKeyPrefix,
  DEFAULT_BINDING_KEY_PREFIX,
} from '../../lib/naming.ts'
import { listBindingEmittedKeys } from './materialize.ts'

export {
  assertSafeBindingKeyPrefix,
  DEFAULT_BINDING_KEY_PREFIX,
}

export const BINDING_KEY_PREFIX_IN_USE_ERROR = 'binding_key_prefix_in_use'
export const BINDING_ENGINE_DEFAULTS_IN_USE_ERROR = 'binding_engine_defaults_in_use'
export const BINDING_KEY_CONFLICT_ERROR = 'binding_key_conflict'
export const BINDING_ENDPOINT_UNAVAILABLE_ERROR = 'binding_endpoint_unavailable'

export type BindingListRow = {
  id: string
  principalId: string
  serviceId: string
  databaseName: string
  keyPrefix: string
  emitEngineDefaults: boolean
  createdAt: string
  updatedAt: string
  keys: string[]
  endpoint: { host: string; port: number } | null
  engine: string | null
  managedId: string | null
  managedEnvironmentId: string | null
  readSplit: boolean | null
}

/**
 * Parse + validate `keyPrefix` from a body field. Returns either the safe
 * prefix or an error code string (caller maps to HTTP status).
 */
export function parseBindingKeyPrefix(
  value: unknown,
): { ok: true; prefix: string } | { ok: false; error: string } {
  if (value === undefined || value === null || value === '') {
    return { ok: true, prefix: DEFAULT_BINDING_KEY_PREFIX }
  }
  if (typeof value !== 'string') {
    return { ok: false, error: 'Invalid request' }
  }
  try {
    return { ok: true, prefix: assertSafeBindingKeyPrefix(value) }
  } catch {
    return { ok: false, error: 'Invalid keyPrefix' }
  }
}

export function parseEmitEngineDefaults(
  value: unknown,
): { ok: true; value: boolean } | { ok: false; error: string } {
  if (value === undefined || value === null) {
    return { ok: true, value: true }
  }
  if (typeof value !== 'boolean') {
    return { ok: false, error: 'Invalid request' }
  }
  return { ok: true, value }
}

/**
 * True when any emitted key is already owned by a non-binding variable at
 * service or hosting scope for the target service.
 */
export async function findBindingKeyConflicts(
  db: Db,
  params: Readonly<{
    serviceId: string
    keys: readonly string[]
    /** Exclude this binding's own rows (PATCH). */
    excludeBindingId?: string
  }>,
): Promise<string | null> {
  if (params.keys.length === 0) return null

  const serviceConds = [
    eq(variable.serviceId, params.serviceId),
    inArray(variable.key, [...params.keys]),
  ]
  if (params.excludeBindingId) {
    serviceConds.push(
      or(
        sql`${variable.bindingId} IS NULL`,
        sql`${variable.bindingId} != ${params.excludeBindingId}`,
      )!,
    )
  } else {
    serviceConds.push(sql`${variable.bindingId} IS NULL`)
  }

  const [serviceHit] = await db
    .select({ key: variable.key })
    .from(variable)
    .where(and(...serviceConds))
    .limit(1)
  if (serviceHit) return serviceHit.key

  const hostingIds = await db
    .select({ id: hosting.id })
    .from(hosting)
    .where(eq(hosting.serviceId, params.serviceId))
  if (hostingIds.length === 0) return null

  const [hostingHit] = await db
    .select({ key: variable.key })
    .from(variable)
    .where(
      and(
        inArray(
          variable.hostingId,
          hostingIds.map((h) => h.id),
        ),
        inArray(variable.key, [...params.keys]),
      ),
    )
    .limit(1)
  return hostingHit?.key ?? null
}

/**
 * Check whether creating/updating a binding would collide with existing
 * user variables for the keys it will emit.
 */
export async function assertNoBindingKeyConflicts(
  db: Db,
  params: Readonly<{
    serviceId: string
    keyPrefix: string
    emitEngineDefaults: boolean
    engineCode: string
    excludeBindingId?: string
  }>,
): Promise<{ ok: true } | { ok: false; key: string }> {
  const keys = listBindingEmittedKeys({
    keyPrefix: params.keyPrefix,
    emitEngineDefaults: params.emitEngineDefaults,
    engineCode: params.engineCode,
  })
  if (!keys) return { ok: true }
  const conflict = await findBindingKeyConflicts(db, {
    serviceId: params.serviceId,
    keys,
    ...(params.excludeBindingId
      ? { excludeBindingId: params.excludeBindingId }
      : {}),
  })
  if (conflict) return { ok: false, key: conflict }
  return { ok: true }
}

export async function isPrefixInUse(
  db: Db,
  serviceId: string,
  keyPrefix: string,
  excludeBindingId?: string,
): Promise<boolean> {
  const conds = [
    eq(binding.serviceId, serviceId),
    eq(binding.keyPrefix, keyPrefix),
  ]
  if (excludeBindingId) {
    conds.push(sql`${binding.id} != ${excludeBindingId}`)
  }
  const [row] = await db
    .select({ id: binding.id })
    .from(binding)
    .where(and(...conds))
    .limit(1)
  return Boolean(row)
}

export async function isEngineDefaultsInUse(
  db: Db,
  serviceId: string,
  excludeBindingId?: string,
): Promise<boolean> {
  const conds = [
    eq(binding.serviceId, serviceId),
    eq(binding.emitEngineDefaults, true),
  ]
  if (excludeBindingId) {
    conds.push(sql`${binding.id} != ${excludeBindingId}`)
  }
  const [row] = await db
    .select({ id: binding.id })
    .from(binding)
    .where(and(...conds))
    .limit(1)
  return Boolean(row)
}

/**
 * Whether a user-created variable key conflicts with any binding on the
 * parent service (service or hosting parent).
 */
export async function isKeyOwnedByBindingOnService(
  db: Db,
  serviceId: string,
  key: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: variable.id })
    .from(variable)
    .where(
      and(
        eq(variable.serviceId, serviceId),
        eq(variable.key, key),
        isNotNull(variable.bindingId),
      ),
    )
    .limit(1)
  return Boolean(row)
}

export async function resolveServiceIdForHosting(
  db: Db,
  hostingId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ serviceId: hosting.serviceId })
    .from(hosting)
    .where(eq(hosting.id, hostingId))
    .limit(1)
  return row?.serviceId ?? null
}
