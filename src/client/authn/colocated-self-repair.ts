/**
 * Co-located daemon credential self-repair (self-hosted Deno runtime only).
 *
 * The control plane wrote the co-located daemon's license id, license token
 * and server id files at install. If those files later stop matching the
 * control plane's own record of its co-located seat, the daemon is refused
 * with `401 Invalid license` or `409 Server key already registered` and stays
 * offline until someone repairs it by hand.
 *
 * {@link createColocatedSelfRepair} checks only after such a refusal came
 * straight in on the control plane's Unix socket (`isDirectLocalSocketRequest`
 * in `src/lib/peer-address.ts`): only local processes in group `tp` (the
 * daemon among them) can open that socket and connect back that way, while
 * public traffic reaches the same socket through Caddy and is never counted. A parked daemon retries every few minutes, which
 * brings the next refusal; there is no boot-time check. When the files do not
 * match it:
 *
 * 1. re-issues the token on the EXISTING bound license (same id, same seat),
 * 2. clears the stored daemon key of that one server, only while it is still
 *    the key that was diagnosed, when the daemon on disk no longer holds it,
 * 3. writes the server id, license id and license token files (in that order).
 *
 * Steps 1 and 2 run in one transaction under an advisory lock, after the
 * diagnosis is repeated inside it, so two control plane processes sharing a
 * database (or a daemon enrolling at the same moment) cannot race it.
 *
 * It also acts only when the license id or server id on disk names a row in
 * this database (checked again under the lock): files from another control
 * plane's database are never rewritten.
 *
 * {@link repairColocatedCredentialsOnRequest} is the same locked re-issue for
 * an owner who asked for it (`POST /servers/:id/colocated-repair`): it skips
 * the known-id check and re-issues even when the files look right.
 *
 * Nothing here creates a server, touches another server, or runs without a
 * bound co-located seat. A revoked key is left alone: revocation is sticky
 * and only an owner lifts it.
 *
 * Plaintext tokens are never stored: a bound license has its token hash
 * erased, so a match is judged on the ids and on the daemon's key (the public
 * key fingerprint from its key file when readable, else its key id file); the
 * token itself is checked (by hash) only before the daemon has enrolled.
 */
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { license as licenseTable, server as serverTable } from '../../db/schema.ts'
import { compatLogInfo, compatLogWarn } from '../../lib/log-compat.ts'
import { verifyLicenseToken } from '../../features/licenses/license.ts'
import {
  clearServerDaemonStateIfKey,
  getServerDaemonStateByServerId,
} from '../../features/servers/server-identity-db.ts'
import { isDaemonKeyActive } from '../../features/servers/daemon-state.ts'
import { computePublicKeyFingerprint } from '../../daemon/authn/server-key.ts'
import {
  assertColocatedCredentialsDirWritable,
  COLOCATED_LICENSE_ID_FILE,
  COLOCATED_LICENSE_TOKEN_FILE,
  COLOCATED_SERVER_ID_FILE,
  COLOCATED_SERVER_KEY_FILE,
  COLOCATED_SERVER_KEY_ID_FILE,
  resolveColocatedLicenseCredentialsDir,
} from './colocated-credentials-dir.ts'
import {
  findActiveBoundColocatedLicense,
  findDefaultInstalledOrganizationId,
  persistColocatedLicenseCredentials,
  rotateLicenseTokenInPlace,
} from './install-state.ts'

/** At most one check every ten minutes, whatever triggers it. */
export const COLOCATED_SELF_REPAIR_MIN_INTERVAL_MS = 10 * 60 * 1000
/** First retry after a failed repair; doubles up to the ceiling. */
export const COLOCATED_SELF_REPAIR_RETRY_BASE_MS = 60 * 1000
export const COLOCATED_SELF_REPAIR_RETRY_MAX_MS = 30 * 60 * 1000
/** Retries stop once no socket refusal has come in for this long. */
export const COLOCATED_SELF_REPAIR_REFUSAL_WINDOW_MS = 60 * 60 * 1000

/** Advisory lock name: one co-located repair at a time per database. */
const COLOCATED_REPAIR_LOCK = 'turbopanel:colocated-credential-repair'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ColocatedSeat = { licenseId: string; serverId: string }

/** The stored daemon key of the seat's server, or null before it enrolled. */
export type StoredDaemonKey = { id: string; fingerprint: string; active: boolean } | null

/**
 * One daemon state value: its trimmed text, `null` when the file does not
 * exist, or `undefined` when it exists but could not be read or parsed.
 */
