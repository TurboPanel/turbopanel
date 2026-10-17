/**
 * The common services and volumes an environment uses.
 *
 * A common asset belongs to a site owner (a Linux user on a server) and lives
 * in that owner's `common` folder scope, so any environment of any project in
 * the organization can use it. These routes record and remove that use:
 *
 * - `GET /environments/:id/shares` lists what the environment uses.
 * - `POST /environments/:id/shares` starts using one (`serviceId` or `storageId`).
 * - `DELETE /environments/:id/shares/:shareId` stops using it.
 *
 * Deleting the environment removes its rows; deleting a common asset is refused
 * while another environment uses it (see `features/folders/shares.ts`).
 */
import { eq } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { getDb } from '../../db/connection.ts'
import { service, storage, tenancy } from '../../db/schema.ts'
import {
  ASSET_NOT_COMMON_ERROR,
  deleteShare,
  insertShare,
  listEnvironmentShares,
} from '../../features/folders/shares.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403 } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { assertCanReadOr403, getOrgId, parseJsonBody } from '../shared.ts'

type Db = NonNullable<ReturnType<typeof getDb>>

const NO_OWNER_ERROR = 'asset_has_no_owner'
const HOME_ERROR = 'asset_in_this_environment'

type Asset = { kind: 'service'; id: string } | { kind: 'volume'; id: string }

function parseAsset(body: Record<string, unknown>): Asset | null {
  const { serviceId, storageId } = body
  const hasService = typeof serviceId === 'string' && serviceId.length > 0
  const hasStorage = typeof storageId === 'string' && storageId.length > 0
  if (hasService === hasStorage) return null
  return hasService
    ? { kind: 'service', id: serviceId as string }
    : { kind: 'volume', id: storageId as string }
}

type AssetFacts = { isCommon: boolean; homeEnvironmentId: string | null; hasOwner: boolean }

async function loadAssetFacts(db: Db, asset: Asset): Promise<AssetFacts | null> {
  if (asset.kind === 'service') {
    const [row] = await db
      .select({ isCommon: service.isCommon, environmentId: service.environmentId })
      .from(service)
      .where(eq(service.id, asset.id))
      .limit(1)
    if (!row) return null
    const owners = await db
      .select({ principalId: tenancy.principalId })
      .from(tenancy)
      .where(eq(tenancy.serviceId, asset.id))
    return {
      isCommon: row.isCommon,
      homeEnvironmentId: row.environmentId,
      hasOwner: owners.length === 1,
    }
  }
  const [row] = await db
    .select({
      isCommon: storage.isCommon,
      environmentId: storage.environmentId,
      principalId: storage.principalId,
      kind: storage.kind,
    })
    .from(storage)
    .where(eq(storage.id, asset.id))
    .limit(1)
  if (!row || (row.kind !== 'volume' && row.kind !== 'directory')) return null
  return {
    isCommon: row.isCommon,
    homeEnvironmentId: row.environmentId,
    hasOwner: row.principalId !== null,
  }
}

async function refuseUnusableAsset(
  c: Context<AppEnv>,
  db: Db,
  environmentId: string,
  organizationId: string,
  asset: Asset
): Promise<Response | null> {
  const assetOrgId = await resolveEntityOrganizationId(
    db,
    asset.kind === 'service' ? 'service' : 'storage',
    asset.id
  )
  if (!assetOrgId || assetOrgId !== organizationId) return c.json({ error: 'Not found' }, 404)
  const facts = await loadAssetFacts(db, asset)
  if (!facts) return c.json({ error: 'Not found' }, 404)
  if (!facts.isCommon) {
    return c.json(
      {
        error: ASSET_NOT_COMMON_ERROR,
        message:
          'Only a shared service or volume can be used by other environments. Whether it is shared is chosen when it is created.',
      },
      409
    )
  }
  if (facts.homeEnvironmentId === environmentId) {
    return c.json(
      {
        error: HOME_ERROR,
        message: 'This environment already owns it, so there is nothing to add.',
      },
      409
    )
  }
  if (!facts.hasOwner) {
    return c.json(
      {
        error: NO_OWNER_ERROR,
        message: 'Give it a site owner first. A shared item belongs to the site owner.',
      },
      409
    )
  }
  return null
}

export function registerEnvironmentShareRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for environment share routes')
  }
  router.use('/environments/:id/shares', createSessionMiddleware(opts.secrets))
  router.use('/environments/:id/shares/:shareId', createSessionMiddleware(opts.secrets))

  router.get('/environments/:id/shares', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)
    const environmentId = c.req.param('id')
    const denied = await assertCanReadOr403(c, 'environment', environmentId)
    if (denied) return denied
    return c.json({ ok: true as const, shares: await listEnvironmentShares(db, environmentId) })
  })

  router.post('/environments/:id/shares', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)
    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)
    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult

    const environmentId = c.req.param('id')
    const environmentOrgId = await resolveEntityOrganizationId(db, 'environment', environmentId)
    if (!environmentOrgId || environmentOrgId !== orgResult) {
      return c.json({ error: 'Not found' }, 404)
    }
    const denied = await assertCanOr403(c, 'organization:manage', 'environment', environmentId)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body
    const asset = parseAsset(body)
    if (!asset) return c.json({ error: 'Invalid request' }, 400)

    const refused = await refuseUnusableAsset(c, db, environmentId, orgResult, asset)
    if (refused) return refused

    const id = await insertShare(db, {
      environmentId,
      ...(asset.kind === 'service' ? { serviceId: asset.id } : { storageId: asset.id }),
    })
    return c.json({ ok: true as const, id })
  })

  router.delete('/environments/:id/shares/:shareId', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)
    const environmentId = c.req.param('id')
    const denied = await assertCanOr403(c, 'organization:manage', 'environment', environmentId)
    if (denied) return denied
    const removed = await deleteShare(db, environmentId, c.req.param('shareId'))
    if (!removed) return c.json({ error: 'Not found' }, 404)
    return c.json({ ok: true as const })
  })
}
