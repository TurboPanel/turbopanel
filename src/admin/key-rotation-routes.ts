/**
 * Control plane key rotation approved by the owner's passkeys (superadmin,
 * step-up, both runtimes). Two steps for every change:
 *
 * - `POST /instance/identity/statements/prepare` builds the exact statement
 *   bytes (rotate, revoke, or mark/unmark rotation passkeys) and the WebAuthn
 *   challenge (SHA-256 of the bytes). Nothing is stored except, self-hosted,
 *   the pending key a rotation moves to.
 * - `POST /instance/identity/statements` takes the bytes back with the
 *   browser's assertions, checks them exactly as a server will
 *   (`keyset-statement.ts`), and stores the statement.
 *
 * `GET /instance/identity/rotation` is the screen's read;
 * `GET /instance/identity/statements/:keyset` downloads one envelope (root
 * on a cut-off server can hand-apply it);
 * `DELETE /instance/identity/statements/:keyset` cancels a High Availability
 * change that still waits for its key (the rotation command stopped before it
 * stored one). While a change waits, nothing else can be prepared or approved.
 */
import type { Context, Hono } from 'hono'
import { and, eq, inArray } from 'drizzle-orm'
import type { AppEnv } from '../app/app.ts'
import { createRootOnlyMiddleware } from '../client/authn/middleware.ts'
import { webauthnOriginsFor } from '../client/authn/passkeys-http.ts'
import { parseStoredPasskeyJwk, rotationKeyFromJwk } from '../client/authn/passkey-keys.ts'
import { requireInstanceStepUp } from '../client/authn/step-up.ts'
import { type Db, getDb } from '../db/connection.ts'
import { passkey, user } from '../db/schema.ts'
import { isPostgresUniqueViolation } from '../db/unique-violation.ts'
import { type AuditEntry, recordAudit } from '../features/audit/audit-records.ts'
import { recordKeyEvent } from '../features/notifications/key-event.ts'
import { resolveConfiguredOrigin } from '../features/install/resolve-public-base-url.ts'
import { base64urlEncode } from '../lib/encoding/base64url.ts'
import { logWarn } from '../lib/logger.ts'
import { fingerprintRawPublicKey } from '../lib/panel-identity/fingerprint.ts'
import {
  ensurePendingIdentityKey,
  type PanelIdentity,
  PENDING_KEY_MISMATCH,
  promotePendingIdentityKey,
  raiseStoredIdentityKeyset,
  STORED_IDENTITY_CHANGED,
} from '../lib/panel-identity/identity.ts'
import {
  decodeBase64urlStrict,
  KEYSET_ENVELOPE_MAX_BYTES,
  type KeysetEnvelope,
  type KeysetPin,
  type KeysetRefusalReason,
  type KeysetStatement,
  type KeysetStatementKind,
  keysetStatementChallenge,
  MAX_ROTATION_PASSKEYS,
  parseKeysetEnvelope,
  parseKeysetStatement,
  type RotationPasskey,
  rotationPasskeyId,
  serializeKeysetStatement,
  verifyKeysetEnvelope,
} from '../lib/panel-identity/keyset-statement.ts'
import {
  applyCustodianChanges,
  type CustodianMark,
  controlPlanePin,
  deleteAwaitingStatement,
  insertStatement,
  listRecentStatements,
  markAwaitingStatementLive,
  type MarkedCustodian,
  readAwaitingKeyStatement,
  readStatement,
} from '../lib/panel-identity/keyset-store.ts'
import type { DerivedSecretsConfig } from '../lib/secrets/secrets.ts'

/** Rotate Key and Emergency Revoke need at least this many marked passkeys. */
export const MIN_PASSKEYS_TO_ROTATE = 2
/** How old prepared bytes may be when they come back approved. */
export const PREPARED_STATEMENT_MAX_AGE_SECONDS = 600

export type KeyRotationOptions = {
  secrets: DerivedSecretsConfig
  runtime: 'deno' | 'workers'
  panelIdentity?: () => Promise<PanelIdentity | null>
  /** Self-hosted: the data-encryption key the identity seeds are sealed under. */
  dataEncryption?: DerivedSecretsConfig
  /** Self-hosted: the stored key changed, reload the in-memory identity. */
  onIdentityChanged?: () => Promise<void>
  /** Test seam: this control plane's configured origin (default {@link resolveConfiguredOrigin}). */
  configuredOrigin?: (c: Context<AppEnv>) => Promise<string | null>
}

