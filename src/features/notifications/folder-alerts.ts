/**
 * The "a folder was left behind" alert: one bell/channel alert per server and
 * organization for the folders that have just become orphans, and never again
 * for the same orphan.
 *
 * A folder becomes an orphan in three places (a deploy that no longer plans its
 * service, a deploy that reports a kept folder, a reconcile that finds a folder
 * no row names). None of them sends the alert; this sweep does, on both
 * maintenance ticks, from the rows alone. `folder.orphan_alerted_at` is the
 * memory: the sweep claims the orphans it has not told anyone about in one
 * statement (so two ticks never both claim a row), and clears the stamp once a
 * folder stops being an orphan, so a folder that is left behind a second time
 * alerts again.
 */
import { and, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { folder, principal, server } from '../../db/schema.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import { type EmitDeps, emitNotification } from './emit.ts'

/** Orphans one tick claims at most; the rest wait for the next tick. */
export const ORPHAN_ALERT_BATCH = 200

/** Folders named in one alert; the rest are counted. */
const FOLDERS_LISTED = 5

export type OrphanAlertDeps = EmitDeps & {
  /** Test seam: the emitter. */
  emit?: typeof emitNotification
}

export type OrphanAlertResult = {
  /** Alerts sent (one per organization and server). */
  alerts: number
  /** Orphans those alerts covered. */
  folders: number
  /** Stamps cleared because the folder stopped being an orphan. */
  cleared: number
}

type ClaimedFolder = {
  id: string
  serverId: string
  organizationId: string
  serverName: string | null
  kind: string
  scope: string
  slug: string
}

/** "service blog (production)", "volume uploads (shared)". */
export function describeOrphanFolder(
  entry: Pick<ClaimedFolder, 'kind' | 'scope' | 'slug'>
): string {
  const scope = entry.scope === 'common' ? 'shared' : entry.scope
  return `${entry.kind} ${entry.slug} (${scope})`
}

/** The listing an alert shows: the first few folders, then how many more. */
export function listOrphanFolders(entries: readonly ClaimedFolder[]): string {
  const shown = entries.slice(0, FOLDERS_LISTED).map(describeOrphanFolder)
  const more = entries.length - shown.length
  const names = more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ')
  return names.charAt(0).toUpperCase() + names.slice(1)
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Give claimed rows back (no alert was sent for them), so the next tick tries again. */
async function releaseClaim(db: Db, ids: readonly string[]): Promise<void> {
  await db
    .update(folder)
    .set({ orphanAlertedAt: null, updatedAt: sql`${folder.updatedAt}` })
    .where(inArray(folder.id, [...ids]))
}

/** Forget the alert for every folder that has stopped being an orphan. */
async function clearStoppedOrphans(db: Db): Promise<number> {
  const rows = await db
    .update(folder)
    // `updated_at` is the folder's last real change: stamping the alert is not one.
    .set({ orphanAlertedAt: null, updatedAt: sql`${folder.updatedAt}` })
    .where(and(isNotNull(folder.orphanAlertedAt), ne(folder.state, 'orphan')))
    .returning({ id: folder.id })
  return rows.length
}

/**
 * Claim up to a batch of orphans nobody has been told about. One statement:
 * `FOR UPDATE SKIP LOCKED` keeps a concurrent tick from claiming the same rows.
 */
async function claimNewOrphans(db: Db): Promise<string[]> {
  const rows = await db
    .update(folder)
    .set({ orphanAlertedAt: sql`now()`, updatedAt: sql`${folder.updatedAt}` })
    .where(
      inArray(
        folder.id,
        db
          .select({ id: folder.id })
          .from(folder)
          .where(and(eq(folder.state, 'orphan'), isNull(folder.orphanAlertedAt)))
          .limit(ORPHAN_ALERT_BATCH)
          .for('update', { skipLocked: true })
      )
    )
    .returning({ id: folder.id })
  return rows.map((row) => row.id)
}

async function describeClaimed(db: Db, ids: readonly string[]): Promise<ClaimedFolder[]> {
  if (ids.length === 0) return []
  return db
    .select({
      id: folder.id,
      serverId: folder.serverId,
      organizationId: principal.organizationId,
      serverName: server.name,
      kind: folder.kind,
      scope: folder.scope,
      slug: folder.slug,
    })
    .from(folder)
    .innerJoin(principal, eq(principal.id, folder.principalId))
    .innerJoin(server, eq(server.id, folder.serverId))
    .where(inArray(folder.id, [...ids]))
    .orderBy(folder.scope, folder.kind, folder.slug)
}

/**
 * Tell each organization about the orphans that appeared since the last tick,
 * one alert per server. Never throws: a failed sweep is logged and the next
 * tick tries again from the rows that are still unclaimed.
 */
export async function alertNewOrphanFolders(
  db: Db,
  secrets: DerivedSecretsConfig | undefined,
  deps: OrphanAlertDeps = {}
): Promise<OrphanAlertResult> {
  const result: OrphanAlertResult = { alerts: 0, folders: 0, cleared: 0 }
  try {
    result.cleared = await clearStoppedOrphans(db)
    const claimed = await describeClaimed(db, await claimNewOrphans(db))
    const groups = new Map<string, ClaimedFolder[]>()
    for (const entry of claimed) {
      const key = `${entry.organizationId}:${entry.serverId}`
      groups.set(key, [...(groups.get(key) ?? []), entry])
    }
    const { emit = emitNotification, ...emitDeps } = deps
    for (const entries of groups.values()) {
      const first = entries[0]!
      try {
        await emit(
          db,
          secrets,
          {
            event: 'folder.orphans_found',
            organizationId: first.organizationId,
            context: {
              serverName: first.serverName,
              count: entries.length,
              folders: listOrphanFolders(entries),
            },
            targetType: 'server',
            targetId: first.serverId,
          },
          { allowPrivateTargets: true, ...emitDeps }
        )
        result.alerts += 1
        result.folders += entries.length
      } catch (err) {
        // The emitter does not throw; if it does, give the rows back so the
        // next tick tells the owners instead of dropping the alert.
        await releaseClaim(
          db,
          entries.map((entry) => entry.id)
        )
        compatLogWarn('orphan-alerts', `orphan folder alert not sent: ${messageOf(err)}`)
      }
    }
  } catch (err) {
    compatLogWarn('orphan-alerts', `orphan folder alert sweep failed: ${messageOf(err)}`)
  }
  return result
}
