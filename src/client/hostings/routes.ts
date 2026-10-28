import { and, eq, inArray } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { nudgeTunnelRoutesFromRequest } from '../organizations/tunnel-nudge.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403, listVisible } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import type { Db } from '../../db/connection.ts'
import { environment, hosting, service } from '../../db/schema.ts'
import {
  lockCertificatesPinnedBy,
  removeUnusedSiteCertificates,
} from '../../features/tls/unused-letsencrypt.ts'
import {
  isHostnameUniqueViolation,
  replaceHostingHostnames,
} from '../../features/servers/hostname-records.ts'
import {
  assertCanCreateOr403,
  assertCanReadOr403,
  assertNotSystemOwnedOr403,
  parseDescription,
  parseJsonbObject,
  parseJsonBody,
  parseName,
  requireDbSessionAndOrg,
  stripPromotedMetadataKeys,
} from '../shared.ts'
import { hierarchyDeleteHasChildrenResponse, runHierarchyDelete } from '../hierarchy-delete.ts'
import {
  assertCreateHostingBindScope,
  assertHostingNotComposeOwnedOr409,
  assertMergedHostingBindScope,
  buildHostingPatchFields,
  HOSTING_PROMOTED_METADATA_KEYS,
  parseCreateServiceId,
  parseOptionalHostingOptions,
  resolveOptionalHostingFks,
  type HostingFkResult,
  type HostingPatchFields,
} from './routes-helpers.ts'

/** The columns a hosting is read with, in the list and in the detail. */
const HOSTING_COLUMNS = {
  id: hosting.id,
  name: hosting.name,
  description: hosting.description,
  serviceId: hosting.serviceId,
  tlsId: hosting.tlsId,
  ipId: hosting.ipId,
  metadata: hosting.metadata,
  options: hosting.options,
  createdAt: hosting.createdAt,
  updatedAt: hosting.updatedAt,
}

/**
 * Why this hosting cannot be changed or deleted by this request, or null: it
 * belongs to another organization (404), the caller cannot manage it (403),
 * it is system-owned (403), or compose owns it (409).
 */
async function refuseHostingChange(
  c: Context<AppEnv>,
  db: Db,
  id: string,
  organizationId: string
): Promise<Response | null> {
  const entityOrgId = await resolveEntityOrganizationId(db, 'hosting', id)
  if (entityOrgId !== organizationId) {
    return c.json({ error: 'Not found' }, 404)
  }
  const denied = await assertCanOr403(c, 'organization:manage', 'hosting', id)
  if (denied) return denied
  const immutable = await assertNotSystemOwnedOr403(c, 'hosting', id)
  if (immutable) return immutable
  return await assertHostingNotComposeOwnedOr409(c, db, id)
}

function hostnamesPatchFromFields(patchFields: HostingPatchFields): string[] | null {
  // `patchFields.options` is only set when the request body included
  // `options` (see `buildHostingPatchFields`) — that is the only signal
  // hostnames changed, since `options` replaces the whole jsonb object.
  if (patchFields.options === undefined) return null
  return (patchFields.options as { hostnames?: string[] }).hostnames ?? []
}

async function commitHostingPatch(
  c: Context<AppEnv>,
  db: Db,
  id: string,
  organizationId: string,
  patchFields: HostingPatchFields,
  hostnamesPatch: string[] | null
): Promise<Response | null> {
  try {
    await db.transaction(async (tx) => {
      await tx.update(hosting).set(patchFields).where(eq(hosting.id, id))
      if (hostnamesPatch !== null) {
        // `organizationId` was already checked equal to this hosting's
        // resolved workspace-ancestry organization above.
        await replaceHostingHostnames(tx, id, organizationId, hostnamesPatch)
      }
    })
  } catch (err) {
    if (isHostnameUniqueViolation(err)) {
      return c.json({ error: 'hostname_in_use' }, 409)
    }
    throw err
  }
  return null
}