const NO_KEY_STORE = 'This control plane cannot store a new key.'
const AWAITING_KEY_MESSAGE =
  'A key change is waiting for its new key. Finish the command in your terminal, or cancel the waiting change, first.'
const NO_HOSTNAME_MESSAGE =
  'Set a primary hostname in Admin, under Access, before you mark a passkey: rotation passkeys belong to that hostname.'
const START_AGAIN = 'Start again.'

/** What the owner reads for each reason the verifier refuses an approval. */
const REFUSAL_WORDS: Record<KeysetRefusalReason, string> = {
  'statement is not base64url': `The change did not arrive intact. ${START_AGAIN}`,
  'statement is malformed': `The change did not arrive intact. ${START_AGAIN}`,
  'current kid is not the fingerprint of its key': `The new key does not match its fingerprint. ${START_AGAIN}`,
  'prev is not the pinned key': `The control plane key changed after this was prepared. ${START_AGAIN}`,
  'keyset is not above the pinned one': `Another change was approved first. ${START_AGAIN}`,
  'iat is in the future': `The change is dated in the future. Check this control plane's clock, then start again.`,
  'kind does not match whether the key changes': `The change did not arrive intact. ${START_AGAIN}`,
  'an approval is repeated': `The same passkey approved twice. ${START_AGAIN}`,
  'an approval does not verify': `A passkey approval did not check out. Use a marked passkey on this control plane's hostname and start again.`,
  'no rotation passkey is pinned': 'Mark a rotation passkey before you change the key.',
  'every marked passkey must prove possession': `Each passkey you mark has to approve the change itself. ${START_AGAIN}`,
  'no pinned passkey approved': `A marked passkey has to approve this change. ${START_AGAIN}`,
  'every passkey under the new rpId must prove possession': `Each passkey has to approve the change itself. ${START_AGAIN}`,
  'a removal needs a passkey that stays': `Unmarking needs approval from a passkey that stays marked. ${START_AGAIN}`,
  'an added passkey must prove possession': `Each passkey you mark has to approve the change itself. ${START_AGAIN}`,
}

/** The owner-facing sentence for a verifier refusal (the internal reason goes to the log). */
export function refusalWords(reason: KeysetRefusalReason): string {
  return REFUSAL_WORDS[reason]
}

type CandidateRow = {
  passkeyId: string
  userId: string
  email: string
  name: string | null
  credentialId: string
  publicKey: string
  deviceType: string
}

/** Every superadmin's sign-in passkeys, with what a rotation passkey needs. */
async function superadminPasskeys(db: Db, passkeyIds?: string[]): Promise<CandidateRow[]> {
  const conditions = [eq(user.role, 'superadmin')]
  if (passkeyIds) conditions.push(inArray(passkey.id, passkeyIds))
  return await db
    .select({
      passkeyId: passkey.id,
      userId: passkey.userId,
      email: user.email,
      name: passkey.name,
      credentialId: passkey.credentialId,
      publicKey: passkey.publicKey,
      deviceType: passkey.deviceType,
    })
    .from(passkey)
    .innerJoin(user, eq(user.id, passkey.userId))
    .where(and(...conditions))
}

async function candidateKey(row: CandidateRow): Promise<RotationPasskey | null> {
  const key = rotationKeyFromJwk(parseStoredPasskeyJwk(row.publicKey))
  return key ? { id: await rotationPasskeyId(row.credentialId), ...key } : null
}

function labelOf(row: CandidateRow): string {
  return `${row.name ?? 'Passkey'} (${row.email})`
}

function refuse(c: Context<AppEnv>, status: 404 | 409 | 422 | 503, error: string, message: string) {
  return c.json({ ok: false, error, message }, status)
}

type Loaded = {
  db: Db
  identity: PanelIdentity
  /** `pin.rpId` is empty only with nothing marked and no primary hostname configured. */
  pin: KeysetPin & { custodians: MarkedCustodian[] }
  /** The origins a browser on this control plane reports for the rotation hostname. */
  origins: readonly string[]
}

async function load(c: Context<AppEnv>, opts: KeyRotationOptions): Promise<Loaded | Response> {
  const db = getDb(c)
  if (!db) return refuse(c, 503, 'database_unavailable', 'Database unavailable')
  const identity = opts.panelIdentity ? await opts.panelIdentity() : null
  if (!identity) {
    return refuse(c, 404, 'identity_off', 'Control plane identity is off.')
  }
  await markAwaitingStatementLive(db, identity.current.kid)
  // The hostname comes from this control plane's own configuration only,
  // never from the request: the first mark freezes it on every server.
  const configured = await (opts.configuredOrigin ?? resolveConfiguredOrigin)(c)
  const pin = await controlPlanePin(db, identity, configured ? new URL(configured).hostname : null)
  const origins =
    configured && pin.rpId !== '' ? await webauthnOriginsFor(c, configured, pin.rpId) : []
  return { db, identity, pin, origins }
}

