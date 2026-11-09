/**
 * `repo-key-changed`: a daemon saw that a package source's signing key is not
 * one TurboPanel expects (feature `repo-key-report-v1`), and the control plane
 * tells the organization's managers once. The daemon remembers what it has
 * reported per key name and fingerprint, so a repeat of the same report is the
 * daemon's to prevent. A daemon that sends a new fingerprint in every frame
 * (a compromised host) is held back here: each server raises at most
 * {@link REPO_KEY_NOTICES_PER_WINDOW} notices per hour, counted in memory.
 *
 * Fire-and-forget and never throws into the inbound path: the install already
 * went on (package signatures are still checked), so a failed alert only means
 * a missed notice.
 */
import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { server } from '../../db/schema.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import { emitNotification } from './emit.ts'

/** The fields of the wire frame this handler reads. */
export type RepoKeyChangedReport = {
  keyName: string
  expected: readonly string[]
  got: string
}

export type RepoKeyAlertDeps = {
  /** Test seam: the emitter. */
  emit?: typeof emitNotification
  /** Test seam: the per-server cap (one per process by default). */
  throttle?: RepoKeyNoticeThrottle
  /** Test seam: the clock, in milliseconds. */
  nowMs?: number
}

/** Notices one server may raise in {@link REPO_KEY_NOTICE_WINDOW_MS}. */
export const REPO_KEY_NOTICES_PER_WINDOW = 5

export const REPO_KEY_NOTICE_WINDOW_MS = 60 * 60_000

/** Upper bound on servers one throttle remembers; the oldest is forgotten first. */
const THROTTLE_MAX_SERVERS = 10_000

/**
 * In-memory cap on the notices one server raises, checked before any database
 * read. The Durable Object isolate and the Deno process each keep one; a
 * restart starts the count again, which is fine for a bell and channel notice.
 */
export class RepoKeyNoticeThrottle {
  readonly #seen = new Map<string, { sentAt: number[]; warnedAt: number | null }>()

  /** `allowed` when the notice may go; `firstDrop` on the first one held back in an hour. */
  take(serverId: string, nowMs: number): { allowed: boolean; firstDrop: boolean } {
    const inWindow = (at: number) => nowMs - at < REPO_KEY_NOTICE_WINDOW_MS
    const last = this.#seen.get(serverId)
    const sentAt = (last?.sentAt ?? []).filter(inWindow)
    const prior = last?.warnedAt ?? null
    const warnedAt = prior !== null && inWindow(prior) ? prior : null
    this.#seen.delete(serverId)
    if (this.#seen.size >= THROTTLE_MAX_SERVERS) {
      const oldest = this.#seen.keys().next().value
      if (oldest !== undefined) this.#seen.delete(oldest)
    }
    if (sentAt.length >= REPO_KEY_NOTICES_PER_WINDOW) {
      this.#seen.set(serverId, { sentAt, warnedAt: warnedAt ?? nowMs })
      return { allowed: false, firstDrop: warnedAt === null }
    }
    this.#seen.set(serverId, { sentAt: [...sentAt, nowMs], warnedAt })
    return { allowed: true, firstDrop: false }
  }
}

const processThrottle = new RepoKeyNoticeThrottle()

/** Fingerprints shown in the sentence. */
const FINGERPRINTS_LISTED = 2

/** The last 16 hex digits, upper case: enough to compare by eye. */
export function shortFingerprint(fingerprint: string): string {
  return fingerprint.trim().toUpperCase().slice(-16)
}

/** "AAAA…, BBBB… and 1 more". */
export function shortFingerprintList(fingerprints: readonly string[]): string {
  const shown = fingerprints.slice(0, FINGERPRINTS_LISTED).map(shortFingerprint)
  const more = fingerprints.length - shown.length
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ')
}

/** Tell the reporting server's organization managers about a changed key. Returns true when an alert was raised. */
export async function handleRepoKeyChanged(
  db: Db,
  secrets: DerivedSecretsConfig | undefined,
  serverId: string,
  report: RepoKeyChangedReport,
  deps: RepoKeyAlertDeps = {}
): Promise<boolean> {
  const gate = (deps.throttle ?? processThrottle).take(serverId, deps.nowMs ?? Date.now())
  if (!gate.allowed) {
    if (gate.firstDrop) {
      compatLogWarn(
        'repo-key-alerts',
        `server ${serverId} reported more than ${REPO_KEY_NOTICES_PER_WINDOW} changed signing keys in an hour; further notices are held back`
      )
    }
    return false
  }
  try {
    const [row] = await db
      .select({ organizationId: server.organizationId, name: server.name })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1)
    // An unassigned server has no organization to tell.
    if (!row?.organizationId) return false
    const emit = deps.emit ?? emitNotification
    await emit(
      db,
      secrets,
      {
        event: 'server.repo_key_changed',
        organizationId: row.organizationId,
        context: {
          keyName: report.keyName,
          serverName: row.name,
          expected: shortFingerprintList(report.expected),
          got: shortFingerprint(report.got),
        },
        targetType: 'server',
        targetId: serverId,
      },
      { allowPrivateTargets: true }
    )
    return true
  } catch (err) {
    compatLogWarn(
      'repo-key-alerts',
      `repo key alert not sent: ${err instanceof Error ? err.message : String(err)}`
    )
    return false
  }
}
