/**
 * What a host says about folders, written onto the `folder` rows.
 *
 * Reports reach here, and none of them deletes a file on a host (only a
 * removal command does that):
 *
 * - a removal result (`server.folders.remove`, and the folders an
 *   `environment.stop` was told to reclaim): a folder the host says is gone
 *   clears its `removing` row, which lifts the locks on the environment, the
 *   project and the server; a folder that stayed keeps its row and the reason
 *   goes to the log;
 * - a deploy result's kept folders (a service left the compose file and its
 *   files stayed): the row becomes an `orphan`, which still counts toward the
 *   locks until an admin removes it;
 * - a reconcile listing (every folder the host found): a `present` row the host
 *   does not have becomes `missing` (which no longer locks), a `missing` row
 *   that came back is `present` again, a `removing` or `orphan` row the host no
 *   longer has is deleted, and a folder with no row at all gets an `orphan` row;
 *
 * The owner is always the applied Linux login the host reports, matched to the
 * principal rows that carry it; an unknown folder of a login with no placement
 * on the server is logged, not recorded.
 *
 * A report only moves a row it names, never creates a folder the panel plans,
 * and a stale report cannot lift a lock on a folder that is in use again
 * (`confirmFolderRemoved` only deletes a `removing` row).
 */
import { and, eq, inArray, lt } from 'drizzle-orm'
import { COMMON_SCOPE } from '../../contracts/directory-names.ts'
import type { Db } from '../../db/connection.ts'
import { environment, folder, principal, principalPlacement } from '../../db/schema.ts'
import type { KeptFolder, ReportedFolder } from '../../contracts/commands/schemas.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { confirmFolderRemoved } from './allocate.ts'
import type { FolderKindValue } from './vocabulary.ts'

/** One folder as a host reports a removal. */
export type FolderRemovalReport = {
  owner: string
  scope: string
  kind: FolderKindValue
  slug: string
  removed: boolean
  reason?: string
}

export type RemovalSummary = {
  /** Rows deleted because the host confirmed the folder gone. */
  cleared: number
  /** Folders the host kept (their rows stay `removing`). */
  stayed: number
}

type Reader = Pick<Db, 'select'>

/** The principal rows whose applied login is each name. */
async function principalIdsByLogin(
  db: Reader,
  logins: readonly string[]
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (logins.length === 0) return out
  const rows = await db
    .select({ id: principal.id, login: principal.appliedUsername })
    .from(principal)
    .where(inArray(principal.appliedUsername, [...new Set(logins)]))
  for (const row of rows) {
    out.set(row.login, [...(out.get(row.login) ?? []), row.id])
  }
  return out
}

/**
 * Settle `removing` rows from a removal report. A folder the host says is gone
 * deletes its row; one that stayed keeps the row and is logged with the host's
 * reason. Never throws for one bad entry.
 */
export async function applyFolderRemovalReports(
  db: Pick<Db, 'delete' | 'select' | 'update'>,
  serverId: string,
  reports: readonly FolderRemovalReport[],
  options: { updatedBefore?: string } = {}
): Promise<RemovalSummary> {
  const summary: RemovalSummary = { cleared: 0, stayed: 0 }
  if (reports.length === 0) return summary
  const owners = await principalIdsByLogin(
    db,
    reports.map((report) => report.owner)
  )
  await forEachSequential(reports, async (report) => {
    if (!report.removed) {
      summary.stayed += 1
      compatLogWarn(
        'folders',
        `server ${serverId} kept ${report.kind} folder ${report.scope}/${report.slug} of ${report.owner}: ${
          report.reason ?? 'no reason given'
        }`
      )
      // Keep the host's words on the row, so the panel can say why it is still there.
      await forEachSequential(owners.get(report.owner) ?? [], async (principalId) => {
        await db
          .update(folder)
          .set({ removalNote: (report.reason ?? 'the server gave no reason').slice(0, 300) })
          .where(
            and(
              eq(folder.serverId, serverId),
              eq(folder.principalId, principalId),
              eq(folder.scope, report.scope),
              eq(folder.kind, report.kind),
              eq(folder.slug, report.slug),
              eq(folder.state, 'removing'),
              options.updatedBefore === undefined
                ? undefined
                : lt(folder.updatedAt, options.updatedBefore)
            )
          )
      })
      return
    }
    // Only a `removing` row of the principal that carries this login is
    // deleted, so a report cannot clear another owner's row.
    await forEachSequential(owners.get(report.owner) ?? [], async (principalId) => {
      const cleared = await confirmFolderRemoved(db, {
        serverId,
        principalId,
        scope: report.scope,
        kind: report.kind,
        slug: report.slug,
        ...(options.updatedBefore === undefined ? {} : { updatedBefore: options.updatedBefore }),
      })
      if (cleared) summary.cleared += 1
    })
  })
  return summary
}

