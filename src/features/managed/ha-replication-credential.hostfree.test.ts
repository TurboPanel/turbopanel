import { assert, assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import { ENVELOPE_PREFIX_SECRET, generateSealedSecret } from '../../lib/secrets/data-encryption.ts'
import { deriveEncryptionSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { getManagedEngineSpec } from './index.ts'
import {
  listOrchestratorManagedClusterIds,
  mergeOrchestratorManagedClusterIds,
  orchestratorManagedClusterIdsFromRows,
  resolveReplicationCredentialForHa,
  type HaSecretsParams,
} from './ha-replication-credential.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SERVER_ID = '550e8400-e29b-41d4-a716-446655440000'
const MANAGED_ID = 'mgd-mysql-ha'
const KEY_ID = '22222222-2222-4222-8222-222222222222'

test('orchestratorManagedClusterIdsFromRows lists only multi-member MySQL-family clusters', () => {
  assertEquals(
    orchestratorManagedClusterIdsFromRows([
      { managedId: 'mysql-ha', engine: 'mysql' },
      { managedId: 'mysql-ha', engine: 'mysql' },
      { managedId: 'mysql-ha', engine: 'mysql' },
      { managedId: 'pg-ha', engine: 'postgres' },
      { managedId: 'pg-ha', engine: 'postgres' },
      { managedId: 'single', engine: 'mysql' },
    ]),
    ['mysql-ha']
  )
})

test('mergeOrchestratorManagedClusterIds unions and sorts unique managed ids', () => {
  assertEquals(
    mergeOrchestratorManagedClusterIds(['cluster-b', 'cluster-a'], ['cluster-c', 'cluster-b']),
    ['cluster-a', 'cluster-b', 'cluster-c']
  )
})

test('listOrchestratorManagedClusterIds loads replicas for an organization', async () => {
  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            where: () =>
              Promise.resolve([
                { managedId: 'mysql-ha', engine: 'mysql' },
                { managedId: 'mysql-ha', engine: 'mysql' },
              ]),
          }),
        }),
      }),
    }),
  } as unknown as Db
  assertEquals(await listOrchestratorManagedClusterIds(db, 'org-1'), ['mysql-ha'])
})

function daemonJoinRow() {
  return [
    {
      daemon: null,
      metadata: null,
      hostname: 'host',
      machineKey: null,
      connected: true,
      statusChangedAt: '2020-01-01T00:00:00.000Z',
      id: KEY_ID,
      algorithm: 'Ed25519',
      publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc' },
      fingerprint: 'fp',
      createdAt: '2020-01-01T00:00:00.000Z',
      revokedAt: null,
      lastUsedAt: null,
    },
  ]
}

test('resolveReplicationCredentialForHa reseals an existing replication principal', async () => {
  const secrets = parseTestSecretsConfig()
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(secrets, 'data-encryption')
  const { sealed } = await generateSealedSecret(dataEncryptionSecrets)
  assert(sealed.startsWith(ENVELOPE_PREFIX_SECRET))

  const spec = getManagedEngineSpec('mysql')
  if (!spec) throw new TypeError('mysql spec missing')
  const params: HaSecretsParams = {
    serverId: SERVER_ID,
    secretsConfig: secrets,
    dataEncryptionSecrets,
  }
  let selectN = 0
  const db = {
    select: () => {
      selectN += 1
      if (selectN === 1) {
        return {
          from: () => ({
            where: () =>
              Promise.resolve([
                {
                  id: 'repl-1',
                  username: 'tp_repl',
                  password: sealed,
                  metadata: { managedReplication: true },
                },
              ]),
          }),
        }
      }
      return {
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: () => Promise.resolve(daemonJoinRow()),
            }),
          }),
        }),
      }
    },
  } as unknown as Db
  const result = await resolveReplicationCredentialForHa(db, params, MANAGED_ID, spec)
  assertEquals(result?.username, 'tp_repl')
  assert(result?.envelope.startsWith('tpdaemon.'))
})

test('resolveReplicationCredentialForHa returns null when replication password is not sealed', async () => {
  const secrets = parseTestSecretsConfig()
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(secrets, 'data-encryption')
  const spec = getManagedEngineSpec('mysql')
  if (!spec) throw new TypeError('mysql spec missing')
  const params: HaSecretsParams = {
    serverId: SERVER_ID,
    secretsConfig: secrets,
    dataEncryptionSecrets,
  }
  let selectN = 0
  const db = {
    select: () => {
      selectN += 1
      if (selectN === 1) {
        return {
          from: () => ({
            where: () =>
              Promise.resolve([
                {
                  id: 'repl-1',
                  username: 'tp_repl',
                  password: 'plaintext',
                  metadata: { managedReplication: true },
                },
              ]),
          }),
        }
      }
      return {
        from: () => ({
          innerJoin: () => ({
            innerJoin: () => ({
              innerJoin: () => ({
                where: () => ({
                  limit: () => Promise.resolve([]),
                }),
              }),
            }),
          }),
        }),
      }
    },
  } as unknown as Db
  assertEquals(await resolveReplicationCredentialForHa(db, params, MANAGED_ID, spec), null)
})

test('resolveReplicationCredentialForHa returns null when managed organization cannot be resolved', async () => {
  const secrets = parseTestSecretsConfig()
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(secrets, 'data-encryption')
  const spec = getManagedEngineSpec('mysql')
  if (!spec) throw new TypeError('mysql spec missing')
  const params: HaSecretsParams = {
    serverId: SERVER_ID,
    secretsConfig: secrets,
    dataEncryptionSecrets,
  }
  let selectN = 0
  const db = {
    select: () => {
      selectN += 1
      if (selectN === 1) {
        return {
          from: () => ({
            where: () => Promise.resolve([]),
          }),
        }
      }
      return {
        from: () => ({
          innerJoin: () => ({
            innerJoin: () => ({
              innerJoin: () => ({
                where: () => ({
                  limit: () => Promise.resolve([]),
                }),
              }),
            }),
          }),
        }),
      }
    },
  } as unknown as Db
  assertEquals(await resolveReplicationCredentialForHa(db, params, MANAGED_ID, spec), null)
})
