/**
 * The daemon's X25519 sealing key (public half) and the sealed answer to
 * `/secrets/decrypt`. The daemon registers the key with a signature from its
 * Ed25519 identity key; the control plane seals decrypt answers to it when the
 * daemon lists `daemon-sealed-secrets-v1`, so an edge that terminates TLS in
 * front of the control plane never reads a plaintext secret.
 */
import { and, eq, gte, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { server } from '../../db/schema.ts'
import { mapSequential } from '../../lib/sequential.ts'
import { base64urlDecode } from '../../lib/encoding/base64url.ts'
import { sealToRecipient, type HpkeEnvelope } from '../../lib/panel-identity/hpke.ts'

export type DaemonSealingKey = { kid: string; pub: string }

/** Written at most this often per server; the go-live gate reads "any recent value". */
const PLAINTEXT_NOTE_INTERVAL_MS = 60 * 60 * 1000

export async function getDaemonSealingKey(
  db: Db,
  serverId: string
): Promise<DaemonSealingKey | null> {
  const [row] = await db
    .select({ kid: server.sealingKeyKid, pub: server.sealingKeyPub })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  return row?.kid && row.pub ? { kid: row.kid, pub: row.pub } : null
}

export async function setDaemonSealingKey(
  db: Db,
  serverId: string,
  key: DaemonSealingKey & { reportedAt: string }
): Promise<void> {
  await db
    .update(server)
    .set({
      sealingKeyKid: key.kid,
      sealingKeyPub: key.pub,
      sealingKeyReportedAt: key.reportedAt,
    })
    .where(eq(server.id, serverId))
}

/**
 * One envelope per plaintext, in order; `null` stays `null`. `aad` is the
 * recipient server id, so an envelope cannot be replayed to another server.
 */
export function sealDecryptAnswers(
  plaintexts: readonly (string | null)[],
  serverId: string,
  key: DaemonSealingKey
): Promise<(HpkeEnvelope | null)[]> {
  const pub = base64urlDecode(key.pub)
  const encoder = new TextEncoder()
  return mapSequential(plaintexts, (plaintext) =>
    plaintext === null ? null : sealToRecipient(pub, key.kid, serverId, encoder.encode(plaintext))
  )
}

/**
 * Record that this server was answered in plaintext. Throttled in SQL (one
 * write an hour per server) so a busy legacy daemon costs one cheap update.
 */
export async function noteDaemonPlaintextSecrets(db: Db, serverId: string): Promise<void> {
  const cutoff = new Date(Date.now() - PLAINTEXT_NOTE_INTERVAL_MS).toISOString()
  await db
    .update(server)
    .set({ plaintextSecretsAt: sql`now()` })
    .where(
      and(
        eq(server.id, serverId),
        or(isNull(server.plaintextSecretsAt), lt(server.plaintextSecretsAt, cutoff))
      )
    )
}

/**
 * Servers answered in plaintext since `sinceIso`. The edge go-live gate reads
 * this: zero over its window means every connected daemon takes sealed answers.
 */
export async function countServersWithPlaintextSecretsSince(
  db: Db,
  sinceIso: string
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(server)
    .where(and(isNotNull(server.plaintextSecretsAt), gte(server.plaintextSecretsAt, sinceIso)))
  return row?.n ?? 0
}