type PrepareBody = {
  kind: KeysetStatementKind
  mark: string[]
  unmark: string[]
  newKey: string | null
}

function stringList(value: unknown): string[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_ROTATION_PASSKEYS) return null
  return value.every((v) => typeof v === 'string') ? (value as string[]) : null
}

function parsePrepareBody(body: unknown): PrepareBody | null {
  if (typeof body !== 'object' || body === null) return null
  const record = body as Record<string, unknown>
  const kind = record.kind
  if (kind !== 'rotate' && kind !== 'revoke' && kind !== 'passkeys') return null
  const mark = stringList(record.mark)
  const unmark = stringList(record.unmark)
  if (!mark || !unmark) return null
  const newKey = typeof record.newKey === 'string' ? record.newKey : null
  return { kind, mark, unmark, newKey }
}

type Planned = { statement: Omit<KeysetStatement, 'type' | 'v'>; possession: string[] }

async function newKeyFor(
  c: Context<AppEnv>,
  opts: KeyRotationOptions,
  loaded: Loaded,
  body: PrepareBody
): Promise<{ kid: string; pub: string } | Response> {
  if (opts.runtime === 'deno') {
    if (!opts.dataEncryption) return refuse(c, 503, 'no_key_store', NO_KEY_STORE)
    // Emergency Revoke always moves to a key made now, never to one an
    // earlier prepare left behind.
    return await ensurePendingIdentityKey(loaded.db, opts.dataEncryption, {
      fresh: body.kind === 'revoke',
    })
  }
  // High Availability: the owner's terminal made the key; only its public half comes here.
  const raw = decodeBase64urlStrict(body.newKey)
  if (raw?.length !== 32) {
    return refuse(
      c,
      422,
      'new_key_required',
      'Run the key rotation command in your terminal and open the link it prints.'
    )
  }
  const kid = await fingerprintRawPublicKey(raw)
  if (kid === loaded.identity.current.kid) {
    return refuse(c, 422, 'same_key', 'The new key is the current key.')
  }
  return { kid, pub: base64urlEncode(raw) }
}

async function planKeyChange(
  c: Context<AppEnv>,
  opts: KeyRotationOptions,
  loaded: Loaded,
  body: PrepareBody
): Promise<Planned | Response> {
  if (loaded.pin.passkeys.length < MIN_PASSKEYS_TO_ROTATE) {
    return refuse(
      c,
      409,
      'not_enough_passkeys',
      'Mark at least two rotation passkeys before changing the key.'
    )
  }
  const current = await newKeyFor(c, opts, loaded, body)
  if (current instanceof Response) return current
  return {
    statement: {
      keyset: loaded.pin.keyset + 1,
      prev: loaded.pin.current,
      kind: body.kind,
      rpId: loaded.pin.rpId,
      current,
      passkeys: loaded.pin.passkeys,
      iat: Math.floor(Date.now() / 1000),
    },
    possession: [],
  }
}

