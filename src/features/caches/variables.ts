/**
 * The variables a project cache delivers to the sites and apps of its Hosting
 * Account. They are computed, never stored: `reapplyCacheVariables` sets them
 * on a resolved map after binding output and database references, at every
 * place a service's variables are resolved (deploy prepare, the hosting web
 * environment, secret rehydrate).
 */

import type { Db } from '../../db/connection.ts'
import { decryptSecret, encryptSecret } from '../../lib/secrets/data-encryption.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import type { ResolvedVariableEntry, ResolvedVariableMap } from '../variables/resolve-inherited.ts'
import { listCachesByIds, type CacheWithAccount } from './store.ts'
import { CACHE_LOGIN_USERNAME, cacheSocketPath } from './vocabulary.ts'

/** The suffixes a cache sets under its prefix, in display order. */
export const CACHE_VARIABLE_SUFFIXES = [
  'HOST',
  'PORT',
  'SOCKET',
  'USERNAME',
  'PASSWORD',
  'URL',
] as const

type VariableCache = Pick<CacheWithAccount, 'id' | 'access' | 'port' | 'keyPrefix' | 'password'>

/** Names a cache delivers, for one access mode. */
export function cacheVariableNames(prefix: string, access: 'socket' | 'port'): string[] {
  const suffixes = CACHE_VARIABLE_SUFFIXES.filter((suffix) =>
    access === 'socket' ? suffix !== 'URL' : suffix !== 'SOCKET'
  )
  return suffixes.map((suffix) => `${prefix}_${suffix}`)
}

function literal(value: string, isSecret = false): ResolvedVariableEntry {
  return { value, isSecret, isLiteral: true, forBuild: false, forRuntime: true, bindingId: null }
}

/**
 * The entries one cache delivers. `urlEnvelope` is the sealed connection URL of
 * a port cache (the caller seals it, so this stays pure); without one no URL
 * name is set. The password entry carries the stored envelope untouched.
 */
export function cacheVariableMap(
  row: VariableCache,
  urlEnvelope: string | undefined
): ResolvedVariableMap {
  const prefix = row.keyPrefix
  const map: ResolvedVariableMap = new Map()
  if (row.access === 'socket') {
    map.set(`${prefix}_HOST`, literal(cacheSocketPath(row.id)))
    map.set(`${prefix}_PORT`, literal('0'))
    map.set(`${prefix}_SOCKET`, literal(cacheSocketPath(row.id)))
  } else {
    map.set(`${prefix}_HOST`, literal('127.0.0.1'))
    map.set(`${prefix}_PORT`, literal(String(row.port ?? 0)))
  }
  map.set(`${prefix}_USERNAME`, literal(CACHE_LOGIN_USERNAME))
  map.set(`${prefix}_PASSWORD`, literal(row.password, true))
  if (row.access === 'port' && urlEnvelope !== undefined) {
    map.set(`${prefix}_URL`, literal(urlEnvelope, true))
  }
  return map
}

/** The plain connection URL of a port cache. Generated passwords are URL-safe. */
export function cacheConnectionUrl(port: number, password: string): string {
  return `redis://${CACHE_LOGIN_USERNAME}:${password}@127.0.0.1:${port}`
}

async function sealUrl(
  secrets: DerivedSecretsConfig | undefined,
  row: VariableCache
): Promise<string | undefined> {
  if (secrets === undefined || row.access !== 'port' || row.port === null) return undefined
  const password = await decryptSecret(secrets, row.password)
  return await encryptSecret(secrets, cacheConnectionUrl(row.port, password))
}

export type CacheVariableWarning = { code: 'cache_variable_overrides'; key: string }

/**
 * Set the cache entries for `cacheIds` on `map`, after everything else. A name
 * that was already set by an inherited scope is overridden, with a warning that
 * names the key only.
 */
export async function reapplyCacheVariables(
  db: Db,
  secrets: DerivedSecretsConfig | undefined,
  cacheIds: readonly string[],
  map: ResolvedVariableMap,
  warnings?: CacheVariableWarning[]
): Promise<void> {
  const rows = await listCachesByIds(db, cacheIds)
  await applyCacheRows(secrets, rows, map, warnings)
}

/** The pure-ish half of {@link reapplyCacheVariables}: rows already loaded. */
export async function applyCacheRows(
  secrets: DerivedSecretsConfig | undefined,
  rows: readonly VariableCache[],
  map: ResolvedVariableMap,
  warnings?: CacheVariableWarning[]
): Promise<void> {
  await forEachSequential(rows, async (row) => {
    const entries = cacheVariableMap(row, await sealUrl(secrets, row))
    for (const [key, entry] of entries) {
      if (map.has(key)) warnings?.push({ code: 'cache_variable_overrides', key })
      map.set(key, entry)
    }
  })
}
