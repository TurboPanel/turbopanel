/** Fixtures for the project cache host-free tests. Test only. */

import { encryptSecret } from '../../lib/secrets/data-encryption.ts'
import {
  type DerivedSecretsConfig,
  deriveEncryptionSecretsConfig,
  parseSecretsEnv,
} from '../../lib/secrets/secrets.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'
import type { CacheWithAccount } from './store.ts'

export const CACHE_A = '00000000-0000-4000-8000-00000000ca01'
export const CACHE_B = '00000000-0000-4000-8000-00000000ca02'
export const PRINCIPAL_A = '00000000-0000-4000-8000-0000000000a1'
export const PRINCIPAL_B = '00000000-0000-4000-8000-0000000000b1'
export const SERVER_1 = '00000000-0000-4000-8000-000000000501'
export const SERVER_2 = '00000000-0000-4000-8000-000000000502'
export const ENV_1 = '00000000-0000-4000-8000-000000000e01'

export function deriveTestSecrets(): Promise<DerivedSecretsConfig> {
  return deriveEncryptionSecretsConfig(
    parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno'),
    'data-encryption'
  )
}

/** A cache row with a sealed fixture password (`fixture-password`). */
export async function cacheRowFixture(
  secrets: DerivedSecretsConfig,
  overrides: Partial<CacheWithAccount> = {}
): Promise<CacheWithAccount> {
  return {
    id: CACHE_A,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    metadata: null,
    environmentId: ENV_1,
    serverId: SERVER_1,
    principalId: PRINCIPAL_A,
    name: 'app-cache',
    engine: 'valkey',
    status: 'pending',
    version: '8.1',
    access: 'socket',
    port: null,
    maxMemoryMb: 64,
    keyPrefix: 'REDIS',
    password: await encryptSecret(secrets, 'fixture-password'),
    username: 'siteowner',
    ...overrides,
  }
}
