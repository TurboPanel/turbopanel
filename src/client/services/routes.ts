import { and, eq, inArray } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403, listVisible } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDb } from '../../db/connection.ts'
import { organization, service } from '../../db/schema.ts'
import {
  parseOrganizationOptions,
  resolveDeployHooksEnabled,
} from '../../features/organizations/organization-options.ts'
import type { ParseServiceOptionsOptions } from '../../features/projects/service-options.ts'
import { preserveServiceApp } from '../../features/environments/app-facts.ts'
import { loadServiceRunStates } from '../../features/environments/service-run-state.ts'
import {
  applyStorageRetentionOnParentDelete,
  listStorageIdsDeletedWith,
} from '../../features/storage/storage-records.ts'
import {
  assertCanCreateOr403,
  assertCanReadOr403,
  assertNotSystemOwnedOr403,
  getOrgId,
  parseJsonBody,
  requireStringField,
} from '../shared.ts'
import { respondAfterHierarchyDelete } from '../hierarchy-delete.ts'
import { FolderPlanError, markAssetFoldersRemoving } from '../../features/folders/allocate.ts'
import { sendFolderRemovalsAfterDelete } from '../../features/folders/removal.ts'
import { parseFolderOptions } from '../../features/folders/options.ts'
import { SCOPE_LOCKED_ERROR, SERVICE_SLUG_LOCKED_ERROR } from '../../features/folders/records.ts'
import { applyServiceFolderSettings } from '../../features/folders/service-settings.ts'
import { inUseBody, listUsesOfAssets } from '../../features/folders/shares.ts'
import {
  parseServiceCreateFields,
  parseServicePatchFields,
  serializeService,
  SERVICE_CREATE_NOT_SUPPORTED,
} from './routes-helpers.ts'

const SERVICE_SELECT = {
  id: service.id,
  name: service.name,
  description: service.description,
  environmentId: service.environmentId,
  composeServiceName: service.composeServiceName,
  slug: service.slug,
  isCommon: service.isCommon,
  metadata: service.metadata,
  options: service.options,
  createdAt: service.createdAt,
  updatedAt: service.updatedAt,
} as const

function buildServicePatchFields(
  c: Context,
  body: Record<string, unknown>,
  parseOptions: ParseServiceOptionsOptions
) {
  const parsed = parseServicePatchFields(body, parseOptions)
  if ('ok' in parsed && parsed.ok === false && 'message' in parsed) {
    return c.json({ error: parsed.error, message: parsed.message }, parsed.status)
  }
  if (!parsed.ok) {
    return c.json({ error: parsed.error }, parsed.status)
  }
  return parsed.patch
}

const FOLDER_SETTING_MESSAGES = {
  service_slug_locked:
    'This service already has a folder on a server, so its folder name can no longer change.',
  scope_locked:
    'Whether this service is shared by every environment is chosen before its first folder exists and cannot change afterwards.',
} as const

/** The 409 for a refused folder setting; a shared service in use lists who uses it. */
async function folderSettingsRefusal(
  c: Context<AppEnv>,
  db: NonNullable<ReturnType<typeof getDb>>,
  serviceId: string,
  error: 'service_slug_locked' | 'scope_locked' | 'common_asset_in_use'
): Promise<Response> {
  if (error === 'common_asset_in_use') {
    return c.json(inUseBody(await listUsesOfAssets(db, { serviceIds: [serviceId] })), 409)
  }
  const code = error === 'scope_locked' ? SCOPE_LOCKED_ERROR : SERVICE_SLUG_LOCKED_ERROR
  return c.json({ error: code, message: FOLDER_SETTING_MESSAGES[error] }, 409)
}