export type DiskValue = string | null | undefined

export type ColocatedDiskState = {
  licenseId: DiskValue
  licenseToken: DiskValue
  serverId: DiskValue
  keyId: DiskValue
  /** Fingerprint of the public key in the daemon's key file. */
  keyFingerprint: DiskValue
}

/** Database reads and writes; the locked variant runs inside the transaction. */
export type ColocatedRepairQueries = {
  findSeat(): Promise<ColocatedSeat | null>
  storedKey(serverId: string): Promise<StoredDaemonKey>
  /** Argon2 hash still on the license, or null once a bind erased it. */
  licenseTokenHash(licenseId: string): Promise<string | null>
  verifyToken(plaintext: string, hashed: string): Promise<boolean>
  licenseExists(licenseId: string): Promise<boolean>
  serverExists(serverId: string): Promise<boolean>
  /** New token on the same license; returns the plaintext. */
  rotateToken(licenseId: string): Promise<string>
  /** Remove the server's key only while it is still `keyId`. */
  clearKey(serverId: string, keyId: string): Promise<boolean>
}

export type ColocatedRepairStore = ColocatedRepairQueries & {
  /** Run `fn` in one transaction holding the co-located repair advisory lock. */
  locked<T>(fn: (queries: ColocatedRepairQueries) => Promise<T>): Promise<T>
}

/** The disk side of the repair; the default reads and writes the real files. */
export type ColocatedRepairDisk = {
  /** Throws in a test run aimed at a real state dir; checked before any write. */
  assertWritable(): void
  /** True when any daemon file is in the dir; a bare dir is never written into. */
  hasDaemonFiles(): Promise<boolean>
  read(): Promise<ColocatedDiskState>
  write(seat: ColocatedSeat, token: string): Promise<boolean>
}

export type ColocatedRepairOutcome =
  | { status: 'skipped'; reason: string }
  | { status: 'not-ours'; reason: string }
  | { status: 'rate-limited' }
  | { status: 'ok' }
  | { status: 'blocked'; reason: string }
  | { status: 'repaired'; serverId: string; reasons: string[]; clearedKey: boolean }
  | { status: 'failed'; serverId: string; reason: string }

export type ColocatedDiagnosis =
  | { kind: 'ok' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'mismatch'; reasons: string[]; clearKeyId: string | null }

// ── Ownership ────────────────────────────────────────────────────────────

/** At least one id on disk must name a row in this database. */
async function diskIdsKnown(
  queries: ColocatedRepairQueries,
  disk: ColocatedDiskState
): Promise<boolean> {
  if (typeof disk.licenseId === 'string' && UUID_PATTERN.test(disk.licenseId)) {
    if (await queries.licenseExists(disk.licenseId)) return true
  }
  if (typeof disk.serverId === 'string' && UUID_PATTERN.test(disk.serverId)) {
    if (await queries.serverExists(disk.serverId)) return true
  }
  return false
}

// ── Diagnosis ────────────────────────────────────────────────────────────

/**
 * What is wrong with the daemon's key (or, before enrollment, its token
 * file), and whether the stored key is no longer the daemon's.
 */
function daemonKeyProblem(
  disk: ColocatedDiskState,
  key: StoredDaemonKey
): { reason: string; keyGone: boolean } | null {
  if (!key) {
    return disk.licenseToken === null
      ? { reason: 'the license token file is missing before enrollment', keyGone: false }
      : null
  }
  // The key file, when readable, is the authority: its public key either is
  // the stored key or is not, whatever the key id file says.
  if (typeof disk.keyFingerprint === 'string') {
    return disk.keyFingerprint === key.fingerprint
      ? null
      : { reason: 'the daemon key file holds a different key', keyGone: true }
  }
  if (disk.keyFingerprint === null) {
    return { reason: 'the daemon key file is missing while a key is stored', keyGone: true }
  }
  // Key file unreadable: a key id that names another key counts, a missing
  // key id file alone does not.
  if (typeof disk.keyId === 'string' && disk.keyId !== key.id) {
    return { reason: 'the daemon key id differs from the stored key', keyGone: true }
  }
  return null
}

/**
 * Compare the files on disk with the seat. Pure: the token check (an Argon2
 * verify) is the caller's, and only asked for when nothing else is wrong.
 */
