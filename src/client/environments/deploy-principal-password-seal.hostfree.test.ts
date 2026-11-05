import { assertEquals } from '@std/assert'
import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { Db } from '../../db/connection.ts'
import { decryptSecretForDaemon } from '../../lib/secrets/data-encryption.ts'
import { deriveEncryptionSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { sealPrincipalMaterialForDaemon } from './deploy-prepare.ts'
import { sealPrincipalPasswordHashes } from './deploy-principal-password-seal.ts'

const test = Deno.test.bind(Deno)

const HASH = `$6$saltstring$${'a'.repeat(86)}`

test('password hashes become envelopes and entries without a hash pass through', async () => {
  const sealed = await sealPrincipalPasswordHashes(
    [
      { principalId: 'p1', username: 'alice', passwordHash: HASH },
      { principalId: 'p2', username: 'bob' },
    ],
    (plaintext) => Promise.resolve(`tpdaemon.v1.sealed-${plaintext.length}`)
  )
  assertEquals(sealed[0], {
    principalId: 'p1',
    username: 'alice',
    passwordHashEnvelope: `tpdaemon.v1.sealed-${HASH.length}`,
  })
  assertEquals('passwordHash' in sealed[0], false)
  assertEquals(sealed[1], { principalId: 'p2', username: 'bob' })
})

const SERVER_ID = 'srv-1'
const KEY_ID = 'key-1'

/**
 * Db double for the deploy sealing gate: the joined server and key read answers
 * an active key whose stored hello lists no features at all (a stripped
 * hello), and the plain server read answers the stored sealing key.
 */
function sealingGateDb(sealingKey: { kid: string; pub: string } | null): Db {
  const daemonRow = {
    daemon: { projection: { features: [] } },
    metadata: null,
    hostname: null,
    machineKey: null,
    trustLevel: 2,
    connected: true,
    statusChangedAt: null,
    id: KEY_ID,
    algorithm: 'Ed25519',
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'AAAA' },
    fingerprint: 'fp',
    createdAt: '2026-01-01T00:00:00.000Z',
    revokedAt: null,
    lastUsedAt: null,
  }
  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({ limit: () => Promise.resolve([daemonRow]) }),
        }),
        where: () => ({
          limit: () => Promise.resolve([sealingKey ?? { kid: null, pub: null }]),
        }),
      }),
    }),
  } as unknown as Db
}

async function deployContext(): Promise<Context<AppEnv>> {
  const secretsConfig = parseTestSecretsConfig('deno')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption'
  )
  const values: Record<string, unknown> = { secretsConfig, dataEncryptionSecrets }
  return { get: (name: string) => values[name] } as unknown as Context<AppEnv>
}

const MATERIAL = [
  { principalId: 'p1', username: 'alice', passwordHash: HASH },
  { principalId: 'p2', username: 'bob' },
]

test('deploy seals the password hash when a sealing key is on file, whatever the hello lists', async () => {
  const c = await deployContext()
  const sealed = await sealPrincipalMaterialForDaemon(
    c,
    sealingGateDb({ kid: 'seal-1', pub: 'pub' }),
    'deploy',
    SERVER_ID,
    MATERIAL
  )
  if (sealed instanceof Response) throw new TypeError(`unexpected refusal ${sealed.status}`)
  assertEquals('passwordHash' in sealed[0]!, false)
  const envelope = sealed[0]?.passwordHashEnvelope
  assertEquals(typeof envelope, 'string')
  assertEquals(
    await decryptSecretForDaemon(
      c.get('secretsConfig')!,
      { serverId: SERVER_ID, keyId: KEY_ID },
      envelope!
    ),
    HASH
  )
  assertEquals(sealed[1], MATERIAL[1])
})

test('deploy keeps the plain hash when no sealing key is on file', async () => {
  const kept = await sealPrincipalMaterialForDaemon(
    await deployContext(),
    sealingGateDb(null),
    'deploy',
    SERVER_ID,
    MATERIAL
  )
  assertEquals(kept, MATERIAL)
})
