/**
 * Server removal asks per principal.
 *
 * Deleting a server takes every placement on it with it (the row cascades),
 * which is the default answer for each principal: keep the identity, it is
 * simply no longer on this server. The owner may instead ask for a principal
 * to be deleted outright, and that is refused while anything else still uses
 * it — a tenancy, a binding, a storage entry, a secret, or a placement on
 * another server. `GET /servers/:id/principal-removal-plan` lists the
 * placements with that verdict; `DELETE /servers/:id` accepts the choices.
 */
import { and, eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { Db } from '../../db/connection.ts'
import { server } from '../../db/schema.ts'
import {
  emptyPrincipalUsage,
  isPrincipalUnused,
  listServerPlacements,
  loadPrincipalUsage,
  type PrincipalUsage,
  type ServerPlacementRow,
} from '../../features/principals/placement-records.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { resolveOrgRequest } from '../org-request.ts'
import { assertCanReadOr403 } from '../shared.ts'

export const PRINCIPAL_REMOVAL_ACTIONS = ['keep', 'delete'] as const
export type PrincipalRemovalAction = (typeof PRINCIPAL_REMOVAL_ACTIONS)[number]

/** The answer every row starts with: the identity stays, only this server forgets it. */
export const PRINCIPAL_REMOVAL_DEFAULT_ACTION: PrincipalRemovalAction = 'keep'

export type PrincipalRemovalChoice = {
  principalId: string
  action: PrincipalRemovalAction
}

export type PrincipalRemovalPlanEntry = Omit<ServerPlacementRow, 'id'> & {
  placementId: string
  defaultAction: PrincipalRemovalAction
  /** False while something other than this placement still uses the principal. */
  canDeleteOutright: boolean
  usedBy: PrincipalUsage
}

export const PRINCIPAL_DELETE_REFUSED_CODE = 'principal_delete_refused'
export const PRINCIPAL_DELETE_REFUSED_ERROR =
  'A principal cannot be deleted outright while something else still uses it'

export const PRINCIPAL_NOT_ON_SERVER_CODE = 'principal_not_on_server'
export const PRINCIPAL_NOT_ON_SERVER_ERROR = 'A named principal has no placement on this server'

export const PRINCIPAL_REMOVAL_CHOICES_INVALID_ERROR =
  'principals must be a list of { principalId, action: keep | delete } with each principal once'

export type PrincipalRemovalRefusal = {
  principalId: string
  reason: 'not_on_server' | 'in_use'
  usedBy?: PrincipalUsage
}

/** Every placement on the server with the default answer and the delete verdict. */
export async function loadPrincipalRemovalPlan(
  db: Db,
  serverId: string
): Promise<PrincipalRemovalPlanEntry[]> {
  const rows = await listServerPlacements(db, serverId)
  const usage = await loadPrincipalUsage(
    db,
    rows.map((row) => row.principalId),
    serverId
  )
  return rows.map(({ id, ...row }) => {
    const usedBy = usage.get(row.principalId) ?? emptyPrincipalUsage()
    return {
      ...row,
      placementId: id,
      defaultAction: PRINCIPAL_REMOVAL_DEFAULT_ACTION,
      canDeleteOutright: isPrincipalUnused(usedBy),
      usedBy,
    }
  })
}

function isRemovalAction(value: unknown): value is PrincipalRemovalAction {
  return (
    typeof value === 'string' && (PRINCIPAL_REMOVAL_ACTIONS as readonly string[]).includes(value)
  )
}

/**
 * `body.principals`: absent means keep everything. Anything else must be a
 * list of `{ principalId, action }`, each principal named once.
 */
export function parsePrincipalRemovalChoices(
  body: Record<string, unknown>
): PrincipalRemovalChoice[] | { error: string } {
  const raw = body.principals
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return { error: PRINCIPAL_REMOVAL_CHOICES_INVALID_ERROR }
  const choices: PrincipalRemovalChoice[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { error: PRINCIPAL_REMOVAL_CHOICES_INVALID_ERROR }
    }
    const { principalId, action } = entry as Record<string, unknown>
    if (typeof principalId !== 'string' || principalId.length === 0 || !isRemovalAction(action)) {
      return { error: PRINCIPAL_REMOVAL_CHOICES_INVALID_ERROR }
    }
    if (seen.has(principalId)) return { error: PRINCIPAL_REMOVAL_CHOICES_INVALID_ERROR }
    seen.add(principalId)
    choices.push({ principalId, action })
  }
  return choices
}

/**
 * Choices the plan does not allow: a principal that is not on this server at
 * all, or a `delete` while something else still uses the principal. `keep`
 * for a placed principal is always allowed (it is the default).
 */
export function resolvePrincipalRemovalRefusals(
  plan: ReadonlyArray<PrincipalRemovalPlanEntry>,
  choices: ReadonlyArray<PrincipalRemovalChoice>
): PrincipalRemovalRefusal[] {
  const byId = new Map(plan.map((entry) => [entry.principalId, entry]))
  const refusals: PrincipalRemovalRefusal[] = []
  for (const choice of choices) {
    const entry = byId.get(choice.principalId)
    if (!entry) {
      refusals.push({ principalId: choice.principalId, reason: 'not_on_server' })
      continue
    }
    if (choice.action === 'delete' && !entry.canDeleteOutright) {
      refusals.push({ principalId: choice.principalId, reason: 'in_use', usedBy: entry.usedBy })
    }
  }
  return refusals
}

/** Principals chosen for outright deletion; call after refusals came back empty. */
export function principalIdsToDelete(choices: ReadonlyArray<PrincipalRemovalChoice>): string[] {
  return choices.filter((choice) => choice.action === 'delete').map((choice) => choice.principalId)
}

export function registerServerPrincipalRemovalRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for server principal removal routes')
  }
  router.use('/servers/:id/principal-removal-plan', createSessionMiddleware(opts.secrets))

  router.get('/servers/:id/principal-removal-plan', async (c) => {
    const scope = await resolveOrgRequest(c)
    if (scope instanceof Response) return scope
    const { db, organizationId } = scope
    const serverId = c.req.param('id')

    const [row] = await db
      .select({ id: server.id })
      .from(server)
      .where(and(eq(server.id, serverId), eq(server.organizationId, organizationId)))
      .limit(1)
    if (!row) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanReadOr403(c, 'server', serverId)
    if (denied) return denied

    return c.json({ serverId, principals: await loadPrincipalRemovalPlan(db, serverId) })
  })
}