/**
 * A deploy left these service folders in place because their service is no
 * longer in the compose file. Their rows become `orphan`: still locking, still
 * counted, waiting for an admin to remove or adopt them. A row already
 * `removing` (an explicit delete) is left alone so the delete finishes.
 */
export async function markKeptFoldersOrphan(
  db: Pick<Db, 'update' | 'select'>,
  serverId: string,
  kept: readonly KeptFolder[],
  options: { updatedBefore?: string } = {}
): Promise<number> {
  if (kept.length === 0) return 0
  const owners = await principalIdsByLogin(
    db,
    kept.map((entry) => entry.owner)
  )
  let changed = 0
  await forEachSequential(kept, async (entry) => {
    const principalIds = owners.get(entry.owner) ?? []
    if (principalIds.length === 0) return
    const rows = await db
      .update(folder)
      .set({ state: 'orphan' })
      .where(
        and(
          eq(folder.serverId, serverId),
          inArray(folder.principalId, principalIds),
          eq(folder.scope, entry.scope),
          eq(folder.kind, 'service'),
          eq(folder.slug, entry.slug),
          inArray(folder.state, ['planned', 'present']),
          options.updatedBefore === undefined
            ? undefined
            : lt(folder.updatedAt, options.updatedBefore)
        )
      )
      .returning({ id: folder.id })
    changed += rows.length
  })
  return changed
}

export type ReconcileSummary = {
  markedMissing: number
  markedPresent: number
  cleared: number
  orphansFound: number
}

/** The most unknown folders one reconcile records; a host with more is a drift to look at, not a flood to store. */
export const MAX_ORPHANS_PER_RECONCILE = 500

const keyOf = (owner: string, scope: string, kind: string, slug: string): string =>
  `${owner}\u0000${scope}\u0000${kind}\u0000${slug}`

type ReconcileRow = {
  id: string
  state: string
  scope: string
  kind: string
  slug: string
  updatedAt: string
  login: string
}

/** Which rows a complete listing moves: back to present, to missing, or away. */
function planReconcile(
  rows: readonly ReconcileRow[],
  onHost: ReadonlySet<string>,
  listedAfter: number | null
): { known: Set<string>; toMissing: string[]; toPresent: string[]; toDelete: string[] } {
  const plan = {
    known: new Set<string>(),
    toMissing: [] as string[],
    toPresent: [] as string[],
    toDelete: [] as string[],
  }
  for (const row of rows) {
    const key = keyOf(row.login, row.scope, row.kind, row.slug)
    plan.known.add(key)
    // The listing was taken after the command was built: a row changed since
    // (planned again, deployed) may not be in it yet, so it is left for the next one.
    const changedAt = Date.parse(row.updatedAt)
    if (listedAfter !== null && (Number.isNaN(changedAt) || changedAt >= listedAfter)) continue
    const found = onHost.has(key)
    if (found && row.state === 'missing') plan.toPresent.push(row.id)
    else if (!found && row.state === 'present') plan.toMissing.push(row.id)
    else if (!found && (row.state === 'removing' || row.state === 'orphan')) {
      plan.toDelete.push(row.id)
    }
  }
  return plan
}

/** Move rows from one state to another, only those still in the first when the write lands. */
async function moveFolderRows(
  db: Pick<Db, 'update'>,
  ids: readonly string[],
  from: string,
  to: string
): Promise<number> {
  if (ids.length === 0) return 0
  const done = await db
    .update(folder)
    .set({ state: to })
    .where(and(inArray(folder.id, [...ids]), eq(folder.state, from)))
    .returning({ id: folder.id })
  return done.length
}

/**
 * Compare a complete listing of the host's folders with this server's rows.
 * Call only with a list the host completed (`folders` present in the result).
 * See the module comment for what each difference does; nothing on the host is
 * ever deleted because of a difference.
 */
