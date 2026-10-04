import { assert, assertEquals, assertNotEquals, assertRejects } from '@std/assert'
import { DataEncryptionError, decryptSecretForDaemon } from '../lib/secrets/data-encryption.ts'
import { parseTestSecretsConfig } from '../test-fixtures/secrets.ts'
import { recordingRedisRegistry } from '../test-fixtures/recording-redis-registry.ts'
import type { InstanceSecretSealing } from '../features/install/instance-secret-sealing.ts'
import { sendInstanceTunnelToken } from './tunnel-token.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

/**
 * A sealed tunnel token is recipient-bound: only the daemon (server id + key
 * id) it was sealed to can open it, and any change to the envelope is refused.
 * The token is generated at run time (nothing token-shaped is a literal).
 */

function sealingFor(serverId: string, keyId = crypto.randomUUID()): InstanceSecretSealing {
  return {
    secretsConfig: parseTestSecretsConfig(),
    recipient: { serverId, keyId },
  }
}

function randomToken(): string {
  return crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '')
}

async function sealedEnvelope(
  serverId: string,
  sealing: InstanceSecretSealing,
  token: string
): Promise<string> {
  const { registry, outboxWrites } = recordingRedisRegistry(serverId)
  await sendInstanceTunnelToken(registry, serverId, token, sealing)
  const parsed = JSON.parse(outboxWrites[0]!.payload!) as { tokenEnvelope?: string }
  assert(parsed.tokenEnvelope, 'no tokenEnvelope in the outbox payload')
  return parsed.tokenEnvelope
}

test('an envelope sealed for one daemon cannot be opened as another server', async () => {
  const serverId = crypto.randomUUID()
  const sealing = sealingFor(serverId)
  const token = randomToken()
  const envelope = await sealedEnvelope(serverId, sealing, token)

  assertEquals(
    await decryptSecretForDaemon(sealing.secretsConfig, sealing.recipient, envelope),
    token
  )
  await assertRejects(
    () =>
      decryptSecretForDaemon(
        sealing.secretsConfig,
        { serverId: crypto.randomUUID(), keyId: sealing.recipient.keyId },
        envelope
      ),
    DataEncryptionError
  )
})

test('an envelope sealed for one key cannot be opened with another key of the same server', async () => {
  const serverId = crypto.randomUUID()
  const sealing = sealingFor(serverId)
  const envelope = await sealedEnvelope(serverId, sealing, randomToken())

  await assertRejects(
    () =>
      decryptSecretForDaemon(
        sealing.secretsConfig,
        { serverId, keyId: crypto.randomUUID() },
        envelope
      ),
    DataEncryptionError
  )
})

test('a tampered envelope is refused, never decrypted to something else', async () => {
  const serverId = crypto.randomUUID()
  const sealing = sealingFor(serverId)
  const envelope = await sealedEnvelope(serverId, sealing, randomToken())

  const parts = envelope.split('.')
  const last = parts[parts.length - 1]!
  const flipped = (last.startsWith('A') ? 'B' : 'A') + last.slice(1)
  const tampered = [...parts.slice(0, -1), flipped].join('.')
  assertNotEquals(tampered, envelope)
  await assertRejects(
    () => decryptSecretForDaemon(sealing.secretsConfig, sealing.recipient, tampered),
    DataEncryptionError
  )
  await assertRejects(
    () => decryptSecretForDaemon(sealing.secretsConfig, sealing.recipient, envelope.slice(0, -4)),
    DataEncryptionError
  )
})

test('a plaintext value is never accepted where an envelope is expected', async () => {
  const sealing = sealingFor(crypto.randomUUID())
  await assertRejects(
    () => decryptSecretForDaemon(sealing.secretsConfig, sealing.recipient, randomToken()),
    DataEncryptionError
  )
})

test('sealing the same token twice gives two different envelopes', async () => {
  const serverId = crypto.randomUUID()
  const sealing = sealingFor(serverId)
  const token = randomToken()
  const first = await sealedEnvelope(serverId, sealing, token)
  const second = await sealedEnvelope(serverId, sealing, token)
  assertNotEquals(first, second)
})
