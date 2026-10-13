/**
 * One uid and gid per site owner's Linux user, the same on every server it is
 * placed on.
 *
 * Why: shared storage and moved sites only line up when a tree owned by uid
 * 20001 on one server is owned by the same account on the next. A host that
 * picks its own id gives the same account two different numbers.
 *
 * The rules, in order, for a principal that is about to be placed on a server:
 *
 *  1. The account is already `present` there: send the id recorded for that
 *     placement, or nothing when none is recorded (a host that predates this
 *     reports its id back, and the row is filled from the report). An account
 *     that exists is never renumbered.
 *  2. The principal already has an id on another server: send that one.
 *  3. The principal is already on a host with an id nobody has reported yet
 *     (an account that predates this): send nothing and let the host
 *     keep what it has; the report fills the row.
 *  4. Otherwise it is new: take the next number from the installation-wide
 *     sequence and record it on the placement before the command is queued, so
 *     a second server asked a moment later gets the same number.
 *
 * An operator's own uid/gid on the principal's options always wins and is
 * handled by the caller; nothing here runs for it.
 */
import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { principalPlacement } from '../../db/schema.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import type { PlacementState } from './placement-vocabulary.ts'

/** Band the control plane and the daemon agree on (`PRINCIPAL_ID_MIN`/`MAX`). */
export const PRINCIPAL_ID_BAND_MIN = 15001
export const PRINCIPAL_ID_BAND_MAX = 60000

/** How many sequence values one principal may skip because they are in use. */
const MAX_SEQUENCE_SKIPS = 50

export type PlacementIdRow = {
  serverId: string
  state: PlacementState
  uid: number | null
  gid: number | null
}

export type PrincipalIdDecision =
  { kind: 'use'; uid: number; gid: number } | { kind: 'none' } | { kind: 'allocate' }

/** Pure: what to send for one principal on `serverId`, given all its placements. */
export function decidePrincipalIds(
  rows: ReadonlyArray<PlacementIdRow>,
  serverId: string
): PrincipalIdDecision {
  const here = rows.find((row) => row.serverId === serverId)
  if (here?.state === 'present') {
    return here.uid !== null && here.gid !== null
      ? { kind: 'use', uid: here.uid, gid: here.gid }
      : { kind: 'none' }
  }
  const withIds = rows.filter((row) => row.uid !== null && row.gid !== null)
  // Deterministic: an account that exists wins, then the lowest server id.
  const known = [...withIds].sort(
    (a, b) =>
      Number(b.state === 'present') - Number(a.state === 'present') ||
      a.serverId.localeCompare(b.serverId)
  )[0]
  if (known) {
    return { kind: 'use', uid: known.uid as number, gid: known.gid as number }
  }
  // A `pending` row without ids is only a queued deploy (or ids a host refused
  // and the control plane let go); `present` / `retiring` without ids is an
  // account that exists with an id nobody has reported yet.
  const unreported = rows.some((row) => row.state === 'present' || row.state === 'retiring')
  return unreported ? { kind: 'none' } : { kind: 'allocate' }
}

export type PrincipalIdRequest = {
  principalId: string
  /** Account home to record on a new placement (`principalHomeDir`). */
  home: string
}

export type PrincipalIds = { uid: number; gid: number }

async function loadPlacementIdRows(
  db: Db,
  principalIds: ReadonlyArray<string>
): Promise<Map<string, PlacementIdRow[]>> {
  const out = new Map<string, PlacementIdRow[]>()
  for (const id of principalIds) out.set(id, [])
  if (principalIds.length === 0) return out
  const rows = await db
    .select({
      principalId: principalPlacement.principalId,
      serverId: principalPlacement.serverId,
      state: principalPlacement.state,
      uid: principalPlacement.uid,
      gid: principalPlacement.gid,
    })
    .from(principalPlacement)
    .where(inArray(principalPlacement.principalId, [...principalIds]))
  for (const row of rows) {
    out.get(row.principalId)?.push({
      serverId: row.serverId,
      state: row.state as PlacementState,
      uid: row.uid,
      gid: row.gid,
    })
  }
  return out
}

