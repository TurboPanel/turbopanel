/**
 * Co-located daemon credential self-repair (self-hosted Deno runtime only).
 *
 * The control plane wrote the co-located daemon's license id, license token
 * and server id files at install. If those files later stop matching the
 * control plane's own record of its co-located seat, the daemon is refused
 * with `401 Invalid license` or `409 Server key already registered` and stays
 * offline until someone repairs it by hand.
 *
 * {@link createColocatedSelfRepair} checks at boot and when an enroll or
 * session is refused (any caller can cause that: the check is rate-limited
 * and does nothing when the files are healthy or not ours), and when the files
 * do not match it:
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
 * Ownership comes first: it acts only when the daemon's own settings point at
 * THIS control plane (its socket or one of its hostnames; when the settings
 * file is unreadable, its panel key pin naming this control plane's key or a
 * hostname) AND the license id or server id on disk names a row in this
 * database. A daemon moved to another control plane is never rewritten.
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
import { listInstanceHostnames } from '../../features/install/instance-hostnames.ts'
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

/** The daemon's own settings file and its panel key pin, as read from disk. */
export type DaemonTargetFiles = { daemonEnv: DiskValue; panelPin: DiskValue }

/** What identifies this control plane to its co-located daemon. */
export type ControlPlaneSelf = {
  socketPath: string
  hostnames: string[]
  panelFingerprints: string[]
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
  controlPlaneSelf(): Promise<ControlPlaneSelf>
  /** Run `fn` in one transaction holding the co-located repair advisory lock. */
  locked<T>(fn: (queries: ColocatedRepairQueries) => Promise<T>): Promise<T>
}

/** The disk side of the repair; the default reads and writes the real files. */
export type ColocatedRepairDisk = {
  /** Throws in a test run aimed at a real state dir; checked before any write. */
  assertWritable(): void
  /** True when any daemon file is in the dir; a bare dir is never written into. */
  hasDaemonFiles(): Promise<boolean>
  readTarget(): Promise<DaemonTargetFiles>
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

function unquote(value: string): string {
  const first = value[0]
  if (value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first)) {
    return value.slice(1, -1)
  }
  return value
}

function keyValueLines(text: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^export\s+/, '')
    const at = line.indexOf('=')
    if (line.startsWith('#') || at < 1) continue
    values.set(line.slice(0, at).trim(), unquote(line.slice(at + 1).trim()))
  }
  return values
}

