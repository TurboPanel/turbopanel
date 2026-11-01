import { importX25519Sealer } from '../lib/panel-identity/keys.ts'
import type { HpkeEnvelope } from '../lib/panel-identity/hpke.ts'

/** Fixed recipient seed for HPKE tests (bytes 1..32). Not a real key. */
export const HPKE_TEST_RECIPIENT_SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
export const HPKE_TEST_AAD = 'srv_hpke_vector'
export const HPKE_TEST_PLAINTEXT = 'hpke vector plaintext'

export async function hpkeTestRecipient(): Promise<{ kid: string; pub: Uint8Array }> {
  const imported = await importX25519Sealer(HPKE_TEST_RECIPIENT_SEED)
  return { kid: imported.kid, pub: imported.publicRaw }
}

/** Produced once by `sealToRecipient` and checked in; the daemon repo opens the same envelope. */
export const HPKE_TEST_VECTOR: HpkeEnvelope = {
  v: 1,
  kid: 'qqj_9wO1CyKX9PbhNQj3JCDZb9Aeu4TLB0RJyq72QEE',
  enc: 'J_QRSdG2Woxda2mBqLMsgsSSQ9OfY47LJM8g8c6r8mc',
  ct: 'LifWMSmtWSgR8oGCsj_7sIlVuliNV6ddJiQSR-gPjsGtMS9C9w',
}
