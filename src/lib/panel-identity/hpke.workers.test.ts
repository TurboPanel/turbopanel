import { describe, expect, it } from 'vitest'
import {
  HPKE_TEST_AAD,
  HPKE_TEST_PLAINTEXT,
  HPKE_TEST_RECIPIENT_SEED,
  HPKE_TEST_VECTOR,
  hpkeTestRecipient,
} from '../../test-fixtures/hpke-vector.ts'
import { isHpkeEnvelope, openFromSender, sealToRecipient } from './hpke.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

describe('HPKE sealing helper under the Workers runtime', () => {
  it('round-trips and opens the checked-in vector', async () => {
    const recipient = await hpkeTestRecipient()
    const envelope = await sealToRecipient(
      recipient.pub,
      recipient.kid,
      HPKE_TEST_AAD,
      encoder.encode('round trip')
    )
    expect(isHpkeEnvelope(envelope)).toBe(true)
    const opened = await openFromSender(HPKE_TEST_RECIPIENT_SEED, HPKE_TEST_AAD, envelope)
    expect(decoder.decode(opened)).toBe('round trip')
    const fromVector = await openFromSender(
      HPKE_TEST_RECIPIENT_SEED,
      HPKE_TEST_AAD,
      HPKE_TEST_VECTOR
    )
    expect(decoder.decode(fromVector)).toBe(HPKE_TEST_PLAINTEXT)
  })

  it('refuses a wrong aad and a tampered ciphertext', async () => {
    const recipient = await hpkeTestRecipient()
    const envelope = await sealToRecipient(
      recipient.pub,
      recipient.kid,
      HPKE_TEST_AAD,
      encoder.encode('x')
    )
    await expect(
      openFromSender(HPKE_TEST_RECIPIENT_SEED, 'srv_other', envelope)
    ).rejects.toBeDefined()
    const flipped = envelope.ct.startsWith('A') ? 'B' : 'A'
    const tampered = { ...envelope, ct: flipped + envelope.ct.slice(1) }
    await expect(
      openFromSender(HPKE_TEST_RECIPIENT_SEED, HPKE_TEST_AAD, tampered)
    ).rejects.toBeDefined()
  })

  it('isHpkeEnvelope rejects a tpdaemon string and malformed objects', () => {
    expect(isHpkeEnvelope('tpdaemon.v1.abc')).toBe(false)
    expect(isHpkeEnvelope(null)).toBe(false)
    expect(isHpkeEnvelope({ ...HPKE_TEST_VECTOR, v: 2 })).toBe(false)
    expect(isHpkeEnvelope({ ...HPKE_TEST_VECTOR, kid: 'short' })).toBe(false)
    expect(isHpkeEnvelope({ ...HPKE_TEST_VECTOR, ct: '' })).toBe(false)
  })
})
