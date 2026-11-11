/** Request parsing and response shapes for the project cache routes. Pure. */

import type { CacheWithAccount } from '../../features/caches/store.ts'
import {
  CACHE_ACCESS,
  type CacheAccess,
  cacheMemoryCeilingMb,
  DEFAULT_CACHE_KEY_PREFIX,
  DEFAULT_CACHE_MEMORY_MB,
  MAX_CACHE_MEMORY_MB_API,
  MIN_CACHE_MEMORY_MB,
} from '../../features/caches/vocabulary.ts'
import { cacheVariableNames } from '../../features/caches/variables.ts'

export type CacheRequestError = { error: string; message: string; status: 400 | 409 | 422 }

const NAME_RE = /^[a-z][a-z0-9-]{0,62}$/
const PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type CacheCreateInput = {
  name: string
  principalId: string
  access: CacheAccess
  maxMemoryMb: number
  keyPrefix: string
}

export type CachePatchInput = Partial<
  Pick<CacheCreateInput, 'access' | 'maxMemoryMb' | 'keyPrefix'>
>

function bad(error: string, message: string): CacheRequestError {
  return { error, message, status: 400 }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The engine and series are fixed; a body that names another is refused. */
function engineError(body: Record<string, unknown>): CacheRequestError | null {
  if (body.engine !== undefined && body.engine !== 'valkey') {
    return bad('engine_unavailable', 'Not available yet')
  }
  if (body.version !== undefined && body.version !== '8.1') {
    return bad('version_unavailable', 'Only Valkey 8.1 is available')
  }
  return null
}

function parseAccess(value: unknown): CacheAccess | CacheRequestError {
  if (typeof value === 'string' && (CACHE_ACCESS as readonly string[]).includes(value)) {
    return value as CacheAccess
  }
  return bad('invalid_access', 'Access must be socket or port')
}

function parseMemory(value: unknown): number | CacheRequestError {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < MIN_CACHE_MEMORY_MB ||
    value > MAX_CACHE_MEMORY_MB_API
  ) {
    return bad(
      'invalid_memory',
      `Memory limit must be a whole number of MiB from ${MIN_CACHE_MEMORY_MB} to ${MAX_CACHE_MEMORY_MB_API}`
    )
  }
  return value
}

function parsePrefix(value: unknown): string | CacheRequestError {
  if (typeof value !== 'string' || !PREFIX_RE.test(value)) {
    return bad(
      'invalid_prefix',
      'Variable prefix must start with a letter or underscore and use letters, digits and underscores'
    )
  }
  return value
}

function isError(value: unknown): value is CacheRequestError {
  return isRecord(value) && typeof value.error === 'string' && typeof value.status === 'number'
}

export function parseCacheCreateBody(body: unknown): CacheCreateInput | CacheRequestError {
  if (!isRecord(body)) return bad('invalid_request', 'Invalid request')
  const engine = engineError(body)
  if (engine) return engine
  if (typeof body.name !== 'string' || !NAME_RE.test(body.name)) {
    return bad(
      'invalid_name',
      'Name must be lower case letters, digits and dashes, starting with a letter'
    )
  }
  if (typeof body.principalId !== 'string' || !UUID_RE.test(body.principalId)) {
    return bad('invalid_principal', 'Choose a Hosting Account')
  }
  const access = body.access === undefined ? 'socket' : parseAccess(body.access)
  if (isError(access)) return access
  const maxMemoryMb =
    body.maxMemoryMb === undefined ? DEFAULT_CACHE_MEMORY_MB : parseMemory(body.maxMemoryMb)
  if (isError(maxMemoryMb)) return maxMemoryMb
  const keyPrefix =
    body.keyPrefix === undefined ? DEFAULT_CACHE_KEY_PREFIX : parsePrefix(body.keyPrefix)
  if (isError(keyPrefix)) return keyPrefix
  return { name: body.name, principalId: body.principalId, access, maxMemoryMb, keyPrefix }
}

export function parseCachePatchBody(body: unknown): CachePatchInput | CacheRequestError {
  if (!isRecord(body)) return bad('invalid_request', 'Invalid request')
  const engine = engineError(body)
  if (engine) return engine
  const out: CachePatchInput = {}
  if (body.access !== undefined) {
    const access = parseAccess(body.access)
    if (isError(access)) return access
    out.access = access
  }
  if (body.maxMemoryMb !== undefined) {
    const mb = parseMemory(body.maxMemoryMb)
    if (isError(mb)) return mb
    out.maxMemoryMb = mb
  }
  if (body.keyPrefix !== undefined) {
    const prefix = parsePrefix(body.keyPrefix)
    if (isError(prefix)) return prefix
    out.keyPrefix = prefix
  }
  if (Object.keys(out).length === 0) return bad('invalid_request', 'Nothing to change')
  return out
}

/** `deleteData` defaults on; only an explicit false keeps the data. */
export function parseDeleteData(raw: string | undefined): boolean {
  return raw === undefined ? true : !['false', '0', 'no'].includes(raw.toLowerCase())
}

/** The refusal when the unit ceiling would exceed the account's memory ceiling, else null. */
export function memoryCeilingError(
  maxMemoryMb: number,
  limits: { memoryBytes?: number } | undefined
): CacheRequestError | null {
  if (limits?.memoryBytes === undefined) return null
  const needed = cacheMemoryCeilingMb(maxMemoryMb) * 1024 * 1024
  if (needed <= limits.memoryBytes) return null
  const allowedMb = Math.max(0, Math.floor((limits.memoryBytes / (1024 * 1024) - 32) / 2))
  return {
    error: 'cache_memory_over_ceiling',
    message: `This Hosting Account may use less memory than that. Choose ${allowedMb} MiB or less.`,
    status: 422,
  }
}

export type CacheView = {
  id: string
  name: string
  engine: string
  version: string
  status: string
  access: string
  port: number | null
  maxMemoryMb: number
  keyPrefix: string
  principalId: string
  hostingAccount: string
  serverId: string
  variables: string[]
  runtimeVersion: string | null
  lastError: string | null
  appliedAt: string | null
  createdAt: string
}

function metaString(metadata: unknown, key: string): string | null {
  if (!isRecord(metadata)) return null
  const value = metadata[key]
  return typeof value === 'string' ? value : null
}

/** What the API shows for a cache. The password is never part of it. */
export function cacheView(row: CacheWithAccount): CacheView {
  return {
    id: row.id,
    name: row.name,
    engine: row.engine,
    version: row.version,
    status: row.status,
    access: row.access,
    port: row.port,
    maxMemoryMb: row.maxMemoryMb,
    keyPrefix: row.keyPrefix,
    principalId: row.principalId,
    hostingAccount: row.username,
    serverId: row.serverId,
    variables: cacheVariableNames(row.keyPrefix, row.access === 'port' ? 'port' : 'socket'),
    runtimeVersion: metaString(row.metadata, 'runtimeVersion'),
    lastError: metaString(row.metadata, 'lastError'),
    appliedAt: metaString(row.metadata, 'appliedAt'),
    createdAt: row.createdAt,
  }
}