function parseHostingCreatePayload(c: Context<AppEnv>, body: Record<string, unknown>) {
  let name: string | null
  let description: string | null
  try {
    name = parseName(body)
    description = parseDescription(body)
  } catch {
    return c.json({ error: 'Invalid request' }, 400)
  }

  const metadataRaw = parseJsonbObject(c, body, 'metadata')
  if (metadataRaw instanceof Response) return metadataRaw
  const metadataResult =
    metadataRaw === null
      ? null
      : stripPromotedMetadataKeys(metadataRaw, HOSTING_PROMOTED_METADATA_KEYS)

  const optionsResult = parseOptionalHostingOptions(c, body)
  if (optionsResult.kind === 'error') return optionsResult.response
  return {
    name,
    description,
    metadataResult,
    validatedOptions: optionsResult.kind === 'value' ? optionsResult.value : null,
  }
}

type HostingCreateFields = Exclude<ReturnType<typeof parseHostingCreatePayload>, Response>

async function insertHostingFromCreate(
  db: Db,
  fields: HostingCreateFields,
  serviceId: string,
  organizationId: string,
  fks: Extract<HostingFkResult, { kind: 'ok' }>
): Promise<string> {
  const { name, description, metadataResult, validatedOptions } = fields
  return await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(hosting)
      .values({
        name,
        description,
        serviceId,
        ...(fks.tlsId.kind === 'value' ? { tlsId: fks.tlsId.value } : {}),
        ...(fks.ipId.kind === 'value' ? { ipId: fks.ipId.value } : {}),
        ...(metadataResult !== null ? { metadata: metadataResult } : {}),
        ...(validatedOptions !== null ? { options: validatedOptions } : {}),
        ...(validatedOptions?.protocol !== undefined
          ? { protocol: validatedOptions.protocol }
          : {}),
      })
      .returning({ id: hosting.id })
    // `organizationId` is the workspace-ancestry answer already: `serviceOrgId`
    // above resolved it via the service's `service → environment → project →
    // workspace → organization` chain and was checked equal to it.
    await replaceHostingHostnames(
      tx,
      inserted.id,
      organizationId,
      validatedOptions?.hostnames ?? []
    )
    return inserted.id
  })
}

