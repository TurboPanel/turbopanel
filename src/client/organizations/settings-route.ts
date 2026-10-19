/**
 * The shared shape of the `/organizations/:id/<setting>` routes: open the
 * database, gate on the caller's rights, read the stored `organization.options`,
 * write a change and answer from what was stored.
 *
 * Every step runs the same queries, in the same order, as the hand-written
 * handlers did before, so a route built from these helpers behaves the same.
 */
import { eq, type SQL, sql } from 'drizzle-orm'
import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { assertOrgOwnerOr403 } from '../authz/index.ts'
import { assertCanManageOr403, parseJsonBody } from '../shared.ts'
import { type Db, getDb } from '../../db/connection.ts'
import { organization } from '../../db/schema.ts'
import { type AuditAction, recordAudit } from '../../features/audit/audit-records.ts'
import {
  type OrganizationOptions,
  parseOrganizationOptions,
} from '../../features/organizations/organization-options.ts'
import type { OrganizationRouteValidationError } from './routes-helpers.ts'

/** Who may use a settings route: organization managers, or the owner alone. */
export type OrgSettingsGate = 'manage' | 'owner'

export type OrgSettingsScope = { db: Db; id: string }

/** The database and the gated `:id`, or the response that refuses the request. */
export async function openOrgSettingsScope(
  c: Context<AppEnv>,
  gate: OrgSettingsGate
): Promise<OrgSettingsScope | Response> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)
  const id = c.req.param('id') ?? ''
  const denied =
    gate === 'owner'
      ? await assertOrgOwnerOr403(c, 'organization', id)
      : await assertCanManageOr403(c, 'organization', id)
  if (denied) return denied
  return { db, id }
}

/** The stored options row, or `undefined` when the organization does not exist. */
export async function loadOrgOptionsRow(
  db: Db,
  id: string
): Promise<{ options: unknown } | undefined> {
  const [row] = await db
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, id))
    .limit(1)
  return row
}

/** Write `options` (an expression over the stored value) and bump `updatedAt`. */
export async function writeOrgOptions(db: Db, id: string, options: SQL): Promise<void> {
  await db
    .update(organization)
    .set({ options, updatedAt: new Date().toISOString() })
    .where(eq(organization.id, id))
}

/** Shallow jsonb merge of `patch` into the stored options. */
export function mergeOrgOptionsSql(patch: Record<string, unknown>): SQL {
  return sql`COALESCE(${organization.options}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`
}

/** The stored options without the top-level `key`. */
export function removeOrgOptionSql(key: string): SQL {
  return sql`COALESCE(${organization.options}, '{}'::jsonb) - ${key}::text`
}

/** Audit a settings change made by the session's user. */
export async function recordOrgSettingAudit(
  c: Context<AppEnv>,
  scope: OrgSettingsScope,
  action: AuditAction,
  context: Record<string, unknown>
): Promise<void> {
  const session = c.get('session')
  await recordAudit(scope.db, {
    organizationId: scope.id,
    actorUserId: session?.userId ?? null,
    actorEmail: session?.email ?? null,
    action,
    targetType: 'organization',
    targetId: scope.id,
    context,
  })
}

/** `GET`: answer from the stored options. */
export function orgOptionsGetRoute(
  gate: OrgSettingsGate,
  respond: (options: OrganizationOptions) => object
) {
  return async (c: Context<AppEnv>) => {
    const scope = await openOrgSettingsScope(c, gate)
    if (scope instanceof Response) return scope
    const row = await loadOrgOptionsRow(scope.db, scope.id)
    if (!row) return c.json({ error: 'Not found' }, 404)
    return c.json(respond(parseOrganizationOptions(row.options)))
  }
}

type ParsedPatch<P> = { ok: true; patch: P } | OrganizationRouteValidationError

/**
 * `PUT` for a setting stored as top-level option keys: parse the body, merge
 * the patch, re-read, optionally audit, answer from what was stored.
 */
export function orgOptionsPatchRoute<P extends Record<string, unknown>>(
  params: Readonly<{
    gate: OrgSettingsGate
    parse: (body: Record<string, unknown>) => ParsedPatch<P>
    respond: (options: OrganizationOptions) => object
    audit?: (patch: P) => { action: AuditAction; context: Record<string, unknown> }
    /** Runs after the options are written (before the audit row). */
    afterWrite?: (db: Db, organizationId: string, patch: P) => Promise<void>
  }>
) {
  return async (c: Context<AppEnv>) => {
    const scope = await openOrgSettingsScope(c, params.gate)
    if (scope instanceof Response) return scope

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const parsed = params.parse(body)
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status)

    if (!(await loadOrgOptionsRow(scope.db, scope.id))) {
      return c.json({ error: 'Not found' }, 404)
    }
    await writeOrgOptions(scope.db, scope.id, mergeOrgOptionsSql(parsed.patch))
    const options = parseOrganizationOptions((await loadOrgOptionsRow(scope.db, scope.id))?.options)
    await params.afterWrite?.(scope.db, scope.id, parsed.patch)

    if (params.audit) {
      const { action, context } = params.audit(parsed.patch)
      await recordOrgSettingAudit(c, scope, action, context)
    }
    return c.json(params.respond(options))
  }
}
