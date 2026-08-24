import { assertEquals, assertNotEquals } from '@std/assert'
import {
  gitlabDeliveryId,
  gitlabEventName,
  timingSafeSecretEquals,
  verifyGitlabWebhookToken,
} from './gitlab-webhook.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const encoder = new TextEncoder()

test('timingSafeSecretEquals compares by value, not by length', async () => {
  assertEquals(await timingSafeSecretEquals('hunter2', 'hunter2'), true)
  assertEquals(await timingSafeSecretEquals('hunter2', 'hunter3'), false)
  // A prefix must not pass: the digest comparison is over the whole value.
  assertEquals(await timingSafeSecretEquals('hunter2', 'hunter'), false)
  assertEquals(await timingSafeSecretEquals('hunter', 'hunter2'), false)
})

test('verifyGitlabWebhookToken accepts only the configured token', async () => {
  assertEquals(await verifyGitlabWebhookToken('shared', 'shared'), true)
  assertEquals(await verifyGitlabWebhookToken('shared', 'other'), false)
})

test('an unconfigured or absent token is a refusal, never a pass', async () => {
  // No secret configured: the instance must reject rather than accept an
  // unauthenticated delivery — same rule the GitHub surface applies.
  assertEquals(await verifyGitlabWebhookToken(null, 'anything'), false)
  assertEquals(await verifyGitlabWebhookToken('', 'anything'), false)
  assertEquals(await verifyGitlabWebhookToken('shared', null), false)
  assertEquals(await verifyGitlabWebhookToken('shared', ''), false)
})

test('gitlabDeliveryId prefers the event UUID header', async () => {
  const body = encoder.encode('{"object_kind":"push"}')
  assertEquals(await gitlabDeliveryId('  abc-123  ', body), 'abc-123')
})

test('gitlabDeliveryId falls back to a digest of the exact bytes', async () => {
  const body = encoder.encode('{"object_kind":"push","checkout_sha":"a"}')
  const same = encoder.encode('{"object_kind":"push","checkout_sha":"a"}')
  const other = encoder.encode('{"object_kind":"push","checkout_sha":"b"}')

  const id = await gitlabDeliveryId(null, body)
  // A resend carries byte-identical JSON, so it claims the same id and is
  // recognised as the duplicate it is.
  assertEquals(id, await gitlabDeliveryId('', same))
  assertEquals(id.startsWith('sha256:'), true)
  // A genuinely different push must not collide with it.
  assertNotEquals(id, await gitlabDeliveryId(undefined, other))
})

test('gitlabEventName normalizes the display-name header', () => {
  assertEquals(gitlabEventName('Push Hook'), 'push_hook')
  assertEquals(gitlabEventName('  Pipeline Hook '), 'pipeline_hook')
  assertEquals(gitlabEventName(null), '')
})

test('comparison HMAC key is not minted at module load', async () => {
  // Workers error 10021: getRandomValues / SubtleCrypto at isolate global
  // scope fails deploy. The key must be created inside a function body.
  const source = await Deno.readTextFile(new URL('./gitlab-webhook.ts', import.meta.url))
  assertEquals(source.includes('crypto.getRandomValues'), true)
  assertEquals(/^const comparisonKeyPromise/m.test(source), false)
})