/**
 * Next free number from the sequence. A value another principal already holds
 * somewhere (a reported id from an older host) is skipped, not reused.
 */
async function takeFreshId(tx: Db, principalId: string): Promise<number> {
  for (let attempt = 0; attempt <= MAX_SEQUENCE_SKIPS; attempt += 1) {
    const rows = await tx.execute<{ id: number }>(
      sql`SELECT nextval('principal_id_seq')::int AS id`
    )
    const id = Number(rows[0]?.id)
    if (!Number.isInteger(id) || id < PRINCIPAL_ID_BAND_MIN || id > PRINCIPAL_ID_BAND_MAX) {
      throw new Error('principal id sequence returned a value outside the band')
    }
    const taken = await tx
      .select({ id: principalPlacement.id })
      .from(principalPlacement)
      .where(
        and(
          ne(principalPlacement.principalId, principalId),
          sql`(${principalPlacement.uid} = ${id} OR ${principalPlacement.gid} = ${id})`
        )
      )
      .limit(1)
    if (taken.length === 0) return id
  }
  throw new Error('no free principal id found in the sequence')
}

/**
 * Record a new principal's ids on a `pending` placement for `serverId`. Under
 * a per-principal lock so two servers asked at once settle on one number; the
 * answer is re-read inside the lock.
 */