async function planPasskeyChange(
  c: Context<AppEnv>,
  loaded: Loaded,
  body: PrepareBody
): Promise<Planned | Response> {
  if (loaded.pin.rpId === '') return refuse(c, 409, 'no_primary_hostname', NO_HOSTNAME_MESSAGE)
  const session = c.get('session')
  const rows = body.mark.length > 0 ? await superadminPasskeys(loaded.db, body.mark) : []
  const added: RotationPasskey[] = []
  for (const id of body.mark) {
    const row = rows.find((r) => r.passkeyId === id)
    // Marking proves possession in this browser, so only your own passkeys.
    if (!row || row.userId !== session?.userId) {
      return refuse(c, 422, 'passkey_not_yours', 'Mark one of your own sign-in passkeys.')
    }
    const key = await candidateKey(row)
    if (!key) {
      return refuse(c, 422, 'passkey_kind', "This passkey's type can't approve key changes.")
    }
    if (loaded.pin.passkeys.some((p) => p.id === key.id)) {
      return refuse(c, 409, 'already_marked', 'This passkey is already marked.')
    }
    added.push(key)
  }
  const unmarked = new Set(body.unmark)
  if (![...unmarked].every((id) => loaded.pin.passkeys.some((p) => p.id === id))) {
    return refuse(c, 422, 'not_marked', 'Only a marked passkey can be unmarked.')
  }
  const passkeys = [...loaded.pin.passkeys.filter((p) => !unmarked.has(p.id)), ...added]
  if (added.length === 0 && unmarked.size === 0) {
    return refuse(c, 422, 'nothing_to_change', 'Choose a passkey to mark or unmark.')
  }
  if (passkeys.length < 1 || passkeys.length > MAX_ROTATION_PASSKEYS) {
    return refuse(c, 422, 'passkey_count', 'Keep between one and five rotation passkeys.')
  }
  return {
    statement: {
      keyset: loaded.pin.keyset + 1,
      prev: loaded.pin.current,
      kind: 'passkeys',
      rpId: loaded.pin.rpId,
      current: {
        kid: loaded.identity.current.kid,
        pub: base64urlEncode(loaded.identity.current.publicRaw),
      },
      passkeys,
      iat: Math.floor(Date.now() / 1000),
    },
    possession: rows.filter((r) => body.mark.includes(r.passkeyId)).map((r) => r.credentialId),
  }
}

/** Credential ids of the marked passkeys (the browser's `allowCredentials`). */
async function approverCredentialIds(db: Db, custodians: MarkedCustodian[]): Promise<string[]> {
  const ids = custodians.map((a) => a.passkeyId).filter((id): id is string => id !== null)
  if (ids.length === 0) return []
  const rows = await db
    .select({ credentialId: passkey.credentialId })
    .from(passkey)
    .where(inArray(passkey.id, ids))
  return rows.map((r) => r.credentialId)
}

type ApproveBody = {
  statement: string
  approvals: {
    credentialId: string
    authenticatorData: string
    clientDataJSON: string
    signature: string
  }[]
}

const B64URL_FIELD = /^[A-Za-z0-9_-]+$/

/**
 * The approve body, or null. Sizes are capped here, before anything is
 * hashed or decoded: at most ten approvals, every field unpadded base64url,
 * and the whole thing within the envelope cap servers enforce.
 */
export function parseApproveBody(body: unknown): ApproveBody | null {
  if (typeof body !== 'object' || body === null) return null
  const record = body as Record<string, unknown>
  if (typeof record.statement !== 'string' || !Array.isArray(record.approvals)) return null
  if (record.approvals.length > MAX_ROTATION_PASSKEYS * 2) return null
  let size = record.statement.length
  const approvals: ApproveBody['approvals'] = []
  for (const entry of record.approvals) {
    if (typeof entry !== 'object' || entry === null) return null
    const a = entry as Record<string, unknown>
    const fields = [a.credentialId, a.authenticatorData, a.clientDataJSON, a.signature]
    if (!fields.every((f): f is string => typeof f === 'string' && B64URL_FIELD.test(f))) {
      return null
    }
    const [credentialId, authenticatorData, clientDataJSON, signature] = fields
    size += fields.reduce((sum, f) => sum + f.length, 0)
    if (size > KEYSET_ENVELOPE_MAX_BYTES) return null
    approvals.push({
      credentialId: credentialId!,
      authenticatorData: authenticatorData!,
      clientDataJSON: clientDataJSON!,
      signature: signature!,
    })
  }
  return B64URL_FIELD.test(record.statement) ? { statement: record.statement, approvals } : null
}

/** The approvals keyed by rotation passkey id, or null when a credential id does not decode. */
async function approvalsById(body: ApproveBody): Promise<KeysetEnvelope['approvals'] | null> {
  try {
    return await Promise.all(
      body.approvals.map(async (a) => ({
        id: await rotationPasskeyId(a.credentialId),
        authenticatorData: a.authenticatorData,
        clientDataJSON: a.clientDataJSON,
        signature: a.signature,
      }))
    )
  } catch {
    return null
  }
}

/**
 * Whether every approval was made on one of this control plane's own
 * addresses. Servers accept any port or subdomain of the hostname (they
 * cannot know the port), so the stricter check lives here, where the
 * approval is taken.
 */
export function approvalsFromOwnOrigin(
  approvals: readonly { clientDataJSON: string }[],
  origins: readonly string[]
): boolean {
  return approvals.every((approval) => {
    const bytes = decodeBase64urlStrict(approval.clientDataJSON)
    if (!bytes) return false
    try {
      const clientData = JSON.parse(new TextDecoder().decode(bytes)) as { origin?: unknown }
      return typeof clientData.origin === 'string' && origins.includes(clientData.origin)
    } catch {
      return false
    }
  })
}

