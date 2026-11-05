/**
 * The daemon's X25519 sealing key (public half) and the sealed answer to
 * `/secrets/decrypt`. The daemon registers the key with a signature from its
 * Ed25519 identity key; once a key is on file the control plane seals every
 * decrypt answer to it, so an edge that terminates TLS in front of the control
 * plane never reads a plaintext secret. The unsigned hello `features` list does
 * not switch sealing off.
 */
import { and, eq, gte, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { server } from '../../db/schema.ts'
import { mapSequential } from '../../lib/sequential.ts'
import { base64urlDecode } from '../../lib/encoding/base64url.ts'
import { sealToRecipient, type HpkeEnvelope } from '../../lib/panel-identity/hpke.ts'
import { DAEMON_SEALED_SECRETS_FEATURE } from '../../lib/version-wire.ts'
import { daemonFeatureAddedColumnPatch } from './daemon-jsonb-write.ts'
import { parseServerDaemonState } from './daemon-state.ts'

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

/**
 * Store the key and add `daemon-sealed-secrets-v1` to the stored hello
 * features when it is missing: only a daemon with the feature registers, and
 * one that connected before this control plane knew the feature had it
 * dropped from its hello. The list is informational (the sealed-secrets
 * report shows it); the decrypt route seals on the key alone, so a later
 * hello without the feature does not bring plaintext back.
 */
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
      daemon: daemonFeatureAddedColumnPatch(DAEMON_SEALED_SECRETS_FEATURE),
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

/** One server's row in the sealed-secrets report. Public values only. */
export type SealedSecretsServerState = {
  id: string
  name: string | null
  /** With `name` and `id`, what the Clear Sealing Key confirmation asks for. */
  hostname: string | null
  organizationId: string | null
  isConnected: boolean
  /** The stored hello features list `daemon-sealed-secrets-v1`. */
  advertisesSealedSecrets: boolean
  /** Key id and registration time; the public key itself is not repeated here. */
  sealingKey: { kid: string; reportedAt: string | null } | null
  /** Last plaintext decrypt answer (stamped at most hourly), or null. */
  plaintextSecretsAt: string | null
  /** True while the decrypt route would answer this server in plaintext. */
  receivesPlaintext: boolean
}

type SealedSecretsRow = {
  id: string
  name: string | null
  hostname: string | null
  organizationId: string | null
  isConnected: boolean
  daemon: unknown
  sealingKeyKid: string | null
  sealingKeyPub: string | null
  sealingKeyReportedAt: string | null
  plaintextSecretsAt: string | null
}

/** The stored hello features list `daemon-sealed-secrets-v1` (replaced by every hello). */
export function daemonAdvertisesSealedSecrets(daemon: unknown): boolean {
  const features = parseServerDaemonState(daemon)?.projection?.features ?? []
  return features.includes(DAEMON_SEALED_SECRETS_FEATURE)
}

/** The same rule as the decrypt route: sealed whenever a key is on file. */
export function sealedSecretsServerState(row: SealedSecretsRow): SealedSecretsServerState {
  const advertisesSealedSecrets = daemonAdvertisesSealedSecrets(row.daemon)
  const sealingKey =
    row.sealingKeyKid && row.sealingKeyPub
      ? { kid: row.sealingKeyKid, reportedAt: row.sealingKeyReportedAt }
      : null
  return {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    organizationId: row.organizationId,
    isConnected: row.isConnected,
    advertisesSealedSecrets,
    sealingKey,
    plaintextSecretsAt: row.plaintextSecretsAt,
    receivesPlaintext: sealingKey === null,
  }
}

/** Every server's sealed-secrets state, for the edge go-live gate. */
export async function listSealedSecretsState(db: Db): Promise<SealedSecretsServerState[]> {
  const rows = await db
    .select({
      id: server.id,
      name: server.name,
      hostname: server.hostname,
      organizationId: server.organizationId,
      isConnected: server.isConnected,
      daemon: server.daemon,
      sealingKeyKid: server.sealingKeyKid,
      sealingKeyPub: server.sealingKeyPub,
      sealingKeyReportedAt: server.sealingKeyReportedAt,
      plaintextSecretsAt: server.plaintextSecretsAt,
    })
    .from(server)
  return rows.map(sealedSecretsServerState)
}

/** What the Clear Sealing Key action reads about one server before it acts. */
export type SealingKeyClearTarget = {
  id: string
  organizationId: string | null
  name: string | null
  hostname: string | null
  kid: string | null
  /**
   * Connected with a hello that lists `daemon-sealed-secrets-v1`: a current
   * daemon, which would refuse the plaintext answers a clear brings.
   */
  connectedDaemonSealsSecrets: boolean
}

export async function readSealingKeyClearTarget(
  db: Db,
  serverId: string
): Promise<SealingKeyClearTarget | null> {
  const [row] = await db
    .select({
      id: server.id,
      name: server.name,
      hostname: server.hostname,
      organizationId: server.organizationId,
      isConnected: server.isConnected,
      daemon: server.daemon,
      sealingKeyKid: server.sealingKeyKid,
    })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  if (!row) return null
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    hostname: row.hostname,
    kid: row.sealingKeyKid,
    connectedDaemonSealsSecrets: row.isConnected && daemonAdvertisesSealedSecrets(row.daemon),
  }
}
