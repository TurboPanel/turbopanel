/**
 * PHP mode policy routes (manager-gated):
 *
 * - `GET/PUT /organizations/:id/php-modes` — modes the organization offers.
 * - `GET/PUT /servers/:id/php-modes` — modes one server offers, narrowed by
 *   the organization's list.
 *
 * A PUT never changes a site. It answers with `affectedSites`: sites whose
 * last deploy recorded a mode the new policy no longer offers. They keep that
 * mode until someone picks another (`features/hostings/php-mode.ts`).
 */
import { and, eq, sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanManageOr403, parseJsonBody } from '../shared.ts'
import { resolveOrgRequest } from '../org-request.ts'
import { type Db, getDb } from '../../db/connection.ts'
import { deployment, organization, server } from '../../db/schema.ts'
import {
  allowedPhpModes,
  defaultPhpMode,
  ENGINE_PHP_MODES,
  listPhpModeAffectedSites,
  parsePhpModes,
  parsePhpModesInput,
  type PhpMode,
  type PhpModePolicy,
} from '../../features/hostings/php-mode.ts'
import type { SiteEngine } from '../../features/compose/service-kind.ts'

function readPolicyList(options: unknown): PhpMode[] | undefined {
  return parsePhpModes((options as { phpModes?: unknown } | null)?.phpModes)
}

/** `options` with `phpModes` set, or removed when `null` (every mode offered again). */
function nextOptionsSql(column: AnyPgColumn, phpModes: PhpMode[] | null) {
  const base = sql`COALESCE(${column}, '{}'::jsonb)`
  if (phpModes === null) return sql`${base} - 'phpModes'::text`
  return sql`${base} || ${JSON.stringify({ phpModes })}::jsonb`
}

/** Per engine: the modes a site may pick under this policy, and what a new site gets. */
function engineChoices(policy: PhpModePolicy) {
  const engines = Object.keys(ENGINE_PHP_MODES) as SiteEngine[]
  return Object.fromEntries(
    engines.map((engine) => {
      const allowed = allowedPhpModes(policy, engine)
      return [engine, { allowed, default: defaultPhpMode(allowed) ?? null }]
    })
  )
}

async function parsePolicyBody(c: Context): Promise<PhpMode[] | null | Response> {
  const body = await parseJsonBody(c)
  if (body instanceof Response) return body
  const parsed = parsePhpModesInput(body.phpModes)
  if (!parsed.ok) return c.json({ error: 'invalid_php_modes' }, 400)
  return parsed.value
}

async function organizationAffectedSites(db: Db, organizationId: string, list: PhpMode[] | null) {
  const rows = await db
    .select({
      environmentId: deployment.environmentId,
      serverId: deployment.serverId,
      deploymentOptions: deployment.options,
      serverOptions: server.options,
    })
    .from(deployment)
    .innerJoin(server, eq(server.id, deployment.serverId))
    .where(eq(server.organizationId, organizationId))
  return listPhpModeAffectedSites(
    rows.map((row) => ({
      ...row,
      policy: { organization: list ?? undefined, server: readPolicyList(row.serverOptions) },
    }))
  )
}

async function serverAffectedSites(
  db: Db,
  serverId: string,
  organizationList: PhpMode[] | undefined,
  list: PhpMode[] | null
) {
  const rows = await db
    .select({
      environmentId: deployment.environmentId,
      serverId: deployment.serverId,
      deploymentOptions: deployment.options,
    })
    .from(deployment)
    .where(eq(deployment.serverId, serverId))
  const policy = { organization: organizationList, server: list ?? undefined }
  return listPhpModeAffectedSites(rows.map((row) => ({ ...row, policy })))
}

async function loadOrganizationList(db: Db, organizationId: string) {
  const [row] = await db
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1)
  return row ? { list: readPolicyList(row.options) } : null
}

function registerOrganizationPhpModeRoutes(router: Hono<AppEnv>) {
  router.get('/organizations/:id/php-modes', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)
    const id = c.req.param('id')
    const denied = await assertCanManageOr403(c, 'organization', id)
    if (denied) return denied

    const org = await loadOrganizationList(db, id)
    if (!org) return c.json({ error: 'Not found' }, 404)
    return c.json({
      phpModes: org.list ?? null,
      engines: engineChoices({ organization: org.list }),
    })
  })

  router.put('/organizations/:id/php-modes', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)
    const id = c.req.param('id')
    const denied = await assertCanManageOr403(c, 'organization', id)
    if (denied) return denied

    const list = await parsePolicyBody(c)
    if (list instanceof Response) return list

    // One jsonb expression, so a concurrent change to another option survives.
    const [updated] = await db
      .update(organization)
      .set({
        options: nextOptionsSql(organization.options, list),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(organization.id, id))
      .returning({ id: organization.id })
    if (!updated) return c.json({ error: 'Not found' }, 404)

    return c.json({
      ok: true as const,
      phpModes: list,
      affectedSites: await organizationAffectedSites(db, id, list),
    })
  })
}

function registerServerPhpModeRoutes(router: Hono<AppEnv>) {
  /** The server, scoped to the caller's organization: another org's server is 404. */
  const loadServer = async (c: Context<AppEnv>) => {
    const scope = await resolveOrgRequest(c)
    if (scope instanceof Response) return scope
    const id = c.req.param('id') ?? ''
    const [row] = await scope.db
      .select({ options: server.options })
      .from(server)
      .where(and(eq(server.id, id), eq(server.organizationId, scope.organizationId)))
      .limit(1)
    if (!row) return c.json({ error: 'Not found' }, 404)
    const denied = await assertCanManageOr403(c, 'server', id)
    if (denied) return denied
    const org = await loadOrganizationList(scope.db, scope.organizationId)
    return { ...scope, id, serverList: readPolicyList(row.options), organizationList: org?.list }
  }

  router.get('/servers/:id/php-modes', async (c) => {
    const loaded = await loadServer(c)
    if (loaded instanceof Response) return loaded
    return c.json({
      phpModes: loaded.serverList ?? null,
      organizationPhpModes: loaded.organizationList ?? null,
      engines: engineChoices({ organization: loaded.organizationList, server: loaded.serverList }),
    })
  })

  router.put('/servers/:id/php-modes', async (c) => {
    const loaded = await loadServer(c)
    if (loaded instanceof Response) return loaded
    const list = await parsePolicyBody(c)
    if (list instanceof Response) return list

    await loaded.db
      .update(server)
      .set({ options: nextOptionsSql(server.options, list), updatedAt: new Date().toISOString() })
      .where(eq(server.id, loaded.id))

    return c.json({
      ok: true as const,
      phpModes: list,
      affectedSites: await serverAffectedSites(loaded.db, loaded.id, loaded.organizationList, list),
    })
  })
}

export function registerPhpModeRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for php mode routes')
  }
  router.use('/organizations/:id/php-modes', createSessionMiddleware(opts.secrets))
  router.use('/servers/:id/php-modes', createSessionMiddleware(opts.secrets))
  registerOrganizationPhpModeRoutes(router)
  registerServerPhpModeRoutes(router)
}
