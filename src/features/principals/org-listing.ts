/**
 * Org-wide and per-server views of principals.
 *
 * A principal is one identity row per organization. It shows up as a system
 * user on each server it is placed on and as a database login on each cluster
 * that carries one for it. These readers join those forms back together for
 * the Manage organization "Principals" tab and the server "Principals" tab;
 * the routes in `client/principals/org-routes.ts` are thin wrappers.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import {
  login,
  principal,
  principalPlacement,
  PRINCIPAL_NAME_POOL_WHERE,
  project,
  server,
} from '../../db/schema.ts'
import {
  emptyPrincipalUsage,
  isPrincipalUnused,
  listServerPlacements,
  loadPrincipalUsage,
  type PrincipalUsage,
  type ServerPlacementRow,
} from './placement-records.ts'
import type { PlacementState } from './placement-vocabulary.ts'
import { SERVER_PRINCIPAL_PROVIDER } from './store.ts'

/** Worst state first: what the row should show when placements disagree. */
const STATE_PRECEDENCE: readonly PlacementState[] = ['retiring', 'pending', 'present', 'absent']

/** The one state shown for a principal: `none` when it is placed nowhere. */
export function summarizePlacementState(
  states: ReadonlyArray<PlacementState>
): PlacementState | 'none' {
  for (const state of STATE_PRECEDENCE) {
    if (states.includes(state)) return state
  }
  return 'none'
}

export type OrgPrincipalPlacement = {
  serverId: string
  serverName: string | null
  state: PlacementState
  uid: number | null
  gid: number | null
}

export type OrgPrincipalLogin = {
  id: string
  managedId: string
  role: string
  appliedUsername: string
}

export type OrgPrincipalRow = {
  id: string
  /** The typed name. */
  name: string
  /** The login on the host or engine. */
  appliedUsername: string
  kind: string
  provider: string
  /** Which forms the principal has: a system user, a database login, or both. */
  forms: Array<'system' | 'database'>
  projectId: string | null
  projectName: string | null
  servers: OrgPrincipalPlacement[]
  logins: OrgPrincipalLogin[]
  /** Everything but placements that still uses the principal. */
  usedBy: Omit<PrincipalUsage, 'otherPlacements'>
  /** Worst placement state, `none` when placed on no server. */
  state: PlacementState | 'none'
  /** No project and nothing uses it: a leftover of a deleted project. */
  orphaned: boolean
  /** Delete is allowed right now (an orphaned server-form principal). */
  canDelete: boolean
  createdAt: string
}

/** True when the org-wide delete route would accept this principal. */
export function isOrphanDeletable(
  row: Readonly<{ projectId: string | null; provider: string }>,
  usage: PrincipalUsage
): boolean {
  return (
    row.projectId === null &&
    row.provider === SERVER_PRINCIPAL_PROVIDER &&
    usage.tenancies === 0 &&
    usage.bindings === 0 &&
    usage.storages === 0 &&
    usage.secrets === 0 &&
    usage.logins === 0
  )
}

function groupBy<T>(rows: ReadonlyArray<T>, key: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>()
  for (const row of rows) {
    const list = grouped.get(key(row))
    if (list) list.push(row)
    else grouped.set(key(row), [row])
  }
  return grouped
}

/**
 * Every principal in the organization's name pool (the cluster's own root and
 * replication logins are not principals a person manages and are left out),
 * ordered by name.
 */