export function diagnoseColocatedCredentials(
  seat: ColocatedSeat,
  disk: ColocatedDiskState,
  key: StoredDaemonKey
): ColocatedDiagnosis | { kind: 'check-token' } {
  if (key && !key.active) {
    return { kind: 'blocked', reason: 'the stored daemon key is revoked' }
  }
  const reasons: string[] = []
  if (disk.licenseId !== undefined && disk.licenseId !== seat.licenseId) {
    reasons.push('license.id does not match the co-located license')
  }
  const serverIdWrong = disk.serverId !== undefined && disk.serverId !== seat.serverId
  if (serverIdWrong) reasons.push('server.id does not match the co-located server')
  const keyProblem = daemonKeyProblem(disk, key)
  if (keyProblem) reasons.push(keyProblem.reason)
  if (reasons.length > 0) {
    // A daemon that still holds the stored key under the right server id
    // keeps working: only its license files are rewritten.
    const clearKey = keyProblem?.keyGone === true || serverIdWrong
    return { kind: 'mismatch', reasons, clearKeyId: clearKey && key ? key.id : null }
  }
  if (!key && typeof disk.licenseToken === 'string') return { kind: 'check-token' }
  return { kind: 'ok' }
}

async function diagnose(
  queries: ColocatedRepairQueries,
  seat: ColocatedSeat,
  disk: ColocatedDiskState
): Promise<ColocatedDiagnosis> {
  const key = await queries.storedKey(seat.serverId)
  const first = diagnoseColocatedCredentials(seat, disk, key)
  if (first.kind !== 'check-token') return first
  const hash = await queries.licenseTokenHash(seat.licenseId)
  const matches =
    hash !== null && typeof disk.licenseToken === 'string'
      ? await queries.verifyToken(disk.licenseToken, hash)
      : false
  if (matches) return { kind: 'ok' }
  return {
    kind: 'mismatch',
    reasons: ['the license token file does not verify against the co-located license'],
    clearKeyId: null,
  }
}

// ── Disk ─────────────────────────────────────────────────────────────────

async function readStateFile(path: string): Promise<DiskValue> {
  try {
    return (await Deno.readTextFile(path)).trim()
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null
    return undefined
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path)
    return true
  } catch {
    return false
  }
}

/** Fingerprint of the public half of the daemon's key file; the private half is never kept. */
async function readKeyFingerprint(path: string): Promise<DiskValue> {
  const text = await readStateFile(path)
  if (typeof text !== 'string') return text
  try {
    const parsed = JSON.parse(text) as { publicJwk?: JsonWebKey }
    const jwk = parsed.publicJwk
    if (typeof jwk?.x !== 'string') return undefined
    return await computePublicKeyFingerprint(jwk)
  } catch {
    return undefined
  }
}

const DAEMON_EVIDENCE_FILES = [
  COLOCATED_LICENSE_ID_FILE,
  COLOCATED_SERVER_ID_FILE,
  COLOCATED_SERVER_KEY_ID_FILE,
  COLOCATED_SERVER_KEY_FILE,
]

/** Reads and writes the resolved co-located credentials dir. */
export function createColocatedRepairDisk(
  dir: () => string = resolveColocatedLicenseCredentialsDir
): ColocatedRepairDisk {
  return {
    assertWritable: () => assertColocatedCredentialsDirWritable(dir()),
    async hasDaemonFiles() {
      const stateDir = dir()
      const found = await Promise.all(DAEMON_EVIDENCE_FILES.map((f) => exists(`${stateDir}/${f}`)))
      return found.some(Boolean)
    },
    async read() {
      const stateDir = dir()
      const [licenseId, licenseToken, serverId, keyId, keyFingerprint] = await Promise.all([
        readStateFile(`${stateDir}/${COLOCATED_LICENSE_ID_FILE}`),
        readStateFile(`${stateDir}/${COLOCATED_LICENSE_TOKEN_FILE}`),
        readStateFile(`${stateDir}/${COLOCATED_SERVER_ID_FILE}`),
        readStateFile(`${stateDir}/${COLOCATED_SERVER_KEY_ID_FILE}`),
        readKeyFingerprint(`${stateDir}/${COLOCATED_SERVER_KEY_FILE}`),
      ])
      return { licenseId, licenseToken, serverId, keyId, keyFingerprint }
    },
    write: (seat, token) =>
      persistColocatedLicenseCredentials(seat.licenseId, token, seat.serverId),
  }
}

// ── Database ─────────────────────────────────────────────────────────────

