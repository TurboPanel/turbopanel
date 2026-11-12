import { assert, assertEquals, assertRejects } from '@std/assert'
import {
  HPKE_TEST_AAD,
  HPKE_TEST_PLAINTEXT,
  HPKE_TEST_RECIPIENT_SEED,
  HPKE_TEST_VECTOR,
  hpkeTestRecipient,
} from '../../test-fixtures/hpke-vector.ts'
import { isHpkeEnvelope, openFromSender, sealToRecipient } from './hpke.ts'

const test = Deno.test.bind(Deno)

test('HPKE helper round-trips under Deno and opens the shared vector', async () => {
  const recipient = await hpkeTestRecipient()
  const envelope = await sealToRecipient(
    recipient.pub,
    recipient.kid,
    HPKE_TEST_AAD,
    new TextEncoder().encode('round trip')
  )
  assert(isHpkeEnvelope(envelope))
  const opened = await openFromSender(HPKE_TEST_RECIPIENT_SEED, HPKE_TEST_AAD, envelope)
  assertEquals(new TextDecoder().decode(opened), 'round trip')
  const fromVector = await openFromSender(HPKE_TEST_RECIPIENT_SEED, HPKE_TEST_AAD, HPKE_TEST_VECTOR)
  assertEquals(new TextDecoder().decode(fromVector), HPKE_TEST_PLAINTEXT)
})

test('HPKE helper refuses a wrong aad', async () => {
  await assertRejects(() => openFromSender(HPKE_TEST_RECIPIENT_SEED, 'srv_other', HPKE_TEST_VECTOR))
})