/** Added passkeys must be the session user's own sign-in passkeys with the same key. */
async function addedMarks(
  db: Db,
  userId: string,
  statement: KeysetStatement,
  pin: KeysetPin
): Promise<CustodianMark[] | null> {
  const added = statement.passkeys.filter((p) => !pin.passkeys.some((q) => q.id === p.id))
  if (added.length === 0) return []
  const rows = (await superadminPasskeys(db)).filter((r) => r.userId === userId)
  const candidates = await Promise.all(
    rows.map(async (row) => ({ row, key: await candidateKey(row) }))
  )
  const marks: CustodianMark[] = []
  for (const key of added) {
    const match = candidates.find(
      (c) => c.key?.id === key.id && c.key.alg === key.alg && c.key.pub === key.pub
    )?.row
    if (!match) return null
    marks.push({ ...key, passkeyId: match.passkeyId, rpId: statement.rpId, label: labelOf(match) })
  }
  return marks
}

function auditAction(statement: KeysetStatement, marks: CustodianMark[]) {
  if (statement.kind === 'rotate') return 'panel.key.rotate' as const
  if (statement.kind === 'revoke') return 'panel.key.revoke' as const
  return marks.length > 0 ? ('panel.approver.mark' as const) : ('panel.approver.unmark' as const)
}

/** Checks that need no signature: freshness, the hostname and the passkey count. */
function refuseBeforeVerify(
  c: Context<AppEnv>,
  parsed: KeysetStatement,
  pin: KeysetPin,
  nowSeconds: number
): Response | null {
  if (pin.rpId === '') return refuse(c, 409, 'no_primary_hostname', NO_HOSTNAME_MESSAGE)
  // The chain has no gaps: every statement is exactly one above the last.
  if (parsed.keyset !== pin.keyset + 1) {
    return refuse(c, 409, 'statement_conflict', 'Another change was approved first. Start again.')
  }
  if (parsed.iat < nowSeconds - PREPARED_STATEMENT_MAX_AGE_SECONDS) {
    return refuse(c, 409, 'statement_expired', 'This approval took too long. Start again.')
  }
  if (parsed.rpId !== pin.rpId) {
    return refuse(
      c,
      422,
      'rp_id_move',
      'Moving rotation passkeys to another hostname is not available yet.'
    )
  }
  if (parsed.kind !== 'passkeys' && pin.passkeys.length < MIN_PASSKEYS_TO_ROTATE) {
    return refuse(
      c,
      409,
      'not_enough_passkeys',
      'Mark at least two rotation passkeys before changing the key.'
    )
  }
  // A key change keeps the passkeys as they are. On High Availability it
  // waits for its key, and a waiting change must be cancellable by removing
  // one row, with no mark to undo.
  if (parsed.kind !== 'passkeys' && !samePasskeySet(parsed.passkeys, pin.passkeys)) {
    return refuse(
      c,
      422,
      'passkeys_in_key_change',
      'A key change cannot mark or unmark passkeys. Do that as its own change.'
    )
  }
  return null
}

function samePasskeySet(a: readonly RotationPasskey[], b: readonly RotationPasskey[]): boolean {
  return (
    a.length === b.length &&
    a.every((p) => b.some((q) => q.id === p.id && q.alg === p.alg && q.pub === p.pub))
  )
}

type ApprovedChange = {
  db: Db
  parsed: KeysetStatement
  envelope: KeysetEnvelope
  state: 'awaiting_key' | 'live'
  marks: CustodianMark[]
  unmark: string[]
  userId: string | null
}

/** One transaction: the statement, the marks, and (self-hosted) the stored key and key set. */
async function storeApproved(
  opts: KeyRotationOptions,
  change: ApprovedChange
): Promise<'stored' | 'conflict' | 'pending_key_changed'> {
  const { db, parsed, envelope, state, marks, unmark } = change
  const keyChanges = parsed.kind !== 'passkeys'
  try {
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db
      await insertStatement(txDb, {
        keyset: parsed.keyset,
        kind: parsed.kind,
        state,
        prevKid: parsed.prev,
        currentKid: parsed.current.kid,
        envelope,
        approvedByUserId: change.userId,
      })
      await applyCustodianChanges(txDb, { keyset: parsed.keyset, mark: marks, unmark })
      if (opts.runtime !== 'deno') return
      if (!keyChanges) {
        await raiseStoredIdentityKeyset(txDb, parsed.keyset)
        return
      }
      if (!opts.dataEncryption) throw new Error(NO_KEY_STORE)
      await promotePendingIdentityKey(txDb, opts.dataEncryption, {
        kid: parsed.current.kid,
        keyset: parsed.keyset,
      })
    })
  } catch (err) {
    const outcome = approvalStoreFailure(err)
    if (outcome) return outcome
    throw err
  }
  return 'stored'
}

