/**
 * Postgres side of key rotation: marked rotation passkeys (`approver`) and the
 * key-set chain (`statement`). Public data only, so both runtimes keep it in
 * the database (High Availability has no writable key store). Every function
 * takes the caller's database client; nothing here holds one.
 */
import { and, asc, desc, eq, gt, inArray, isNull, max } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { approver, statement } from '../../db/schema.ts'
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

export type MarkedApprover = RotationPasskey & {
  rowId: string
  passkeyId: string | null
  rpId: string
  label: string | null
}

/** The rotation block of the identity document: what servers pin on first fill. */
export type RotationState = { rpId: string; passkeys: RotationPasskey[] }

/** Rotation passkeys that approve key changes now, sorted by id. */
export async function listMarkedApprovers(db: Db): Promise<MarkedApprover[]> {
  const rows = await db
    .select({
      rowId: approver.id,
      passkeyId: approver.passkeyId,
      id: approver.pkid,
      alg: approver.alg,
      pub: approver.publicKeyRaw,
      rpId: approver.rpId,
      label: approver.label,
    })
    .from(approver)
    .where(isNull(approver.unmarkedAt))
    .orderBy(asc(approver.pkid))
  return rows.map((row) => ({ ...row, alg: row.alg === 'EdDSA' ? 'EdDSA' : 'ES256' }))
}

export function rotationStateOf(approvers: readonly MarkedApprover[]): RotationState | null {
  const first = approvers[0]
  if (!first) return null
  return {
    rpId: first.rpId,
    passkeys: approvers.map((a) => ({ id: a.id, alg: a.alg, pub: a.pub })),
  }
}

/** Highest key set of a statement in the given state set (0 with none). */
async function maxKeyset(db: Db, liveOnly: boolean): Promise<number> {
  const rows = await db
    .select({ keyset: max(statement.keyset) })
    .from(statement)
    .where(liveOnly ? eq(statement.state, 'live') : undefined)
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
): Promise<KeysetPin & { approvers: MarkedApprover[] }> {
  const approvers = await listMarkedApprovers(db)
  const state = rotationStateOf(approvers)
  return {
    current: identity.current.kid,
    keyset: Math.max(identity.keyset, await maxKeyset(db, false)),
    rpId: state?.rpId ?? fallbackRpId,
    passkeys: state?.passkeys ?? [],
    approvers,
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
  keyset: statement.keyset,
  kind: statement.kind,
  state: statement.state,
  prevKid: statement.prevKid,
  currentKid: statement.currentKid,
  body: statement.body,
  approvals: statement.approvals,
  createdAt: statement.createdAt,
  liveAt: statement.liveAt,
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
    .select({ body: statement.body, approvals: statement.approvals })
    .from(statement)
    .where(and(eq(statement.state, 'live'), gt(statement.keyset, after)))
    .orderBy(asc(statement.keyset))
    .limit(limit)
  return rows.map(envelopeOf)
}

/** The newest statements, newest first (the admin screen and Download Statement). */
export async function listRecentStatements(db: Db, limit = 20): Promise<StoredStatement[]> {
  const rows = await db
    .select(STATEMENT_COLUMNS)
    .from(statement)
    .orderBy(desc(statement.keyset))
    .limit(limit)
  return rows.map(toStored)
}

export async function readStatement(db: Db, keyset: number): Promise<StoredStatement | null> {
  const rows = await db
    .select(STATEMENT_COLUMNS)
    .from(statement)
    .where(eq(statement.keyset, keyset))
    .limit(1)
  return rows[0] ? toStored(rows[0]) : null
}

/** A statement whose new key a High Availability secret does not hold yet, if any. */
export async function readAwaitingKeyStatement(db: Db): Promise<StoredStatement | null> {
  const rows = await db
    .select(STATEMENT_COLUMNS)
    .from(statement)
    .where(eq(statement.state, 'awaiting_key'))
    .orderBy(desc(statement.keyset))
    .limit(1)
  return rows[0] ? toStored(rows[0]) : null
}

/**
 * Serve a waiting statement once the loaded key is its new key (High
 * Availability: the owner put the secret). True when one turned live.
 */
export async function markAwaitingStatementLive(db: Db, loadedKid: string): Promise<boolean> {
  const updated = await db
    .update(statement)
    .set({ state: 'live', liveAt: new Date().toISOString() })
    .where(and(eq(statement.state, 'awaiting_key'), eq(statement.currentKid, loadedKid)))
    .returning({ keyset: statement.keyset })
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
  await db.insert(statement).values({
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

export type ApproverMark = RotationPasskey & {
  passkeyId: string
  rpId: string
  label: string | null
}

/** Apply a passkey statement's set: mark the added, unmark the removed. */
export async function applyApproverChanges(
  db: Db,
  input: { keyset: number; mark: readonly ApproverMark[]; unmark: readonly string[] }
): Promise<void> {
  const now = new Date().toISOString()
  if (input.unmark.length > 0) {
    await db
      .update(approver)
      .set({ unmarkedAt: now, unmarkedKeyset: input.keyset, passkeyId: null })
      .where(and(inArray(approver.pkid, [...input.unmark]), isNull(approver.unmarkedAt)))
  }
  if (input.mark.length > 0) {
    await db.insert(approver).values(
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
    .select({ rpId: approver.rpId })
    .from(approver)
    .where(isNull(approver.unmarkedAt))
    .limit(1)
  return rows[0]?.rpId ?? null
}

/** Ids of the sign-in passkeys marked now. */
export async function markedPasskeyIds(db: Db): Promise<Set<string>> {
  const rows = await db
    .select({ passkeyId: approver.passkeyId })
    .from(approver)
    .where(isNull(approver.unmarkedAt))
  return new Set(rows.map((row) => row.passkeyId).filter((id): id is string => id !== null))
}

/** True when this sign-in passkey is marked (it must be unmarked before it can be deleted). */
export async function isPasskeyMarked(db: Db, passkeyId: string): Promise<boolean> {
  const rows = await db
    .select({ id: approver.id })
    .from(approver)
    .where(and(eq(approver.passkeyId, passkeyId), isNull(approver.unmarkedAt)))
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
  const [keyset, approvers] = await Promise.all([liveKeyset(db, identity), listMarkedApprovers(db)])
  return { keyset, rotation: rotationStateOf(approvers) }
}

/** Hash of the marked rotation passkeys (what a server's pin report should match), or null with none. */
export async function markedPasskeysHash(db: Db): Promise<string | null> {
  const approvers = await listMarkedApprovers(db)
  return approvers.length > 0 ? await rotationPasskeysHash(approvers) : null
}
