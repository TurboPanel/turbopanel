/**
 * `repo-key-changed`: a daemon saw that a package source's signing key is not
 * one TurboPanel expects (feature `repo-key-report-v1`), and the control plane
 * tells the organization's managers once. The daemon remembers what it has
 * reported per key name and fingerprint, so this holds no state of its own and
 * a repeat of the same report is the daemon's to prevent, not ours.
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
}

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