/** Drop trailing `/` characters with a plain loop (no backtracking regex). */
function stripTrailingSlashes(path: string): string {
  let end = path.length
  while (end > 1 && path[end - 1] === '/') end--
  return path.slice(0, end)
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

function normalizeSocket(path: string): string {
  const trimmed = stripTrailingSlashes(path.trim())
  return trimmed.startsWith('/var/run/') ? trimmed.slice('/var'.length) : trimmed
}

/** The socket a daemon in socket mode dials, from its settings (mirrors the daemon). */
function daemonSocketPath(env: Map<string, string>): string {
  const explicit = env.get('TURBOPANEL_SOCKET')?.trim()
  if (explicit) return explicit
  const dir =
    env.get('TURBOPANEL_SOCKET_DIR')?.trim() ||
    env.get('TURBOPANEL_RUN_DIR')?.trim() ||
    '/run/turbopanel'
  return `${stripTrailingSlashes(dir)}/instance.sock`
}

function pinNamesThisControlPlane(pinText: string, self: ControlPlaneSelf): boolean {
  const pin = keyValueLines(pinText)
  const fingerprints = [pin.get('current'), pin.get('next')].filter(
    (value): value is string => typeof value === 'string' && value.length > 0
  )
  if (fingerprints.some((fp) => self.panelFingerprints.includes(fp))) return true
  const hostnames = new Set(self.hostnames.map((host) => host.toLowerCase()))
  const urls = (pin.get('urls') ?? '').split(',').filter((url) => url.length > 0)
  return urls.some((url) => {
    const host = hostOf(url)
    return host !== null && hostnames.has(host)
  })
}

/**
 * Does the daemon's own configuration point at this control plane? The
 * settings file decides when it can be read: a URL must name one of this
 * control plane's hostnames, socket mode must dial this control plane's
 * socket. A managed host keeps that file daemon-only, so then the panel key
 * pin (group-readable) decides: it must name this control plane's key or one
 * of its hostnames. Nothing from a request is consulted.
 */
export function daemonTargetsThisControlPlane(
  files: DaemonTargetFiles,
  self: ControlPlaneSelf
): { ok: true } | { ok: false; reason: string } {
  if (typeof files.daemonEnv === 'string') {
    const env = keyValueLines(files.daemonEnv)
    const url = env.get('TURBOPANEL_INSTANCE_URL')?.trim()
    if (url) {
      const host = hostOf(url)
      const ours = host !== null && self.hostnames.some((name) => name.toLowerCase() === host)
      return ours
        ? { ok: true }
        : { ok: false, reason: 'the daemon is set to reach another control plane address' }
    }
    return normalizeSocket(daemonSocketPath(env)) === normalizeSocket(self.socketPath)
      ? { ok: true }
      : { ok: false, reason: 'the daemon is set to dial another socket' }
  }
  if (typeof files.panelPin === 'string') {
    return pinNamesThisControlPlane(files.panelPin, self)
      ? { ok: true }
      : { ok: false, reason: 'the daemon pins another control plane' }
  }
  return { ok: false, reason: 'cannot read where the daemon is set to connect' }
}

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

function defaultDaemonEnvPath(): string {
  const configDir = Deno.env.get('TURBOPANEL_CONFIG_DIR')?.trim() || '/etc/turbopanel'
  return `${stripTrailingSlashes(configDir)}/daemon.env`
}

function defaultPanelPinPath(): string {
  const libDir = Deno.env.get('TURBOPANEL_LIB_DIR')?.trim() || '/opt/turbopanel/lib'
  return `${stripTrailingSlashes(libDir)}/panel-identity`
}

/** Reads and writes the resolved co-located credentials dir. */
export function createColocatedRepairDisk(
  opts: {
    dir?: () => string
    daemonEnvPath?: () => string
    panelPinPath?: () => string
  } = {}
): ColocatedRepairDisk {
  const dir = opts.dir ?? resolveColocatedLicenseCredentialsDir
  const daemonEnvPath = opts.daemonEnvPath ?? defaultDaemonEnvPath
  const panelPinPath = opts.panelPinPath ?? defaultPanelPinPath
  return {
    assertWritable: () => assertColocatedCredentialsDirWritable(dir()),
    async hasDaemonFiles() {
      const stateDir = dir()
      const found = await Promise.all(DAEMON_EVIDENCE_FILES.map((f) => exists(`${stateDir}/${f}`)))
      return found.some(Boolean)
    },
    async readTarget() {
      const [daemonEnv, panelPin] = await Promise.all([
        readStateFile(daemonEnvPath()),
        readStateFile(panelPinPath()),
      ])
      return { daemonEnv, panelPin }
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
export function createColocatedRepairStore(
  db: Db,
  opts: { socketPath: string; panelFingerprints: () => string[] }
): ColocatedRepairStore {
  return {
    ...createQueries(db),
    async controlPlaneSelf() {
      const rows = await listInstanceHostnames(db)
      return {
        socketPath: opts.socketPath,
        hostnames: rows.map((row) => row.host),
        panelFingerprints: opts.panelFingerprints(),
      }
    },
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

/** Inside the lock: look again, and change the database only if still needed. */
async function reissueUnderLock(
  queries: ColocatedRepairQueries,
  disk: ColocatedRepairDisk,
  seenSeat: ColocatedSeat
): Promise<LockedResult> {
  const seat = await queries.findSeat()
  if (seat?.licenseId !== seenSeat.licenseId || seat.serverId !== seenSeat.serverId) {
    return { kind: 'done', outcome: { status: 'skipped', reason: 'the co-located seat changed' } }
  }
  const state = await disk.read()
  if (!(await diskIdsKnown(queries, state))) return { kind: 'done', outcome: NOT_OURS_IDS }
  const diagnosis = await diagnose(queries, seat, state)
  if (diagnosis.kind === 'ok') return { kind: 'done', outcome: { status: 'ok' } }
  if (diagnosis.kind === 'blocked') {
    return { kind: 'done', outcome: { status: 'blocked', reason: diagnosis.reason } }
  }
  const token = await queries.rotateToken(seat.licenseId)
  const clearedKey = diagnosis.clearKeyId
    ? await queries.clearKey(seat.serverId, diagnosis.clearKeyId)
    : false
  return { kind: 'write', seat, token, reasons: diagnosis.reasons, clearedKey }
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
  const target = daemonTargetsThisControlPlane(
    await disk.readTarget(),
    await store.controlPlaneSelf()
  )
  if (!target.ok) return { status: 'not-ours', reason: target.reason }
  const seat = await store.findSeat()
  if (!seat) return { status: 'skipped', reason: 'no bound co-located seat' }

  // A cheap look outside the lock: a healthy host never takes it.
  const state = await disk.read()
  if (!(await diskIdsKnown(store, state))) return NOT_OURS_IDS
  const first = await diagnose(store, seat, state)
  if (first.kind === 'ok') return { status: 'ok' }
  if (first.kind === 'blocked') return { status: 'blocked', reason: first.reason }

  // Database first, files last: the daemon re-enrolls as soon as it sees new
  // license files, so the old key must already be gone by then.
  const locked = await store.locked((queries) => reissueUnderLock(queries, disk, seat))
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

// ── Scheduling ───────────────────────────────────────────────────────────

export type ColocatedRepairTrigger = 'boot' | 'refusal' | 'retry'

export type ColocatedSelfRepair = {
  /** Check now unless a check ran within the interval; never throws. */
  run(trigger: 'boot' | 'refusal'): Promise<ColocatedRepairOutcome>
  /** Called from a periodic timer: retries a failed repair once its backoff ran out. */
  tick(): Promise<ColocatedRepairOutcome | null>
}

export function createColocatedSelfRepair(opts: {
  store: ColocatedRepairStore
  disk?: ColocatedRepairDisk
  minIntervalMs?: number
  retryBaseMs?: number
  retryMaxMs?: number
  now?: () => number
}): ColocatedSelfRepair {
  const disk = opts.disk ?? createColocatedRepairDisk()
  const minIntervalMs = opts.minIntervalMs ?? COLOCATED_SELF_REPAIR_MIN_INTERVAL_MS
  const retryBaseMs = opts.retryBaseMs ?? COLOCATED_SELF_REPAIR_RETRY_BASE_MS
  const retryMaxMs = opts.retryMaxMs ?? COLOCATED_SELF_REPAIR_RETRY_MAX_MS
  const now = opts.now ?? Date.now
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
      if (inFlight) return inFlight
      if (lastRunAt !== null && now() - lastRunAt < minIntervalMs) {
        return Promise.resolve({ status: 'rate-limited' })
      }
      return start(trigger)
    },
    tick() {
      if (inFlight || retryAt === null || now() < retryAt) return Promise.resolve(null)
      return start('retry')
    },
  }
}
