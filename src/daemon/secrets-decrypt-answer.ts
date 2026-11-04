import type { Db } from '../db/connection.ts'
import {
  type DaemonSealingKey,
  getDaemonSealingKey,
  noteDaemonPlaintextSecrets,
  sealDecryptAnswers,
} from '../features/servers/daemon-sealing-key.ts'
import type { HpkeEnvelope } from '../lib/panel-identity/hpke.ts'

/**
 * The body of `POST /api/daemon/v1/secrets/decrypt`: either `plaintexts` (a
 * server with no sealing key on file) or `sealed`, one envelope per input in
 * the same order (`null` where the input did not decrypt). Never both.
 *
 * The choice keys on the registered key alone, never on the hello `features`
 * list: that list arrives unsigned, so a caller holding a server token could
 * leave `daemon-sealed-secrets-v1` out of its hello and be answered in
 * plaintext. Only a daemon that signs with the server's identity key can
 * register a sealing key, and only a daemon with the feature does.
 */
export type SecretsDecryptAnswer =
  { plaintexts: (string | null)[] } | { sealed: (HpkeEnvelope | null)[] }

/** What the answer needs to know about the server; the route passes the database-backed one. */
export type SecretsDecryptAnswerSource = {
  sealingKey(serverId: string): Promise<DaemonSealingKey | null>
  notePlaintextAnswer(serverId: string): Promise<void>
}

export function databaseDecryptAnswerSource(db: Db): SecretsDecryptAnswerSource {
  return {
    sealingKey: (serverId) => getDaemonSealingKey(db, serverId),
    notePlaintextAnswer: (serverId) => noteDaemonPlaintextSecrets(db, serverId),
  }
}

export async function buildSecretsDecryptAnswer(
  source: SecretsDecryptAnswerSource | undefined,
  serverId: string,
  plaintexts: (string | null)[]
): Promise<SecretsDecryptAnswer> {
  if (!source) return { plaintexts }
  const key = await source.sealingKey(serverId)
  if (key) {
    return { sealed: await sealDecryptAnswers(plaintexts, serverId, key) }
  }
  // The counter is bookkeeping for the go-live gate; it never blocks an answer.
  await source.notePlaintextAnswer(serverId).catch(() => undefined)
  return { plaintexts }
}