async function allocateForPrincipal(
  db: Db,
  serverId: string,
  request: PrincipalIdRequest
): Promise<PrincipalIds | null> {
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`principal-ids:${request.principalId}`}, 0))`
    )
    const rows = (await loadPlacementIdRows(tx, [request.principalId])).get(request.principalId)
    const decision = decidePrincipalIds(rows ?? [], serverId)
    if (decision.kind === 'use') {
      return { uid: decision.uid, gid: decision.gid }
    }
    if (decision.kind === 'none') return null
    const id = await takeFreshId(tx, request.principalId)
    await tx
      .insert(principalPlacement)
      .values({
        principalId: request.principalId,
        serverId,
        state: 'pending' satisfies PlacementState,
        uid: id,
        gid: id,
        home: request.home,
        // Rewritten with the real reason when the deploy records the placement.
        source: 'manual',
      })
      .onConflictDoUpdate({
        target: [principalPlacement.principalId, principalPlacement.serverId],
        set: {
          uid: id,
          gid: id,
          state: sql`CASE WHEN ${principalPlacement.state} = 'present' THEN 'present' ELSE 'pending' END`,
        },
      })
    return { uid: id, gid: id }
  })
}

function logSkipped(serverId: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  compatLogWarn('principals', `principal id allocation skipped on server ${serverId}: ${message}`)
}

/**
 * The id to send for each principal on `serverId`. Principals that get none
 * are absent from the map (the host then picks and reports). With `allocate`
 * false (a preview) nothing is allocated or written.
 *
 * Never throws: a failure here must not stop a deploy, and the host can still
 * pick an id and report it. It is logged.
 */
export async function resolvePrincipalIds(
  db: Db,
  serverId: string,
  requests: ReadonlyArray<PrincipalIdRequest>,
  options: Readonly<{ allocate: boolean }>
): Promise<Map<string, PrincipalIds>> {
  const out = new Map<string, PrincipalIds>()
  if (requests.length === 0) return out
  let rowsByPrincipal: Map<string, PlacementIdRow[]>
  try {
    rowsByPrincipal = await loadPlacementIdRows(
      db,
      requests.map((request) => request.principalId)
    )
  } catch (err) {
    logSkipped(serverId, err)
    return out
  }
  for (const request of requests) {
    try {
      const decision = decidePrincipalIds(rowsByPrincipal.get(request.principalId) ?? [], serverId)
      if (decision.kind === 'use') {
        out.set(request.principalId, { uid: decision.uid, gid: decision.gid })
      } else if (decision.kind === 'allocate' && options.allocate) {
        const ids = await allocateForPrincipal(db, serverId, request)
        if (ids) out.set(request.principalId, ids)
      }
    } catch (err) {
      logSkipped(serverId, err)
    }
  }
  return out
}

/** One account's ids as the daemon read them back from the host. */
export type ReportedPrincipalId = {
  principalId: string
  uid: number
  gid: number
}

function isReportableId(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 2_147_483_647
}

/**
 * Fill placement rows from what the host reports. Only an empty row is
 * filled: a recorded id is never overwritten, so a host that disagrees with
 * the record shows up as a warning instead of a silent change. Rows that do
 * not exist are not created (the report is not a reason for a placement).
 */
export async function recordReportedPrincipalIds(
  db: Db,
  serverId: string,
  reports: ReadonlyArray<ReportedPrincipalId>
): Promise<void> {
  for (const report of reports) {
    if (!isReportableId(report.uid) || !isReportableId(report.gid)) continue
    try {
      const [row] = await db
        .select({
          id: principalPlacement.id,
          uid: principalPlacement.uid,
          gid: principalPlacement.gid,
        })
        .from(principalPlacement)
        .where(
          and(
            eq(principalPlacement.serverId, serverId),
            eq(principalPlacement.principalId, report.principalId)
          )
        )
        .limit(1)
      if (!row) continue
      if (row.uid === null || row.gid === null) {
        await db
          .update(principalPlacement)
          .set({ uid: report.uid, gid: report.gid })
          .where(eq(principalPlacement.id, row.id))
      } else if (row.uid !== report.uid || row.gid !== report.gid) {
        compatLogWarn(
          'principals',
          `server ${serverId} reports uid=${report.uid} gid=${report.gid} for principal ${report.principalId}, recorded uid=${row.uid} gid=${row.gid}; the record is kept`
        )
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      compatLogWarn(
        'principals',
        `reported ids for principal ${report.principalId} on server ${serverId} not recorded: ${message}`
      )
    }
  }
}

const ID_TAKEN_RE = /principal_id_taken kind=(uid|gid) id=(\d+) principalId=([0-9a-f-]{36})/

/** The refusal the daemon sends when an id it was asked for is held by another account. */
export function parsePrincipalIdTaken(
  error: string
): { kind: 'uid' | 'gid'; id: number; principalId: string } | null {
  const match = ID_TAKEN_RE.exec(error)
  if (!match) return null
  return {
    kind: match[1] as 'uid' | 'gid',
    id: Number(match[2]),
    principalId: match[3]!,
  }
}

/**
 * A host refused an id the control plane allocated. If that id is not on any
 * account yet (no placement is `present`), forget it on the refusing server only, so the next attempt takes
 * the next free number from the sequence. If the principal already exists
 * somewhere with this id, nothing changes: the account is never renumbered, the
 * failed command stays failed and says why.
 *
 * Returns true when the recorded ids were cleared.
 */
export async function releaseRefusedPrincipalIds(
  db: Db,
  serverId: string,
  error: string
): Promise<boolean> {
  const taken = parsePrincipalIdTaken(error)
  if (!taken) return false
  const rows = await db
    .select({ state: principalPlacement.state })
    .from(principalPlacement)
    .where(eq(principalPlacement.principalId, taken.principalId))
  if (rows.some((row) => row.state === 'present')) return false
  await db
    .update(principalPlacement)
    .set({ uid: null, gid: null })
    .where(
      and(
        eq(principalPlacement.principalId, taken.principalId),
        eq(principalPlacement.serverId, serverId),
        ne(principalPlacement.state, 'present'),
        eq(principalPlacement.uid, taken.id)
      )
    )
  return true
}
