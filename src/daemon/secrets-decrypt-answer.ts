import type { HpkeEnvelope } from '../lib/panel-identity/hpke.ts'

/**
 * The body of `POST /api/daemon/v1/secrets/decrypt`: `sealed`, one envelope per
 * input in the same order (`null` where the input did not decrypt), sealed to
 * the server's registered sealing key. A server with no key on file gets a 409
 * {@link SEALING_KEY_REQUIRED_ERROR} and no plaintext; the daemon registers its
 * key and asks again.
 *
 * The choice keys on the registered key alone, never on the hello `features`
 * list: that list arrives unsigned. Only a daemon that signs with the server's
 * identity key can register a sealing key.
 */
export type SecretsDecryptAnswer = { sealed: (HpkeEnvelope | null)[] }

export const SEALING_KEY_REQUIRED_ERROR = 'sealing_key_required'

export const SEALING_KEY_REQUIRED_MESSAGE =
  'No sealing key is registered for this server. Register one, then ask again.'
