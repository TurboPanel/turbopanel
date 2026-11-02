import type { Db } from '../db/connection.ts'
import {
  type DaemonSealingKey,
  getDaemonSealingKey,
  noteDaemonPlaintextSecrets,
  sealDecryptAnswers,
} from '../features/servers/daemon-sealing-key.ts'
import { getServerDaemonStateByServerId } from '../features/servers/server-identity-db.ts'
import type { HpkeEnvelope } from '../lib/panel-identity/hpke.ts'
import { DAEMON_SEALED_SECRETS_FEATURE } from '../lib/version-wire.ts'

/**
 * The body of `POST /api/daemon/v1/secrets/decrypt`: either `plaintexts` (a
 * daemon that does not list `daemon-sealed-secrets-v1`, or one that has not
 * registered a sealing key yet) or `sealed`, one envelope per input in the same
 * order (`null` where the input did not decrypt). Never both.
 */
export type SecretsDecryptAnswer =
  { plaintexts: (string | null)[] } | { sealed: (HpkeEnvelope | null)[] }

/** What the answer needs to know about the server; the route passes the database-backed one. */
export type SecretsDecryptAnswerSource = {
  advertisesSealedSecrets(serverId: string): Promise<boolean>
  sealingKey(serverId: string): Promise<DaemonSealingKey | null>
  notePlaintextAnswer(serverId: string): Promise<void>
}

export function databaseDecryptAnswerSource(db: Db): SecretsDecryptAnswerSource {
  return {
    advertisesSealedSecrets: async (serverId) =>
      ((await getServerDaemonStateByServerId(db, serverId))?.projection?.features ?? []).includes(
        DAEMON_SEALED_SECRETS_FEATURE
      ),
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
  const key = (await source.advertisesSealedSecrets(serverId))
    ? await source.sealingKey(serverId)
    : null
  if (key) {
    return { sealed: await sealDecryptAnswers(plaintexts, serverId, key) }
  }
  // The counter is bookkeeping for the go-live gate; it never blocks an answer.
  await source.notePlaintextAnswer(serverId).catch(() => undefined)
  return { plaintexts }
}
