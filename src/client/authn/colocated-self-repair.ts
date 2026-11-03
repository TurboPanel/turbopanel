/**
 * Co-located daemon credential self-repair (self-hosted Deno runtime only).
 *
 * The control plane wrote the co-located daemon's license id, license token
 * and server id files at install. If those files later stop
 * matching the control plane's own record of its co-located seat (a test run
 * that wrote into the real state dir did exactly that), the daemon is refused
 * with `401 Invalid license` or `409 Server key already registered` and stays
 * offline until someone repairs it by hand.
 *
 * {@link createColocatedSelfRepair} checks at boot and when an enroll or
 * session is refused, and when the files do not match it:
 *
 * 1. re-issues the token on the EXISTING bound license (same id, same seat),
 * 2. clears the stored daemon key of that one server when the daemon on disk
 *    no longer holds it, so the daemon can register its current key, and
 * 3. writes the server id, license id and license token files (in that order).
 *
 * The daemon notices the changed license files, leaves its parked state and
 * enrolls again with the persisted server id. Nothing here creates a server,
 * touches another server, or runs without a bound co-located seat. A revoked
 * key is left alone: revocation is sticky and only an owner lifts it.
 *
 * Plaintext tokens are never stored: a bound license has its token hash
 * erased, so a match is judged on `license.id`, `server.id` and the daemon's
 * `server-key-id` against the stored key; the token itself is checked (by
 * hash) only before the daemon has enrolled.
 */
import { and, eq, isNull } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { license as licenseTable } from '../../db/schema.ts'
import { compatLogInfo, compatLogWarn } from '../../lib/log-compat.ts'
import { verifyLicenseToken } from '../../features/licenses/license.ts'
import {
  clearServerDaemonState,
  getServerDaemonStateByServerId,
} from '../../features/servers/server-identity-db.ts'
import { isDaemonKeyActive } from '../../features/servers/daemon-state.ts'
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

export type ColocatedSeat = { licenseId: string; serverId: string }

/** The stored daemon key of the seat's server, or null before it enrolled. */
export type StoredDaemonKey = { id: string; active: boolean } | null

/**
 * One daemon state file: its trimmed text, `null` when it does not exist, or
 * `undefined` when it exists but could not be read (permissions).
 */
export type DiskValue = string | null | undefined

export type ColocatedDiskState = {
  licenseId: DiskValue
  licenseToken: DiskValue
  serverId: DiskValue
  keyId: DiskValue
}

/** The database side of the repair; the default binds the real queries. */
export type ColocatedRepairStore = {
  findSeat(): Promise<ColocatedSeat | null>
  storedKey(serverId: string): Promise<StoredDaemonKey>
  /** Argon2 hash still on the license, or null once a bind erased it. */
  licenseTokenHash(licenseId: string): Promise<string | null>
  verifyToken(plaintext: string, hashed: string): Promise<boolean>
  /** New token on the same license; clears that server's key when asked. One transaction. */
  reissue(seat: ColocatedSeat, opts: { clearKey: boolean }): Promise<string>
}

/** The disk side of the repair; the default reads and writes the credentials dir. */
export type ColocatedRepairDisk = {
  /** Throws in a test run aimed at a real state dir; checked before any write. */
  assertWritable(): void
  /** False when no daemon has ever used the dir: then this is not a co-located host. */
  hasDaemonFiles(): Promise<boolean>
  read(): Promise<ColocatedDiskState>
  write(seat: ColocatedSeat, token: string): Promise<boolean>
}

export type ColocatedRepairOutcome =
  | { status: 'skipped'; reason: string }
  | { status: 'rate-limited' }
  | { status: 'ok' }
  | { status: 'blocked'; reason: string }
  | { status: 'repaired'; serverId: string; reasons: string[]; clearedKey: boolean }
  | { status: 'failed'; serverId: string; reason: string }

