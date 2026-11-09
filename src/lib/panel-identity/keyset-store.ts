/**
 * Postgres side of key rotation: marked rotation passkeys (`custodian`) and the
 * key-set chain (`rotation`). Public data only, so both runtimes keep it in
 * the database (High Availability has no writable key store). Every function
 * takes the caller's database client; nothing here holds one.
 */
import { and, asc, desc, eq, gt, inArray, isNull, max } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { custodian, rotation } from '../../db/schema.ts'
import {
  type KeysetEnvelope,
  type KeysetPin,
  type KeysetStatementKind,
  type KeysetStatementState,
  type RotationPasskey,
  rotationPasskeysHash,
  serializeKeysetEnvelope,
} from './keyset-statement.ts'
import type { PanelIdentity } from './identity.ts'

export type MarkedCustodian = RotationPasskey & {
  rowId: string
  passkeyId: string | null
  rpId: string
  label: string | null
}

/** The rotation block of the identity document: what servers pin on first fill. */
export type RotationState = { rpId: string; passkeys: RotationPasskey[] }

/** Rotation passkeys that approve key changes now, sorted by id. */
export async function listMarkedCustodians(db: Db): Promise<MarkedCustodian[]> {
  const rows = await db
    .select({
      rowId: custodian.id,
      passkeyId: custodian.passkeyId,
      id: custodian.pkid,
      alg: custodian.alg,
      pub: custodian.publicKeyRaw,
      rpId: custodian.rpId,
      label: custodian.label,
    })
    .from(custodian)
    .where(isNull(custodian.unmarkedAt))
    .orderBy(asc(custodian.pkid))
  return rows.map((row) => ({ ...row, alg: row.alg === 'EdDSA' ? 'EdDSA' : 'ES256' }))
}

export function rotationStateOf(custodians: readonly MarkedCustodian[]): RotationState | null {
  const first = custodians[0]
  if (!first) return null
  return {
    rpId: first.rpId,
    passkeys: custodians.map((a) => ({ id: a.id, alg: a.alg, pub: a.pub })),
  }
}

/** Highest key set of a statement in the given state set (0 with none). */
async function maxKeyset(db: Db, liveOnly: boolean): Promise<number> {
  const rows = await db
    .select({ keyset: max(rotation.keyset) })
    .from(rotation)
    .where(liveOnly ? eq(rotation.state, 'live') : undefined)
  return rows[0]?.keyset ?? 0
}

/** The key set servers should hold now: the newest live statement, or the identity's own. */
export async function liveKeyset(db: Db, identity: PanelIdentity): Promise<number> {
  return Math.max(identity.keyset, await maxKeyset(db, true))
}

/**
 * What the control plane checks a new statement against: its own key, the
 * newest key set (live or waiting for its key), and the marked passkeys.
 */
export async function controlPlanePin(
  db: Db,
  identity: PanelIdentity,
  fallbackRpId: string
): Promise<KeysetPin & { custodians: MarkedCustodian[] }> {
  const custodians = await listMarkedCustodians(db)
  const state = rotationStateOf(custodians)
  return {
    current: identity.current.kid,
    keyset: Math.max(identity.keyset, await maxKeyset(db, false)),
    rpId: state?.rpId ?? fallbackRpId,
    passkeys: state?.passkeys ?? [],
    custodians,
  }
}

export type StoredStatement = {
  keyset: number
  kind: KeysetStatementKind
  state: KeysetStatementState
  prevKid: string
  currentKid: string
  envelope: KeysetEnvelope
  createdAt: string
  liveAt: string | null
}

function envelopeOf(row: { body: string; approvals: string }): KeysetEnvelope {
  return {
    statement: row.body,
    approvals: JSON.parse(row.approvals) as KeysetEnvelope['approvals'],
  }
}

const STATEMENT_COLUMNS = {
  keyset: rotation.keyset,
  kind: rotation.kind,
  state: rotation.state,
  prevKid: rotation.prevKid,
  currentKid: rotation.currentKid,
  body: rotation.body,
  approvals: rotation.approvals,
  createdAt: rotation.createdAt,
  liveAt: rotation.liveAt,
}

function toStored(row: {
  keyset: number
  kind: string
  state: string
  prevKid: string
  currentKid: string
  body: string
  approvals: string
  createdAt: string
  liveAt: string | null
}): StoredStatement {
  return {
    keyset: row.keyset,
    kind: row.kind as KeysetStatementKind,
    state: row.state as KeysetStatementState,
    prevKid: row.prevKid,
    currentKid: row.currentKid,
    envelope: envelopeOf(row),
    createdAt: row.createdAt,
    liveAt: row.liveAt,
  }
}

/** Live statements above `after`, ascending: the chain servers fetch. */
export async function listLiveStatements(
  db: Db,
  after: number,
  limit = 100
): Promise<KeysetEnvelope[]> {
  const rows = await db
    .select({ body: rotation.body, approvals: rotation.approvals })
    .from(rotation)
    .where(and(eq(rotation.state, 'live'), gt(rotation.keyset, after)))
    .orderBy(asc(rotation.keyset))
    .limit(limit)
  return rows.map(envelopeOf)
}

/** The newest statements, newest first (the admin screen and Download Statement). */
export async function listRecentStatements(db: Db, limit = 20): Promise<StoredStatement[]> {
  const rows = await db
    .select(STATEMENT_COLUMNS)
    .from(rotation)
    .orderBy(desc(rotation.keyset))
    .limit(limit)
  return rows.map(toStored)
}