function createQueries(db: Db): ColocatedRepairQueries {
  return {
    async findSeat() {
      const organizationId = await findDefaultInstalledOrganizationId(db)
      if (!organizationId) return null
      const bound = await findActiveBoundColocatedLicense(db, organizationId)
      return bound ? { licenseId: bound.id, serverId: bound.serverId } : null
    },
    async storedKey(serverId) {
      const state = await getServerDaemonStateByServerId(db, serverId)
      if (!state) return null
      return {
        id: state.key.id,
        fingerprint: state.key.fingerprint,
        active: isDaemonKeyActive(state.key),
      }
    },
    async licenseTokenHash(licenseId) {
      const rows = await db
        .select({ token: licenseTable.token })
        .from(licenseTable)
        .where(and(eq(licenseTable.id, licenseId), isNull(licenseTable.revokedAt)))
        .limit(1)
      return rows[0]?.token ?? null
    },
    verifyToken: verifyLicenseToken,
    async licenseExists(licenseId) {
      const rows = await db
        .select({ id: licenseTable.id })
        .from(licenseTable)
        .where(eq(licenseTable.id, licenseId))
        .limit(1)
      return rows.length > 0
    },
    async serverExists(serverId) {
      const rows = await db
        .select({ id: serverTable.id })
        .from(serverTable)
        .where(eq(serverTable.id, serverId))
        .limit(1)
      return rows.length > 0
    },
    async rotateToken(licenseId) {
      return (await rotateLicenseTokenInPlace(db, licenseId)).licenseToken
    },
    clearKey: (serverId, keyId) => clearServerDaemonStateIfKey(db, serverId, keyId),
  }
}