/**
 * What a failed store of an approved change tells the owner, or null for a
 * real fault (a 500). Another approval taking the key set first and a lost
 * compare-and-set on the stored key (something changed it while this ran)
 * are both a 409 "start again"; so is a pending key that moved on.
 */
export function approvalStoreFailure(err: unknown): 'conflict' | 'pending_key_changed' | null {
  if (isPostgresUniqueViolation(err)) return 'conflict'
  if (!(err instanceof Error)) return null
  if (err.message === STORED_IDENTITY_CHANGED) return 'conflict'
  if (err.message === PENDING_KEY_MISMATCH) return 'pending_key_changed'
  return null
}

type ApprovalFacts = {
  parsed: KeysetStatement
  pin: KeysetPin & { custodians: MarkedCustodian[] }
  marks: CustodianMark[]
  unmark: string[]
  state: 'awaiting_key' | 'live'
  pinnedApprovals: string[]
}

/**
 * The audit action and context of an approved change; the mail to every
 * superadmin renders from this context (`panel.key_changed`,
 * `panel.approvers_changed`). `marked` and `unmarked` name the passkeys each
 * way, so a statement that does both says both. Pure, so tests render it.
 */
export function approvalAudit(input: ApprovalFacts): Pick<AuditEntry, 'action' | 'context'> {
  const { parsed, pin, marks, unmark } = input
  const approver = pin.custodians.find((a) => input.pinnedApprovals.includes(a.id))
  const unmarked = pin.custodians
    .filter((a) => unmark.includes(a.id))
    .map((a) => a.label ?? 'a passkey')
  const marked = marks.map((m) => m.label ?? 'a passkey')
  return {
    action: auditAction(parsed, marks),
    context: {
      kind: parsed.kind,
      keyset: parsed.keyset,
      oldFingerprint: parsed.prev,
      newFingerprint: parsed.current.kid,
      passkey: approver?.label ?? marks[0]?.label ?? null,
      marked: marked.length > 0 ? marked.join(', ') : null,
      unmarked: unmarked.length > 0 ? unmarked.join(', ') : null,
      state: input.state,
    },
  }
}

/** Audit row, notification and mail to every superadmin for an approved change. */
async function auditApproval(c: Context<AppEnv>, input: ApprovalFacts): Promise<void> {
  const session = c.get('session')
  await recordKeyEvent(c, {
    organizationId: null,
    actorUserId: session?.userId ?? null,
    actorEmail: session?.email ?? null,
    targetType: 'instance',
    ...approvalAudit(input),
  })
}

/**
 * Self-hosted: swap the running key for the stored one. The change is already
 * committed, so a failure here must not skip the audit row and the mail; it
 * is logged, and the control plane signs with the old key until it restarts.
 */
async function reloadIdentity(opts: KeyRotationOptions, keyset: number): Promise<void> {
  if (opts.runtime !== 'deno') return
  try {
    await opts.onIdentityChanged?.()
  } catch (err) {
    logWarn(
      'key-rotation',
      `key set ${keyset} is stored but the running control plane did not reload its key (${
        err instanceof Error ? err.name : 'unknown'
      }); restart the control plane`
    )
  }
}

type CheckedApproval = {
  envelope: KeysetEnvelope
  parsed: KeysetStatement
  pinnedApprovals: string[]
}

/** Every check between the request body and the store; a Response is the refusal. */
async function checkApproval(
  c: Context<AppEnv>,
  body: ApproveBody,
  loaded: Loaded
): Promise<CheckedApproval | Response> {
  const { pin } = loaded
  const approvals = await approvalsById(body)
  const envelope = approvals ? parseKeysetEnvelope({ statement: body.statement, approvals }) : null
  const bytes = envelope ? decodeBase64urlStrict(envelope.statement) : null
  const parsed = bytes ? parseKeysetStatement(bytes) : null
  if (!envelope || !parsed) {
    return refuse(c, 422, 'invalid_statement', 'The change did not arrive intact. Start again.')
  }
  const nowSeconds = Math.floor(Date.now() / 1000)
  const early = refuseBeforeVerify(c, parsed, pin, nowSeconds)
  if (early) return early
  if (!approvalsFromOwnOrigin(envelope.approvals, loaded.origins)) {
    return refuse(
      c,
      422,
      'approval_origin',
      "Approve this change on this control plane's own address, then start again."
    )
  }
  const verified = await verifyKeysetEnvelope(envelope, pin, nowSeconds)
  if (!verified.ok) {
    logWarn('key-rotation', `key set ${parsed.keyset} not approved: ${verified.reason}`)
    return refuse(c, 422, 'approval_refused', refusalWords(verified.reason))
  }
  return { envelope, parsed, pinnedApprovals: verified.pinnedApprovals }
}

