/**
 * `GET|PUT /organizations/:id/compose-remote-build-sources` — org-owner-only
 * opt-in that lets a Compose build fetch its source from a public remote (a
 * URL or git `build.context`). Internal hosts stay refused whatever this
 * says. The session guard is mounted through `SESSION_GUARDED_ORG_PATHS`.
 */
import { eq, sql } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { getDb } from '../../db/connection.ts'
import { organization } from '../../db/schema.ts'
import { recordAudit } from '../../features/audit/audit-records.ts'
import {
  parseOrganizationOptions,
  resolveComposeRemoteBuildSourcesEnabled,
} from '../../features/organizations/organization-options.ts'
import { assertOrgOwnerOr403 } from '../authz/index.ts'
import { parseJsonBody } from '../shared.ts'

const PATH = '/organizations/:id/compose-remote-build-sources'

export function parseComposeRemoteBuildSourcesPatch(body: Record<string, unknown>) {
  const value = body.composeRemoteBuildSourcesEnabled
  if (typeof value !== 'boolean') {
    return {
      ok: false as const,
      error: 'Invalid composeRemoteBuildSourcesEnabled',
      status: 400 as const,
    }
  }
  return { ok: true as const, patch: { composeRemoteBuildSourcesEnabled: value } }
}

export function composeRemoteBuildSourcesResponse(options: {
  composeRemoteBuildSourcesEnabled?: boolean
}) {
  return { composeRemoteBuildSourcesEnabled: resolveComposeRemoteBuildSourcesEnabled(options) }
}

async function handleGet(c: Context<AppEnv>) {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)
  const id = c.req.param('id') ?? ''
  const denied = await assertOrgOwnerOr403(c, 'organization', id)
  if (denied) return denied
  const [orgRow] = await db
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, id))
    .limit(1)
  if (!orgRow) return c.json({ error: 'Not found' }, 404)
  return c.json(composeRemoteBuildSourcesResponse(parseOrganizationOptions(orgRow.options)))
}

async function handlePut(c: Context<AppEnv>) {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)
  const session = c.get('session')
  const id = c.req.param('id') ?? ''
  const denied = await assertOrgOwnerOr403(c, 'organization', id)
  if (denied) return denied
  const body = await parseJsonBody(c)
  if (body instanceof Response) return body
  const parsed = parseComposeRemoteBuildSourcesPatch(body)
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status)
  const patch = parsed.patch

  const [updated] = await db
    .update(organization)
    .set({
      options: sql`COALESCE(${organization.options}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(organization.id, id))
    .returning({ options: organization.options })
  if (!updated) return c.json({ error: 'Not found' }, 404)

  await recordAudit(db, {
    organizationId: id,
    actorUserId: session?.userId ?? null,
    actorEmail: session?.email ?? null,
    action: 'organization.compose_remote_build_sources.set',
    targetType: 'organization',
    targetId: id,
    context: patch,
  })
  return c.json({
    ok: true as const,
    ...composeRemoteBuildSourcesResponse(parseOrganizationOptions(updated.options)),
  })
}

export function registerComposeRemoteBuildSourcesRoutes(router: Hono<AppEnv>) {
  router.get(PATH, handleGet)
  router.put(PATH, handlePut)
}
