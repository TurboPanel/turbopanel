/**
 * `GET|PUT /organizations/:id/reauth-settings` — the switch for step-up
 * re-authentication (see `../authn/step-up.ts`). Reading needs
 * organization:manage; changing it is owner-only, so a manager cannot turn
 * the protection off. Stored in `organization.options`, audited.
 */
import { eq, sql } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { type Db, getDb } from '../../db/connection.ts'
import { organization } from '../../db/schema.ts'
import { recordAudit } from '../../features/audit/audit-records.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { assertOrgOwnerOr403 } from '../authz/index.ts'
import { assertCanManageOr403, parseJsonBody } from '../shared.ts'
import {
  type OrganizationOptions,
  parseOrganizationOptions,
  resolveRequireReauthForDestructive,
} from '../../features/organizations/organization-options.ts'

function parsePatch(body: Record<string, unknown>) {
  if (typeof body.requireReauthForDestructive !== 'boolean') {
    return { ok: false as const, error: 'Invalid requireReauthForDestructive' }
  }
  return {
    ok: true as const,
    patch: { requireReauthForDestructive: body.requireReauthForDestructive },
  }
}

function settingsOf(options: OrganizationOptions) {
  return { requireReauthForDestructive: resolveRequireReauthForDestructive(options) }
}

const PATH = '/organizations/:id/reauth-settings'

async function readOptions(db: Db, id: string) {
  const [row] = await db
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, id))
    .limit(1)
  return row ? parseOrganizationOptions(row.options) : null
}

async function mergeOptions(db: Db, id: string, patch: Record<string, unknown>) {
  await db
    .update(organization)
    .set({
      options: sql`COALESCE(${organization.options}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(organization.id, id))
}

async function handleGet(c: Context<AppEnv>) {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)
  const id = c.req.param('id') ?? ''
  const denied = await assertCanManageOr403(c, 'organization', id)
  if (denied) return denied
  const options = await readOptions(db, id)
  return options ? c.json(settingsOf(options)) : c.json({ error: 'Not found' }, 404)
}

async function handlePut(c: Context<AppEnv>) {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)
  const id = c.req.param('id') ?? ''
  const denied = await assertOrgOwnerOr403(c, 'organization', id)
  if (denied) return denied
  const body = await parseJsonBody(c)
  if (body instanceof Response) return body
  const parsed = parsePatch(body)
  if (!parsed.ok) return c.json({ error: parsed.error }, 400)
  if ((await readOptions(db, id)) === null) return c.json({ error: 'Not found' }, 404)

  await mergeOptions(db, id, parsed.patch)
  const session = c.get('session')
  await recordAudit(db, {
    organizationId: id,
    actorUserId: session?.userId ?? null,
    actorEmail: session?.email ?? null,
    action: 'organization.reauth_for_destructive.set',
    targetType: 'organization',
    targetId: id,
    context: { requireReauthForDestructive: parsed.patch.requireReauthForDestructive },
  })
  return c.json({ ok: true as const, ...settingsOf((await readOptions(db, id)) ?? {}) })
}

export function registerReauthSettingsRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for organization routes')
  }
  router.use(PATH, createSessionMiddleware(opts.secrets))
  router.get(PATH, handleGet)
  router.put(PATH, handlePut)
}