export type ColocatedDiagnosis =
  | { kind: 'ok' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'mismatch'; reasons: string[]; clearKey: boolean }

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
  let keyGone = false
  if (key) {
    if (disk.keyId === null) {
      keyGone = true
      reasons.push('the daemon holds no key id while one is stored')
    } else if (disk.keyId !== undefined && disk.keyId !== key.id) {
      keyGone = true
      reasons.push('the daemon key id differs from the stored key')
    }
  } else if (disk.licenseToken === null) {
    reasons.push('the license token file is missing before enrollment')
  }
  if (reasons.length > 0) {
    // A daemon that still holds the stored key under the right server id
    // keeps working: only its license files are rewritten.
    return { kind: 'mismatch', reasons, clearKey: key !== null && (keyGone || serverIdWrong) }
  }
  if (!key && typeof disk.licenseToken === 'string') return { kind: 'check-token' }
  return { kind: 'ok' }
}

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
      const [licenseId, licenseToken, serverId, keyId] = await Promise.all([
        readStateFile(`${stateDir}/${COLOCATED_LICENSE_ID_FILE}`),
        readStateFile(`${stateDir}/${COLOCATED_LICENSE_TOKEN_FILE}`),
        readStateFile(`${stateDir}/${COLOCATED_SERVER_ID_FILE}`),
        readStateFile(`${stateDir}/${COLOCATED_SERVER_KEY_ID_FILE}`),
      ])
      return { licenseId, licenseToken, serverId, keyId }
    },
    write: (seat, token) =>
      persistColocatedLicenseCredentials(seat.licenseId, token, seat.serverId),
  }
}

/** The real queries, on the process-long Deno database client. */
export function createColocatedRepairStore(db: Db): ColocatedRepairStore {
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
      return { id: state.key.id, active: isDaemonKeyActive(state.key) }
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
    reissue(seat, opts) {
      return db.transaction(async (tx) => {
        const rotated = await rotateLicenseTokenInPlace(tx, seat.licenseId)
        if (opts.clearKey) await clearServerDaemonState(tx, seat.serverId)
        return rotated.licenseToken
      })
    },
  }
}

async function diagnose(
  store: ColocatedRepairStore,
  seat: ColocatedSeat,
  disk: ColocatedDiskState
): Promise<ColocatedDiagnosis> {
  const key = await store.storedKey(seat.serverId)
  const first = diagnoseColocatedCredentials(seat, disk, key)
  if (first.kind !== 'check-token') return first
  const hash = await store.licenseTokenHash(seat.licenseId)
  const matches =
    hash !== null && typeof disk.licenseToken === 'string'
      ? await store.verifyToken(disk.licenseToken, hash)
      : false
  if (matches) return { kind: 'ok' }
  return {
    kind: 'mismatch',
    reasons: ['the license token file does not verify against the co-located license'],
    clearKey: false,
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

  const diagnosis = await diagnose(store, seat, await disk.read())
  if (diagnosis.kind === 'ok') return { status: 'ok' }
  if (diagnosis.kind === 'blocked') return { status: 'blocked', reason: diagnosis.reason }

  // Database first, files last: the daemon re-enrolls as soon as it sees new
  // license files, so the old key must already be gone by then.
  const token = await store.reissue(seat, { clearKey: diagnosis.clearKey })
  const wrote = await disk.write(seat, token)
  if (!wrote) {
    return { status: 'failed', serverId: seat.serverId, reason: 'could not write license files' }
  }
  return {
    status: 'repaired',
    serverId: seat.serverId,
    reasons: diagnosis.reasons,
    clearedKey: diagnosis.clearKey,
  }
}

export type ColocatedSelfRepair = {
  /** Check now unless a check ran within the interval; never throws. */
  run(trigger: 'boot' | 'refusal'): Promise<ColocatedRepairOutcome>
}

export function createColocatedSelfRepair(opts: {
  store: ColocatedRepairStore
  disk?: ColocatedRepairDisk
  minIntervalMs?: number
  now?: () => number
}): ColocatedSelfRepair {
  const disk = opts.disk ?? createColocatedRepairDisk()
  const minIntervalMs = opts.minIntervalMs ?? COLOCATED_SELF_REPAIR_MIN_INTERVAL_MS
  const now = opts.now ?? Date.now
  let lastRunAt: number | null = null
  let inFlight: Promise<ColocatedRepairOutcome> | null = null

  async function runOnce(trigger: 'boot' | 'refusal'): Promise<ColocatedRepairOutcome> {
    try {
      const outcome = await repairColocatedCredentialsOnce(opts.store, disk)
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
      } else if (outcome.status === 'blocked') {
        compatLogWarn('install', `co-located daemon credentials not repaired: ${outcome.reason}`)
      }
      return outcome
    } catch (err) {
      compatLogWarn('install', `co-located daemon credential check failed: ${String(err)}`)
      return { status: 'skipped', reason: 'error' }
    }
  }

  return {
    run(trigger) {
      if (inFlight) return inFlight
      const at = now()
      if (lastRunAt !== null && at - lastRunAt < minIntervalMs) {
        return Promise.resolve({ status: 'rate-limited' })
      }
      lastRunAt = at
      inFlight = runOnce(trigger).finally(() => {
        inFlight = null
      })
      return inFlight
    },
  }
}