export async function listOrganizationPrincipals(
  db: Db,
  organizationId: string
): Promise<OrgPrincipalRow[]> {
  const rows = await db
    .select({
      id: principal.id,
      username: principal.username,
      appliedUsername: principal.appliedUsername,
      kind: principal.kind,
      provider: principal.provider,
      projectId: principal.projectId,
      createdAt: principal.createdAt,
    })
    .from(principal)
    .where(and(eq(principal.organizationId, organizationId), PRINCIPAL_NAME_POOL_WHERE))
    .orderBy(asc(sql`lower(${principal.username})`), asc(principal.id))
  if (rows.length === 0) return []

  const ids = rows.map((row) => row.id)
  // Looked up apart from the principal query: the pool predicate uses bare
  // column names, which a join to `project` would make ambiguous.
  const projectIds = [...new Set(rows.flatMap((row) => (row.projectId ? [row.projectId] : [])))]
  const projectNames = new Map<string, string | null>()
  if (projectIds.length > 0) {
    const projects = await db
      .select({ id: project.id, name: project.name })
      .from(project)
      .where(inArray(project.id, projectIds))
    for (const p of projects) projectNames.set(p.id, p.name)
  }
  const usage = await loadPrincipalUsage(db, ids)
  const placements = await db
    .select({
      principalId: principalPlacement.principalId,
      serverId: principalPlacement.serverId,
      serverName: server.name,
      state: principalPlacement.state,
      uid: principalPlacement.uid,
      gid: principalPlacement.gid,
    })
    .from(principalPlacement)
    .innerJoin(server, eq(principalPlacement.serverId, server.id))
    .where(inArray(principalPlacement.principalId, ids))
    .orderBy(asc(server.name), asc(server.id))
  const logins = await db
    .select({
      id: login.id,
      principalId: login.principalId,
      managedId: login.managedId,
      role: login.role,
      appliedUsername: login.appliedUsername,
    })
    .from(login)
    .where(inArray(login.principalId, ids))
    .orderBy(asc(login.appliedUsername), asc(login.id))
  const placementsById = groupBy(placements, (row) => row.principalId)
  const loginsById = groupBy(logins, (row) => row.principalId ?? '')

  return rows.map((row) => {
    const used = usage.get(row.id) ?? emptyPrincipalUsage()
    const servers = (placementsById.get(row.id) ?? []).map((p) => ({
      serverId: p.serverId,
      serverName: p.serverName,
      state: p.state as PlacementState,
      uid: p.uid,
      gid: p.gid,
    }))
    const principalLogins = (loginsById.get(row.id) ?? []).map((l) => ({
      id: l.id,
      managedId: l.managedId,
      role: l.role,
      appliedUsername: l.appliedUsername,
    }))
    const forms: OrgPrincipalRow['forms'] = []
    if (row.provider === SERVER_PRINCIPAL_PROVIDER || servers.length > 0) forms.push('system')
    if (row.provider !== SERVER_PRINCIPAL_PROVIDER || principalLogins.length > 0) {
      forms.push('database')
    }
    const { otherPlacements: _placements, ...usedBy } = used
    const unused = isPrincipalUnused({ ...used, otherPlacements: 0 })
    return {
      id: row.id,
      name: row.username,
      appliedUsername: row.appliedUsername,
      kind: row.kind,
      provider: row.provider,
      forms,
      projectId: row.projectId,
      projectName: row.projectId ? (projectNames.get(row.projectId) ?? null) : null,
      servers,
      logins: principalLogins,
      usedBy,
      state: summarizePlacementState(servers.map((p) => p.state)),
      orphaned: row.projectId === null && unused,
      canDelete: isOrphanDeletable(row, used),
      createdAt: row.createdAt,
    }
  })
}

export type ServerPrincipalRow = Omit<ServerPlacementRow, 'id'> & {
  placementId: string
  /** What else still uses the principal, counted per kind (this server excluded). */
  usedBy: PrincipalUsage
}

/** Principals placed on one server, with the placement state and what else uses each. */
export async function listServerPrincipals(
  db: Db,
  serverId: string
): Promise<ServerPrincipalRow[]> {
  const rows = await listServerPlacements(db, serverId)
  const usage = await loadPrincipalUsage(
    db,
    rows.map((row) => row.principalId),
    serverId
  )
  return rows.map(({ id, ...row }) => ({
    ...row,
    placementId: id,
    usedBy: usage.get(row.principalId) ?? emptyPrincipalUsage(),
  }))
}