export function registerHostingRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for hosting routes')
  }
  const secrets = opts.secrets

  router.use('/hostings', createSessionMiddleware(secrets))
  router.use('/hostings/:id', createSessionMiddleware(secrets))

  router.get('/hostings', async (c) => {
    const sessionOrg = await requireDbSessionAndOrg(c)
    if (sessionOrg instanceof Response) return sessionOrg
    const { db, session, organizationId } = sessionOrg

    const serviceId = c.req.query('serviceId')

    const visibleIds = await listVisible(db, {
      kind: 'hosting',
      userId: session.userId,
      organizationId,
    })

    if (visibleIds.length === 0) {
      return c.json({ hostings: [] })
    }

    const conditions = [inArray(hosting.id, visibleIds)]
    if (serviceId) {
      conditions.push(eq(hosting.serviceId, serviceId))
    }

    const rows = await db
      .select(HOSTING_COLUMNS)
      .from(hosting)
      .where(and(...conditions))
      .orderBy(hosting.createdAt)

    return c.json({ hostings: rows })
  })

  router.get('/hostings/:id', async (c) => {
    const sessionOrg = await requireDbSessionAndOrg(c)
    if (sessionOrg instanceof Response) return sessionOrg
    const { db, organizationId } = sessionOrg

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'hosting', id)
    if (entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const rows = await db.select(HOSTING_COLUMNS).from(hosting).where(eq(hosting.id, id)).limit(1)

    const row = rows[0]
    if (!row) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanReadOr403(c, 'hosting', id)
    if (denied) return denied

    return c.json({ hosting: row })
  })

  router.post('/hostings', async (c) => {
    const sessionOrg = await requireDbSessionAndOrg(c)
    if (sessionOrg instanceof Response) return sessionOrg
    const { db, organizationId } = sessionOrg

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const serviceId = parseCreateServiceId(body)
    if (!serviceId) {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const serviceOrgId = await resolveEntityOrganizationId(db, 'service', serviceId)
    if (serviceOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanCreateOr403(c, 'service', serviceId)
    if (denied) return denied

    const immutable = await assertNotSystemOwnedOr403(c, 'service', serviceId)
    if (immutable) return immutable

    const fields = parseHostingCreatePayload(c, body)
    if (fields instanceof Response) return fields
    const { validatedOptions } = fields

    const fks = await resolveOptionalHostingFks(c, db, organizationId, body)
    if (fks.kind === 'error') return fks.response

    const scopeDenied = await assertCreateHostingBindScope(c, db, fks.ipId, validatedOptions)
    if (scopeDenied) return scopeDenied

    try {
      const id = await insertHostingFromCreate(db, fields, serviceId, organizationId, fks)
      await nudgeTunnelRoutesFromRequest(c, db, organizationId)
      return c.json({ ok: true as const, id })
    } catch (err) {
      if (isHostnameUniqueViolation(err)) {
        return c.json({ error: 'hostname_in_use' }, 409)
      }
      throw err
    }
  })

  router.patch('/hostings/:id', async (c) => {
    const sessionOrg = await requireDbSessionAndOrg(c)
    if (sessionOrg instanceof Response) return sessionOrg
    const { db, organizationId } = sessionOrg

    const id = c.req.param('id')
    const refused = await refuseHostingChange(c, db, id, organizationId)
    if (refused) return refused

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const [existingHosting] = await db
      .select({ ipId: hosting.ipId, options: hosting.options })
      .from(hosting)
      .where(eq(hosting.id, id))
      .limit(1)
    if (!existingHosting) return c.json({ error: 'Not found' }, 404)

    const patchFields = await buildHostingPatchFields(c, db, organizationId, body)
    if (patchFields instanceof Response) return patchFields

    const scopeDenied = await assertMergedHostingBindScope(c, db, existingHosting, patchFields)
    if (scopeDenied) return scopeDenied

    const conflict = await commitHostingPatch(
      c,
      db,
      id,
      organizationId,
      patchFields,
      hostnamesPatchFromFields(patchFields)
    )
    if (conflict) return conflict

    await nudgeTunnelRoutesFromRequest(c, db, organizationId)
    return c.json({ ok: true as const })
  })

  router.delete('/hostings/:id', async (c) => {
    const sessionOrg = await requireDbSessionAndOrg(c)
    if (sessionOrg instanceof Response) return sessionOrg
    const { db, session, organizationId } = sessionOrg

    const id = c.req.param('id')
    const refused = await refuseHostingChange(c, db, id, organizationId)
    if (refused) return refused

    const result = await runHierarchyDelete(db, async (tx) => {
      // The environment row, then the Let's Encrypt lock, then the site: the
      // order a deploy takes them in.
      await lockHostingEnvironment(tx, id)
      const certificateIds = await lockCertificatesPinnedBy(tx, [id])
      await tx.delete(hosting).where(eq(hosting.id, id))
      await removeUnusedSiteCertificates(tx, certificateIds, {
        reason: 'its site was deleted',
        actor: { userId: session.userId, email: session.email ?? null },
      })
    })
    if (result === 'has_children') {
      return hierarchyDeleteHasChildrenResponse(c)
    }

    await nudgeTunnelRoutesFromRequest(c, db, organizationId)
    return c.json({ ok: true as const })
  })
}

/** Lock the environment row a hosting belongs to (a deploy holds it while it changes sites). */
async function lockHostingEnvironment(tx: Db, hostingId: string): Promise<void> {
  await tx
    .select({ id: environment.id })
    .from(environment)
    .innerJoin(service, eq(service.environmentId, environment.id))
    .innerJoin(hosting, eq(hosting.serviceId, service.id))
    .where(eq(hosting.id, hostingId))
    .for('update', { of: environment })
}