export async function reconcileReportedFolders(
  db: Db,
  serverId: string,
  reported: readonly ReportedFolder[],
  options: { listedAfter?: string } = {}
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    markedMissing: 0,
    markedPresent: 0,
    cleared: 0,
    orphansFound: 0,
  }
  // Timestamps come back from the database and from the command record in different
  // text forms, so compare them as times, never as strings.
  const listedAfter = options.listedAfter === undefined ? null : Date.parse(options.listedAfter)
  const onHost = new Set(
    reported
      .filter((entry) => entry.present)
      .map((entry) => keyOf(entry.owner, entry.scope, entry.kind, entry.slug))
  )
  const rows = await db
    .select({
      id: folder.id,
      state: folder.state,
      scope: folder.scope,
      kind: folder.kind,
      slug: folder.slug,
      principalId: folder.principalId,
      updatedAt: folder.updatedAt,
      login: principal.appliedUsername,
    })
    .from(folder)
    .innerJoin(principal, eq(principal.id, folder.principalId))
    .where(eq(folder.serverId, serverId))
  const plan = planReconcile(rows, onHost, listedAfter)
  summary.markedMissing = await moveFolderRows(db, plan.toMissing, 'present', 'missing')
  summary.markedPresent = await moveFolderRows(db, plan.toPresent, 'missing', 'present')
  if (plan.toDelete.length > 0) {
    // `removing` and `orphan` rows whose folder is no longer on the host have
    // nothing left to wait for; the state check keeps a row that changed since
    // the read (planned again, say) from being deleted.
    const done = await db
      .delete(folder)
      .where(and(inArray(folder.id, plan.toDelete), inArray(folder.state, ['removing', 'orphan'])))
      .returning({ id: folder.id })
    summary.cleared = done.length
  }
  summary.orphansFound = await recordUnknownFolders(
    db,
    serverId,
    reported.filter(
      (entry) =>
        entry.present && !plan.known.has(keyOf(entry.owner, entry.scope, entry.kind, entry.slug))
    )
  )
  return summary
}

/** Insert an `orphan` row for each folder the host has that no row names. */
async function recordUnknownFolders(
  db: Db,
  serverId: string,
  unknown: readonly ReportedFolder[]
): Promise<number> {
  if (unknown.length === 0) return 0
  const capped = unknown.slice(0, MAX_ORPHANS_PER_RECONCILE)
  if (unknown.length > capped.length) {
    compatLogWarn(
      'folders',
      `server ${serverId} has ${unknown.length} folders no record names; the first ${capped.length} are recorded`
    )
  }
  const owners = await ownersOnServer(
    db,
    serverId,
    capped.map((entry) => entry.owner)
  )
  let inserted = 0
  await forEachSequential(capped, async (entry) => {
    const owner = owners.get(entry.owner)
    if (!owner) {
      compatLogWarn(
        'folders',
        `server ${serverId} has ${entry.kind} folder ${entry.scope}/${entry.slug} of ${entry.owner}, who is not a site owner the panel knows`
      )
      return
    }
    const environmentId =
      entry.scope === COMMON_SCOPE ? null : await environmentNamed(db, owner.projectId, entry.scope)
    const rows = await db
      .insert(folder)
      .values({
        serverId,
        principalId: owner.id,
        environmentId,
        scope: entry.scope,
        kind: entry.kind,
        slug: entry.slug,
        state: 'orphan',
      })
      .onConflictDoNothing({
        target: [folder.serverId, folder.principalId, folder.scope, folder.kind, folder.slug],
      })
      .returning({ id: folder.id })
    if (rows.length > 0) {
      inserted += 1
      compatLogWarn(
        'folders',
        `server ${serverId} has ${entry.kind} folder ${entry.scope}/${entry.slug} of ${entry.owner} that no service or volume names; recorded as an orphan`
      )
    }
  })
  return inserted
}

type Owner = { id: string; projectId: string | null }

/** The principal each login belongs to on this server, preferring one placed there. */
async function ownersOnServer(
  db: Db,
  serverId: string,
  logins: readonly string[]
): Promise<Map<string, Owner>> {
  const out = new Map<string, Owner>()
  const wanted = [...new Set(logins)]
  if (wanted.length === 0) return out
  const placed = await db
    .select({
      id: principal.id,
      login: principal.appliedUsername,
      projectId: principal.projectId,
    })
    .from(principal)
    .innerJoin(principalPlacement, eq(principalPlacement.principalId, principal.id))
    .where(
      and(inArray(principal.appliedUsername, wanted), eq(principalPlacement.serverId, serverId))
    )
    .orderBy(principal.createdAt, principal.id)
  for (const row of placed) {
    if (!out.has(row.login)) {
      out.set(row.login, { id: row.id, projectId: row.projectId })
    }
  }
  return out
}

/** The environment of the project with this name, only when there is exactly one. */
async function environmentNamed(
  db: Db,
  projectId: string | null,
  name: string
): Promise<string | null> {
  if (projectId === null) return null
  const rows = await db
    .select({ id: environment.id })
    .from(environment)
    .where(and(eq(environment.projectId, projectId), eq(environment.name, name)))
    .limit(2)
  return rows.length === 1 ? rows[0]!.id : null
}
