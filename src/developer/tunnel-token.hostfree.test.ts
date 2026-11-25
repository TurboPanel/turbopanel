import { assertEquals, assertRejects } from '@std/assert'
import { decryptSecretForDaemon } from '../lib/secrets/data-encryption.ts'
import { parseTestSecretsConfig } from '../test-fixtures/secrets.ts'
import { recordingRedisRegistry } from '../test-fixtures/recording-redis-registry.ts'
import {
  type InstanceSecretSealing,
  InstanceSecretSealingError,
} from '../features/install/instance-secret-sealing.ts'
import { sendInstanceTunnelToken } from './tunnel-token.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const TUNNEL_TOKEN = 'cf-tunnel-token-do-not-store'

type TunnelEnvelope = { token?: string; tokenEnvelope?: string }

function sealingFor(serverId: string): InstanceSecretSealing {
  return {
    secretsConfig: parseTestSecretsConfig(),
    recipient: { serverId, keyId: crypto.randomUUID() },
  }
}

test("a sealing daemon's tunnel token reaches the outbox only as a tpdaemon envelope", async () => {
  const serverId = crypto.randomUUID()
  const { registry, outboxWrites } = recordingRedisRegistry(serverId)
  const sealing = sealingFor(serverId)

  await sendInstanceTunnelToken(registry, serverId, TUNNEL_TOKEN, sealing)

  assertEquals(outboxWrites.length, 1)
  const raw = outboxWrites[0]!.payload!
  assertEquals(raw.includes(TUNNEL_TOKEN), false, 'plaintext token in the outbox')
  const envelope = JSON.parse(raw) as TunnelEnvelope
  assertEquals(envelope.token, undefined)
  assertEquals(envelope.tokenEnvelope?.startsWith('tpdaemon.'), true)
  assertEquals(
    await decryptSecretForDaemon(sealing.secretsConfig, sealing.recipient, envelope.tokenEnvelope!),
    TUNNEL_TOKEN
  )
})

test('a daemon that cannot open sealed secrets is refused, never sent the plaintext token', async () => {
  const serverId = crypto.randomUUID()
  const { registry, outboxWrites } = recordingRedisRegistry(serverId)

  await assertRejects(
    () => sendInstanceTunnelToken(registry, serverId, TUNNEL_TOKEN, null),
    InstanceSecretSealingError
  )
  assertEquals(outboxWrites.length, 0)
})

test('the empty teardown token is sent as-is, never sealed', async () => {
  const serverId = crypto.randomUUID()
  const { registry, outboxWrites } = recordingRedisRegistry(serverId)

  await sendInstanceTunnelToken(registry, serverId, '', sealingFor(serverId))

  const envelope = JSON.parse(outboxWrites[0]!.payload!) as TunnelEnvelope
  assertEquals(envelope.token, '')
  assertEquals(envelope.tokenEnvelope, undefined)
})
