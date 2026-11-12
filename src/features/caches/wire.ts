/** Rows of the `cache` table as the daemon takes them (`EnvironmentDeployCache`). */

import type { EnvironmentDeployCache } from '../../contracts/commands/schemas.ts'
import { sha256HexUtf8 } from '../compose/desired-hash.ts'
import { decryptSecret } from '../../lib/secrets/data-encryption.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import type { CacheWithAccount } from './store.ts'

type WireLimits = EnvironmentDeployCache['accountLimits']

/**
 * The wire entry of one cache. The host learns only the SHA-256 of the login
 * password (the UTF-8 text the app sends). Without data-encryption keys (a
 * preview) the hash is of the sealed text, which only has to be well-formed.
 */
export async function cacheWireEntry(
  row: CacheWithAccount,
  secrets: DerivedSecretsConfig | undefined,
  accountLimits: WireLimits
): Promise<EnvironmentDeployCache> {
  const password = secrets === undefined ? row.password : await decryptSecret(secrets, row.password)
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    engine: 'valkey',
    version: row.version,
    access: row.access === 'port' ? 'port' : 'socket',
    ...(row.access === 'port' && row.port !== null ? { port: row.port } : {}),
    maxMemoryMb: row.maxMemoryMb,
    passwordSha256: await sha256HexUtf8(password),
    ...(accountLimits === undefined ? {} : { accountLimits }),
  }
}

/** The complete wire set for the caches placed on one server, by name. */
export async function cacheWireSet(
  rows: readonly CacheWithAccount[],
  serverId: string,
  secrets: DerivedSecretsConfig | undefined,
  accountLimits: WireLimits
): Promise<EnvironmentDeployCache[]> {
  const here = rows.filter((row) => row.serverId === serverId)
  return await Promise.all(here.map((row) => cacheWireEntry(row, secrets, accountLimits)))
}