export async function readStatement(db: Db, keyset: number): Promise<StoredStatement | null> {
  const rows = await db
    .select(STATEMENT_COLUMNS)
    .from(rotation)
    .where(eq(rotation.keyset, keyset))
    .limit(1)
  return rows[0] ? toStored(rows[0]) : null
}

/** A statement whose new key a High Availability secret does not hold yet, if any. */
export async function readAwaitingKeyStatement(db: Db): Promise<StoredStatement | null> {
  const rows = await db
    .select(STATEMENT_COLUMNS)
    .from(rotation)
    .where(eq(rotation.state, 'awaiting_key'))
    .orderBy(desc(rotation.keyset))
    .limit(1)
  return rows[0] ? toStored(rows[0]) : null
}

/**
 * Serve a waiting statement once the loaded key is its new key (High
 * Availability: the owner put the secret). True when one turned live.
 */
export async function markAwaitingStatementLive(db: Db, loadedKid: string): Promise<boolean> {
  // Read first: this runs on the public identity route, which must not write
  // on every request.
  const waiting = await db
    .select({ keyset: rotation.keyset })
    .from(rotation)
    .where(and(eq(rotation.state, 'awaiting_key'), eq(rotation.currentKid, loadedKid)))
    .limit(1)
  if (waiting.length === 0) return false
  const updated = await db
    .update(rotation)
    .set({ state: 'live', liveAt: new Date().toISOString() })
    .where(and(eq(rotation.state, 'awaiting_key'), eq(rotation.currentKid, loadedKid)))
    .returning({ keyset: rotation.keyset })
  return updated.length > 0
}

export type StatementInsert = {
  keyset: number
  kind: KeysetStatementKind
  state: KeysetStatementState
  prevKid: string
  currentKid: string
  envelope: KeysetEnvelope
  approvedByUserId: string | null
}

/** Store an approved statement. The unique key set refuses a second one for the same step. */
export async function insertStatement(db: Db, input: StatementInsert): Promise<void> {
  const approvals = JSON.parse(serializeKeysetEnvelope(input.envelope)).approvals as unknown[]
  await db.insert(rotation).values({
    keyset: input.keyset,
    kind: input.kind,
    state: input.state,
    prevKid: input.prevKid,
    currentKid: input.currentKid,
    body: input.envelope.statement,
    approvals: JSON.stringify(approvals),
    approvedByUserId: input.approvedByUserId,
    liveAt: input.state === 'live' ? new Date().toISOString() : null,
  })
}

export type CustodianMark = RotationPasskey & {
  passkeyId: string
  rpId: string
  label: string | null
}

/** Apply a passkey statement's set: mark the added, unmark the removed. */
export async function applyCustodianChanges(
  db: Db,
  input: { keyset: number; mark: readonly CustodianMark[]; unmark: readonly string[] }
): Promise<void> {
  const now = new Date().toISOString()
  if (input.unmark.length > 0) {
    await db
      .update(custodian)
      .set({ unmarkedAt: now, unmarkedKeyset: input.keyset, passkeyId: null })
      .where(and(inArray(custodian.pkid, [...input.unmark]), isNull(custodian.unmarkedAt)))
  }
  if (input.mark.length > 0) {
    await db.insert(custodian).values(
      input.mark.map((m) => ({
        passkeyId: m.passkeyId,
        pkid: m.id,
        alg: m.alg,
        publicKeyRaw: m.pub,
        rpId: m.rpId,
        label: m.label,
        markedKeyset: input.keyset,
      }))
    )
  }
}

/** The rp id the marked rotation passkeys belong to, or null when none is marked. */
export async function markedRpId(db: Db): Promise<string | null> {
  const rows = await db
    .select({ rpId: custodian.rpId })
    .from(custodian)
    .where(isNull(custodian.unmarkedAt))
    .limit(1)
  return rows[0]?.rpId ?? null
}

/** Ids of the sign-in passkeys marked now. */
export async function markedPasskeyIds(db: Db): Promise<Set<string>> {
  const rows = await db
    .select({ passkeyId: custodian.passkeyId })
    .from(custodian)
    .where(isNull(custodian.unmarkedAt))
  return new Set(rows.map((row) => row.passkeyId).filter((id): id is string => id !== null))
}

/** True when this sign-in passkey is marked (it must be unmarked before it can be deleted). */
export async function isPasskeyMarked(db: Db, passkeyId: string): Promise<boolean> {
  const rows = await db
    .select({ id: custodian.id })
    .from(custodian)
    .where(and(eq(custodian.passkeyId, passkeyId), isNull(custodian.unmarkedAt)))
    .limit(1)
  return rows.length > 0
}

/**
 * What the identity document carries from the chain. First turns a waiting
 * statement live when the loaded key is its new key (High Availability, after
 * the owner put the secret), so a server that meets the new key finds it.
 */
export async function identityChainState(
  db: Db,
  identity: PanelIdentity
): Promise<{ keyset: number; rotation: RotationState | null }> {
  await markAwaitingStatementLive(db, identity.current.kid)
  const [keyset, custodians] = await Promise.all([
    liveKeyset(db, identity),
    listMarkedCustodians(db),
  ])
  return { keyset, rotation: rotationStateOf(custodians) }
}

/** Hash of the marked rotation passkeys (what a server's pin report should match), or null with none. */
export async function markedPasskeysHash(db: Db): Promise<string | null> {
  const custodians = await listMarkedCustodians(db)
  return custodians.length > 0 ? await rotationPasskeysHash(custodians) : null
}