/** The real queries, on the process-long Deno database client. */
export function createColocatedRepairStore(db: Db): ColocatedRepairStore {
  return {
    ...createQueries(db),
    locked(fn) {
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${COLOCATED_REPAIR_LOCK}, 0))`
        )
        return fn(createQueries(tx))
      })
    },
  }
}

// ── One pass ─────────────────────────────────────────────────────────────

type LockedResult =
  | { kind: 'done'; outcome: ColocatedRepairOutcome }
  | { kind: 'write'; seat: ColocatedSeat; token: string; reasons: string[]; clearedKey: boolean }

const NOT_OURS_IDS: ColocatedRepairOutcome = {
  status: 'not-ours',
  reason: 'no id on disk names a row in this database',
}

/**
 * How a pass decides. The automatic pass needs an id on disk known here and
 * leaves healthy files alone; a repair an owner asked for skips the first
 * check and re-issues even when nothing looks wrong.
 */
type ReissueMode = { requireKnownIds: boolean; reissueWhenOk: boolean }

const AUTOMATIC: ReissueMode = { requireKnownIds: true, reissueWhenOk: false }
const ON_REQUEST: ReissueMode = { requireKnownIds: false, reissueWhenOk: true }

/**
 * Diagnose with the given queries. `done` ends the pass; `reissue` names what
 * is wrong and which stored key (if any) to clear.
 */
async function decide(
  queries: ColocatedRepairQueries,
  seat: ColocatedSeat,
  state: ColocatedDiskState,
  mode: ReissueMode
): Promise<
  | { kind: 'done'; outcome: ColocatedRepairOutcome }
  | { kind: 'reissue'; reasons: string[]; clearKeyId: string | null }
> {
  if (mode.requireKnownIds && !(await diskIdsKnown(queries, state))) {
    return { kind: 'done', outcome: NOT_OURS_IDS }
  }
  const diagnosis = await diagnose(queries, seat, state)
  if (diagnosis.kind === 'blocked') {
    return { kind: 'done', outcome: { status: 'blocked', reason: diagnosis.reason } }
  }
  if (diagnosis.kind === 'ok') {
    if (!mode.reissueWhenOk) return { kind: 'done', outcome: { status: 'ok' } }
    return { kind: 'reissue', reasons: ['an owner asked for new credentials'], clearKeyId: null }
  }
  return { kind: 'reissue', reasons: diagnosis.reasons, clearKeyId: diagnosis.clearKeyId }
}

/** Inside the lock: look again, and change the database only if still needed. */
async function reissueUnderLock(
  queries: ColocatedRepairQueries,
  disk: ColocatedRepairDisk,
  seenSeat: ColocatedSeat,
  mode: ReissueMode
): Promise<LockedResult> {
  const seat = await queries.findSeat()
  if (seat?.licenseId !== seenSeat.licenseId || seat.serverId !== seenSeat.serverId) {
    return { kind: 'done', outcome: { status: 'skipped', reason: 'the co-located seat changed' } }
  }
  const decision = await decide(queries, seat, await disk.read(), mode)
  if (decision.kind === 'done') return decision
  const token = await queries.rotateToken(seat.licenseId)
  const clearedKey = decision.clearKeyId
    ? await queries.clearKey(seat.serverId, decision.clearKeyId)
    : false
  return { kind: 'write', seat, token, reasons: decision.reasons, clearedKey }
}

/** Take the lock, re-issue, then write the files: database first, files last. */
async function reissueAndWrite(
  store: ColocatedRepairStore,
  disk: ColocatedRepairDisk,
  seat: ColocatedSeat,
  mode: ReissueMode
): Promise<ColocatedRepairOutcome> {
  // The daemon re-enrolls as soon as it sees new license files, so the old
  // key must already be gone by then.
  const locked = await store.locked((queries) => reissueUnderLock(queries, disk, seat, mode))
  if (locked.kind === 'done') return locked.outcome
  const wrote = await disk.write(locked.seat, locked.token)
  if (!wrote) {
    return {
      status: 'failed',
      serverId: locked.seat.serverId,
      reason: 'could not write license files',
    }
  }
  return {
    status: 'repaired',
    serverId: locked.seat.serverId,
    reasons: locked.reasons,
    clearedKey: locked.clearedKey,
  }
}

/** One check-and-repair pass, without the rate limit. */
export async function repairColocatedCredentialsOnce(
  store: ColocatedRepairStore,
  disk: ColocatedRepairDisk
): Promise<ColocatedRepairOutcome> {
  if (typeof Deno === 'undefined') return { status: 'skipped', reason: 'not the Deno runtime' }
  disk.assertWritable()
  if (!(await disk.hasDaemonFiles())) {
    return { status: 'skipped', reason: 'no co-located daemon files' }
  }
  const seat = await store.findSeat()
  if (!seat) return { status: 'skipped', reason: 'no bound co-located seat' }

  // A cheap look outside the lock: a healthy host never takes it.
  const first = await decide(store, seat, await disk.read(), AUTOMATIC)
  if (first.kind === 'done') return first.outcome
  return reissueAndWrite(store, disk, seat, AUTOMATIC)
}

// ── On request ───────────────────────────────────────────────────────────

/** Why a repair an owner asked for did not run. */
export const COLOCATED_REPAIR_REFUSAL_CODES = [
  'not_deno',
  'no_colocated_seat',
  'not_colocated_server',
  'no_daemon_files',
  'daemon_key_revoked',
  'seat_changed',
] as const

export type ColocatedRepairRefusal = (typeof COLOCATED_REPAIR_REFUSAL_CODES)[number]

export type ColocatedRequestedRepairOutcome =
  | { status: 'refused'; code: ColocatedRepairRefusal }
  | { status: 'repaired'; serverId: string; reasons: string[]; clearedKey: boolean }
  | { status: 'failed'; serverId: string; reason: string }

/**
 * The repair an owner asks for from the co-located server's page. Same locked
 * re-issue as the automatic pass (same license and seat, never a new server,
 * a revoked key is refused, database before files), with two differences: it
 * does not need an id on disk to be known here (files from another
 * database are exactly what it fixes), and it re-issues the token even when
 * the files look right. `serverId` must be the bound seat's server.
 */
export async function repairColocatedCredentialsOnRequest(
  store: ColocatedRepairStore,
  disk: ColocatedRepairDisk,
  serverId: string
): Promise<ColocatedRequestedRepairOutcome> {
  if (typeof Deno === 'undefined') return { status: 'refused', code: 'not_deno' }
  // The seat is checked first (a database read only), so asking for any other
  // server is a plain refusal; the dir guard still runs before any disk I/O.
  const seat = await store.findSeat()
  if (!seat) return { status: 'refused', code: 'no_colocated_seat' }
  if (seat.serverId !== serverId) return { status: 'refused', code: 'not_colocated_server' }
  disk.assertWritable()
  if (!(await disk.hasDaemonFiles())) return { status: 'refused', code: 'no_daemon_files' }

  const outcome = await reissueAndWrite(store, disk, seat, ON_REQUEST)
  switch (outcome.status) {
    case 'repaired':
    case 'failed':
      return outcome
    case 'blocked':
      return { status: 'refused', code: 'daemon_key_revoked' }
    default:
      // Only a seat that changed under the lock lands here.
      return { status: 'refused', code: 'seat_changed' }
  }
}

// ── Scheduling ───────────────────────────────────────────────────────────

export type ColocatedRepairTrigger = 'refusal' | 'retry'

export type ColocatedSelfRepair = {
  /**
   * A refusal came straight in on the socket: check now unless a check ran
   * within the interval. Never throws.
   */
  run(trigger: 'refusal'): Promise<ColocatedRepairOutcome>
  /**
   * Called from a periodic timer: retries a failed repair once its backoff
   * ran out, while a socket refusal is recent.
   */
  tick(): Promise<ColocatedRepairOutcome | null>
}

export function createColocatedSelfRepair(opts: {
  store: ColocatedRepairStore
  disk?: ColocatedRepairDisk
  minIntervalMs?: number
  retryBaseMs?: number
  retryMaxMs?: number
  refusalWindowMs?: number
  now?: () => number
}): ColocatedSelfRepair {
  const disk = opts.disk ?? createColocatedRepairDisk()
  const minIntervalMs = opts.minIntervalMs ?? COLOCATED_SELF_REPAIR_MIN_INTERVAL_MS
  const retryBaseMs = opts.retryBaseMs ?? COLOCATED_SELF_REPAIR_RETRY_BASE_MS
  const retryMaxMs = opts.retryMaxMs ?? COLOCATED_SELF_REPAIR_RETRY_MAX_MS
  const refusalWindowMs = opts.refusalWindowMs ?? COLOCATED_SELF_REPAIR_REFUSAL_WINDOW_MS
  const now = opts.now ?? Date.now
  let lastRefusalAt: number | null = null
  const loggedOnce = new Set<string>()
  let lastRunAt: number | null = null
  let failures = 0
  let retryAt: number | null = null
  let inFlight: Promise<ColocatedRepairOutcome> | null = null

  function logOnce(message: string): void {
    if (loggedOnce.has(message)) return
    loggedOnce.add(message)
    compatLogInfo('install', message)
  }

  function report(outcome: ColocatedRepairOutcome, trigger: ColocatedRepairTrigger): void {
    if (outcome.status === 'repaired') {
      compatLogInfo(
        'install',
        `repaired co-located daemon credentials for server ${outcome.serverId} on ${trigger} ` +
          `(${outcome.reasons.join('; ')}${outcome.clearedKey ? '; cleared its stale key' : ''})`
      )
    } else if (outcome.status === 'failed') {
      compatLogWarn(
        'install',
        `co-located daemon credential repair for server ${outcome.serverId} failed: ${outcome.reason}`
      )
    } else if (outcome.status === 'not-ours') {
      logOnce(`co-located daemon credentials left alone: ${outcome.reason}`)
    } else if (outcome.status === 'blocked') {
      logOnce(`co-located daemon credentials not repaired: ${outcome.reason}`)
    }
  }

  function scheduleRetry(failed: boolean): void {
    if (!failed) {
      failures = 0
      retryAt = null
      return
    }
    failures++
    retryAt = now() + Math.min(retryBaseMs * 2 ** (failures - 1), retryMaxMs)
  }

  async function attempt(trigger: ColocatedRepairTrigger): Promise<ColocatedRepairOutcome> {
    let outcome: ColocatedRepairOutcome
    try {
      outcome = await repairColocatedCredentialsOnce(opts.store, disk)
    } catch (err) {
      compatLogWarn('install', `co-located daemon credential check failed: ${String(err)}`)
      scheduleRetry(true)
      return { status: 'skipped', reason: 'error' }
    }
    report(outcome, trigger)
    scheduleRetry(outcome.status === 'failed')
    return outcome
  }

  function start(trigger: ColocatedRepairTrigger): Promise<ColocatedRepairOutcome> {
    lastRunAt = now()
    const running = attempt(trigger).finally(() => {
      inFlight = null
    })
    inFlight = running
    return running
  }

  return {
    run(trigger) {
      lastRefusalAt = now()
      if (inFlight) return inFlight
      if (lastRunAt !== null && now() - lastRunAt < minIntervalMs) {
        return Promise.resolve({ status: 'rate-limited' })
      }
      return start(trigger)
    },
    tick() {
      if (inFlight || retryAt === null || now() < retryAt) return Promise.resolve(null)
      if (lastRefusalAt === null || now() - lastRefusalAt > refusalWindowMs) {
        // No recent refusal: the daemon is not asking any more.
        retryAt = null
        failures = 0
        return Promise.resolve(null)
      }
      return start('retry')
    },
  }
}