async function approve(c: Context<AppEnv>, opts: KeyRotationOptions): Promise<Response> {
  const body = parseApproveBody(await c.req.json().catch(() => null))
  if (!body) return refuse(c, 422, 'invalid_body', 'expected { statement, approvals }')
  const stepUp = await requireInstanceStepUp(c, 'panel.key.change')
  if (stepUp) return stepUp
  const loaded = await load(c, opts)
  if (loaded instanceof Response) return loaded
  const { db, pin } = loaded
  // A waiting key change owns the next key set: anything approved now would
  // go live ahead of it and the waiting change could then never apply.
  if (await readAwaitingKeyStatement(db)) {
    return refuse(c, 409, 'awaiting_key', AWAITING_KEY_MESSAGE)
  }
  const checked = await checkApproval(c, body, loaded)
  if (checked instanceof Response) return checked
  const { envelope, parsed } = checked
  const session = c.get('session')
  const marks = await addedMarks(db, session?.userId ?? '', parsed, pin)
  if (!marks) return refuse(c, 422, 'passkey_not_yours', 'Mark one of your own sign-in passkeys.')
  const unmark = pin.passkeys
    .filter((p) => !parsed.passkeys.some((q) => q.id === p.id))
    .map((p) => p.id)
  const keyChanges = parsed.kind !== 'passkeys'
  const state = opts.runtime === 'workers' && keyChanges ? 'awaiting_key' : 'live'
  const stored = await storeApproved(opts, {
    db,
    parsed,
    envelope,
    state,
    marks,
    unmark,
    userId: session?.userId ?? null,
  })
  if (stored === 'conflict') {
    return refuse(c, 409, 'statement_conflict', 'Another change was approved first. Start again.')
  }
  if (stored === 'pending_key_changed') {
    return refuse(c, 409, 'pending_key_changed', 'The new key changed. Start again.')
  }
  await reloadIdentity(opts, parsed.keyset)
  await auditApproval(c, {
    parsed,
    pin,
    marks,
    unmark,
    state,
    pinnedApprovals: checked.pinnedApprovals,
  })
  return c.json({ ok: true, keyset: parsed.keyset, kind: parsed.kind, state, envelope })
}

/**
 * Cancel a High Availability key change that waits for its key. Allowed only
 * while this control plane does not sign with that key: the delete itself
 * carries the condition, so a change that just went live is never removed.
 * It cannot see a key the terminal stored a moment ago that this isolate has
 * not loaded yet, which is why the screen asks the owner to cancel only when
 * the rotation command did not store the key.
 */
async function cancelWaiting(c: Context<AppEnv>, opts: KeyRotationOptions): Promise<Response> {
  const keyset = Number(c.req.param('keyset'))
  if (!Number.isSafeInteger(keyset)) return refuse(c, 404, 'not_found', 'Not found')
  const stepUp = await requireInstanceStepUp(c, 'panel.key.change')
  if (stepUp) return stepUp
  const loaded = await load(c, opts)
  if (loaded instanceof Response) return loaded
  const { db, identity } = loaded
  const removed = await deleteAwaitingStatement(db, keyset, identity.current.kid)
  if (!removed) {
    const found = await readStatement(db, keyset)
    if (!found) return refuse(c, 404, 'not_found', 'Not found')
    return refuse(
      c,
      409,
      'not_waiting',
      'This change is already in use by servers and cannot be cancelled.'
    )
  }
  const session = c.get('session')
  await recordAudit(db, {
    organizationId: null,
    actorUserId: session?.userId ?? null,
    actorEmail: session?.email ?? null,
    action: 'panel.key.cancel',
    targetType: 'instance',
    context: {
      kind: removed.kind,
      keyset: removed.keyset,
      oldFingerprint: removed.prevKid,
      newFingerprint: removed.currentKid,
    },
  })
  return c.json({ ok: true, keyset: removed.keyset, cancelled: true })
}