export function registerServiceRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for service routes')
  }
  const secrets = opts.secrets

  router.use('/services', createSessionMiddleware(secrets))
  router.use('/services/:id', createSessionMiddleware(secrets))

  router.get('/services', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const environmentId = c.req.query('environmentId')
    const composeServiceName = c.req.query('composeServiceName')

    const visibleIds = await listVisible(db, {
      kind: 'service',
      userId: session.userId,
      organizationId,
    })

    if (visibleIds.length === 0) {
      return c.json({ services: [] })
    }

    const conditions = [inArray(service.id, visibleIds)]
    if (environmentId) {
      conditions.push(eq(service.environmentId, environmentId))
    }
    if (composeServiceName) {
      conditions.push(eq(service.composeServiceName, composeServiceName))
    }

    const rows = await db
      .select(SERVICE_SELECT)
      .from(service)
      .where(and(...conditions))
      .orderBy(service.createdAt)

    const runStates = await loadServiceRunStates(
      db,
      rows.map((row) => row.id)
    )
    return c.json({
      services: rows.map((row) => serializeService(row, runStates.get(row.id))),
    })
  })

  router.get('/services/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'service', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const rows = await db.select(SERVICE_SELECT).from(service).where(eq(service.id, id)).limit(1)

    const row = rows[0]
    if (!row) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanReadOr403(c, 'service', id)
    if (denied) return denied

    const runStates = await loadServiceRunStates(db, [row.id])
    return c.json({ service: serializeService(row, runStates.get(row.id)) })
  })

  router.post('/services', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const environmentId = requireStringField(c, body, 'environmentId')
    if (environmentId instanceof Response) return environmentId

    const environmentOrgId = await resolveEntityOrganizationId(db, 'environment', environmentId)
    if (!environmentOrgId || environmentOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanCreateOr403(c, 'environment', environmentId)
    if (denied) return denied

    const fields = parseServiceCreateFields(body)
    if (!fields.ok) {
      if ('message' in fields) {
        return c.json({ error: fields.error, message: fields.message }, fields.status)
      }
      return c.json({ error: fields.error }, fields.status)
    }

    // `compose_service_name` is NOT NULL and derived only from the compose
    // document via reconcile — there is no client-suppliable value that can
    // satisfy it here, so this route can never create a valid row.
    return c.json(SERVICE_CREATE_NOT_SUPPORTED, 400)
  })

  router.patch('/services/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'service', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:manage', 'service', id)
    if (denied) return denied

    const immutable = await assertNotSystemOwnedOr403(c, 'service', id)
    if (immutable) return immutable

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    // Hook commands are persisted only when the organization's owner enabled
    // deploy hooks; otherwise the parser drops them before the row is written.
    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1)
    const deployHooks = resolveDeployHooksEnabled(parseOrganizationOptions(orgRow?.options))
    const patchFields = buildServicePatchFields(c, body, { deployHooks })
    if (patchFields instanceof Response) return patchFields

    // `metadata` is replaced wholesale; the daemon-detected `app` fact is not the
    // client's to wipe, so carry it across.
    if (patchFields.metadata) {
      const [existing] = await db
        .select({ metadata: service.metadata })
        .from(service)
        .where(eq(service.id, id))
        .limit(1)
      patchFields.metadata = preserveServiceApp(existing?.metadata, patchFields.metadata)
    }

    const folderOptions = parseFolderOptions(body)
    if (!folderOptions.ok) return c.json({ error: 'Invalid request' }, 400)

    try {
      const refused = await db.transaction(async (tx) => {
        const settings = await applyServiceFolderSettings(tx, {
          serviceId: id,
          organizationId,
          options: folderOptions.options,
        })
        if (!settings.ok) return settings.error
        await tx.update(service).set(patchFields).where(eq(service.id, id))
        return null
      })
      if (refused !== null) return folderSettingsRefusal(c, db, id, refused)
    } catch (err) {
      if (err instanceof FolderPlanError) return c.json(err.body(), err.status)
      throw err
    }

    return c.json({ ok: true as const })
  })

  router.delete('/services/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'service', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:manage', 'service', id)
    if (denied) return denied

    const immutable = await assertNotSystemOwnedOr403(c, 'service', id)
    if (immutable) return immutable

    // A shared service cannot go while another environment uses it.
    const storageIds = await listStorageIdsDeletedWith(db, { serviceIds: [id] })
    const uses = await listUsesOfAssets(db, { serviceIds: [id], storageIds })
    if (uses.length > 0) return c.json(inUseBody(uses), 409)

    const removing: string[] = []
    const response = await respondAfterHierarchyDelete(c, db, async (tx) => {
      // The folder rows stay, locked, until the host confirms the folder is gone.
      const own = await markAssetFoldersRemoving(tx, { serviceIds: [id] })
      const volumes = await applyStorageRetentionOnParentDelete(tx, { serviceIds: [id] })
      removing.push(...own, ...volumes)
      await tx.delete(service).where(eq(service.id, id))
    })
    // Only a delete that went through asks the hosts to remove the files.
    if (response.ok) {
      await sendFolderRemovalsAfterDelete(
        db,
        c.get('commandQueue'),
        c.get('session')?.userId,
        removing
      )
    }
    return response
  })
}