async function prepare(c: Context<AppEnv>, opts: KeyRotationOptions): Promise<Response> {
  const body = parsePrepareBody(await c.req.json().catch(() => null))
  if (!body) return refuse(c, 422, 'invalid_body', 'expected { kind, mark?, unmark?, newKey? }')
  const stepUp = await requireInstanceStepUp(c, 'panel.key.change')
  if (stepUp) return stepUp
  const loaded = await load(c, opts)
  if (loaded instanceof Response) return loaded
  if (await readAwaitingKeyStatement(loaded.db)) {
    return refuse(c, 409, 'awaiting_key', AWAITING_KEY_MESSAGE)
  }
  const planned =
    body.kind === 'passkeys'
      ? await planPasskeyChange(c, loaded, body)
      : await planKeyChange(c, opts, loaded, body)
  if (planned instanceof Response) return planned
  const bytes = new TextEncoder().encode(serializeKeysetStatement(planned.statement))
  return c.json({
    ok: true,
    statement: base64urlEncode(bytes),
    challenge: await keysetStatementChallenge(bytes),
    rpId: planned.statement.rpId,
    keyset: planned.statement.keyset,
    kind: planned.statement.kind,
    oldFingerprint: planned.statement.prev,
    newFingerprint: planned.statement.current.kid,
    approverCredentialIds: await approverCredentialIds(loaded.db, loaded.pin.custodians),
    possessionCredentialIds: planned.possession,
  })
}

async function readRotation(c: Context<AppEnv>, opts: KeyRotationOptions): Promise<Response> {
  const loaded = await load(c, opts)
  if (loaded instanceof Response) return loaded
  const { db, pin } = loaded
  const rows = await superadminPasskeys(db)
  const session = c.get('session')
  const candidates = await Promise.all(
    rows.map(async (row) => {
      const key = await candidateKey(row)
      return {
        passkeyId: row.passkeyId,
        name: row.name,
        ownerEmail: row.email,
        isOwn: row.userId === session?.userId,
        isDeviceBound: row.deviceType === 'singleDevice',
        canApprove: key !== null,
        isMarked: key !== null && pin.passkeys.some((p) => p.id === key.id),
        rotationId: key?.id ?? null,
      }
    })
  )
  const marked = candidates.filter((c) => c.isMarked)
  const awaiting = await readAwaitingKeyStatement(db)
  const statements = await listRecentStatements(db)
  return c.json({
    ok: true,
    runtime: opts.runtime,
    rpId: pin.rpId,
    keyset: pin.keyset,
    fingerprint: pin.current,
    markedCount: pin.passkeys.length,
    canRotate: pin.passkeys.length >= MIN_PASSKEYS_TO_ROTATE && awaiting === null,
    hasDeviceBound: marked.some((c) => c.isDeviceBound),
    passkeys: candidates,
    awaitingKey: awaiting
      ? { keyset: awaiting.keyset, kind: awaiting.kind, newFingerprint: awaiting.currentKid }
      : null,
    statements: statements.map((s) => ({
      keyset: s.keyset,
      kind: s.kind,
      state: s.state,
      oldFingerprint: s.prevKid,
      newFingerprint: s.currentKid,
      createdAt: s.createdAt,
    })),
  })
}

export function registerKeyRotationRoutes(admin: Hono<AppEnv>, opts: KeyRotationOptions): void {
  const rootOnly = createRootOnlyMiddleware(opts.secrets)
  admin.get('/instance/identity/rotation', rootOnly, (c) => readRotation(c, opts))
  admin.post('/instance/identity/statements/prepare', rootOnly, (c) => prepare(c, opts))
  admin.post('/instance/identity/statements', rootOnly, (c) => approve(c, opts))
  admin.get('/instance/identity/statements/:keyset', rootOnly, async (c) => {
    const db = getDb(c)
    if (!db) return refuse(c, 503, 'database_unavailable', 'Database unavailable')
    const keyset = Number(c.req.param('keyset'))
    const found = Number.isSafeInteger(keyset) ? await readStatement(db, keyset) : null
    if (!found) return refuse(c, 404, 'not_found', 'Not found')
    c.header('content-disposition', `attachment; filename="key-set-${found.keyset}.json"`)
    return c.json(found.envelope)
  })
  admin.delete('/instance/identity/statements/:keyset', rootOnly, (c) => cancelWaiting(c, opts))
}
