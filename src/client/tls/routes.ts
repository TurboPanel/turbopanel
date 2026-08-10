import { and, eq, inArray, ne } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403, listVisible } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDb } from '../../db.ts'
import {
  assembleTlsMetadata,
  parseTlsOptions,
  splitTlsMetadata,
  type TlsOptions,
  type TlsSource,
} from '../../lib/tls/index.ts'
import { tls } from '../../lib/db/schema.ts'
import {
  assertCanCreateOr403,
  assertCanReadOr403,
  getOrgId,
  parseDisplayName,
  parseJsonBody,
} from '../shared.ts'
import {
  hierarchyDeleteHasChildrenResponse,
  runHierarchyDelete,
} from '../hierarchy-delete.ts'
import {
  applyTlsOptionsPatch,
  buildCreateTlsMaterial,
  classifyTlsInsertConflict,
  isCreateTlsFailure,
  isOrganizationCaUniqueViolation,
  isTlsFingerprintUniqueViolation,
  isTlsUuid,
  materialFromOrganizationCa,
  ORGANIZATION_CA_DOWNLOAD_HEADERS,
  parseSource,
  shouldRevokeTlsFromBody,
  tlsFailurePayload,
  toPublicTlsRow,
  type CreateTlsFailure,
  type CreateTlsMaterial,
  type TlsPublicRow,
  withPreferOption,
} from './routes-helpers.ts'

const TLS_PUBLIC_SELECT = {
  id: tls.id,
  displayName: tls.name,
  source: tls.source,
  organizationId: tls.organizationId,
  status: tls.status,
  notAfter: tls.notAfter,
  fingerprintSha256: tls.fingerprintSha256,
  metadata: tls.metadata,
  options: tls.options,
  certificatePem: tls.certificatePem,
  createdAt: tls.createdAt,
  updatedAt: tls.updatedAt,
} as const

async function findActiveOrganizationCa(
  db: NonNullable<ReturnType<typeof getDb>>,
  organizationId: string,
) {
  const [row] = await db
    .select(TLS_PUBLIC_SELECT)
    .from(tls)
    .where(
      and(
        eq(tls.organizationId, organizationId),
        eq(tls.source, 'organization_ca'),
        ne(tls.status, 'revoked'),
      ),
    )
    .limit(1)
  return row ?? null
}

function createTlsFailureResponse(
  c: Context<AppEnv>,
  material: CreateTlsFailure,
): Response {
  const payload = tlsFailurePayload(material)
  return c.json(payload.body, payload.status)
}

function organizationCaRowResponse(
  c: Context<AppEnv>,
  row: Parameters<typeof toPublicTlsRow>[0],
): Response {
  const publicRow = toPublicTlsRow(row)
  if (!publicRow) return c.json({ error: 'Invalid request' }, 500)
  return c.json({ tls: publicRow })
}

/**
 * Ensure-or-create the organization CA row inside a transaction, racing
 * against a concurrent ensure. Returns the row id, or a `Response` when a
 * concurrent create already won (existing row reused / unique violation).
 */
async function ensureOrganizationCaId(
  c: Context<AppEnv>,
  db: NonNullable<ReturnType<typeof getDb>>,
  organizationId: string,
  material: CreateTlsMaterial,
): Promise<string | Response> {
  const { columns, residual } = splitTlsMetadata(material.metadata)
  try {
    return await db.transaction(async (tx) => {
      // Race: another concurrent ensure may have inserted first.
      const [race] = await tx
        .select(TLS_PUBLIC_SELECT)
        .from(tls)
        .where(
          and(
            eq(tls.organizationId, organizationId),
            eq(tls.source, 'organization_ca'),
            ne(tls.status, 'revoked'),
          ),
        )
        .limit(1)
      if (race) return race.id

      const [inserted] = await tx
        .insert(tls)
        .values({
          organizationId,
          name: 'Organization CA',
          source: 'organization_ca',
          certificatePem: material.certificatePem,
          privateKeyPem: material.privateKeyPemSealed,
          status: columns.status,
          notAfter: columns.notAfter,
          fingerprintSha256: columns.fingerprintSha256,
          metadata: residual,
          options: null,
        })
        .returning({ id: tls.id })
      return inserted.id
    })
  } catch (err) {
    if (isOrganizationCaUniqueViolation(err) || isTlsFingerprintUniqueViolation(err)) {
      const raced = await findActiveOrganizationCa(db, organizationId)
      if (raced) return organizationCaRowResponse(c, raced)
      return c.json({ error: 'organization_ca_exists' }, 409)
    }
    throw err
  }
}

async function insertTlsRow(
  c: Context<AppEnv>,
  db: NonNullable<ReturnType<typeof getDb>>,
  params: {
    organizationId: string
    displayName: string | null
    source: TlsSource
    material: CreateTlsMaterial
    options: TlsOptions | null
  },
): Promise<string | Response> {
  const { columns, residual } = splitTlsMetadata(params.material.metadata)
  try {
    return await db.transaction(async (tx) => {
      if (params.source === 'organization_ca') {
        const [race] = await tx
          .select({ id: tls.id })
          .from(tls)
          .where(
            and(
              eq(tls.organizationId, params.organizationId),
              eq(tls.source, 'organization_ca'),
              ne(tls.status, 'revoked'),
            ),
          )
          .limit(1)
        if (race) {
          throw Object.assign(new Error('organization_ca_exists'), {
            code: 'ORGANIZATION_CA_EXISTS',
          })
        }
      }
      const [inserted] = await tx
        .insert(tls)
        .values({
          organizationId: params.organizationId,
          name: params.displayName,
          source: params.source,
          certificatePem: params.material.certificatePem,
          privateKeyPem: params.material.privateKeyPemSealed,
          status: columns.status,
          notAfter: columns.notAfter,
          fingerprintSha256: columns.fingerprintSha256,
          metadata: residual,
          options: params.options,
        })
        .returning({ id: tls.id })
      return inserted.id
    })
  } catch (err) {
    const conflict = classifyTlsInsertConflict(err)
    if (conflict) {
      return c.json({ error: conflict.error }, conflict.status)
    }
    throw err
  }
}

export function registerTlsRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for tls routes')
  }
  const secrets = opts.secrets

  router.use('/tls', createSessionMiddleware(secrets))
  router.use('/tls/*', createSessionMiddleware(secrets))
  router.use('/tls/:id', createSessionMiddleware(secrets))

  router.get('/tls', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const visibleIds = await listVisible(db, {
      kind: 'tls',
      userId: session.userId,
      organizationId,
    })

    if (visibleIds.length === 0) {
      return c.json({ tls: [] })
    }

    const rows = await db
      .select(TLS_PUBLIC_SELECT)
      .from(tls)
      .where(
        and(inArray(tls.id, visibleIds), eq(tls.organizationId, organizationId)),
      )
      .orderBy(tls.createdAt)

    const publicRows = rows
      .map(toPublicTlsRow)
      .filter((row): row is TlsPublicRow => row !== null)

    return c.json({ tls: publicRows })
  })

  /**
   * Ensure-or-create the organization CA (at most one active row per org).
   * Managed provisioning later reuses this path without a dedicated wizard.
   */
  router.get('/tls/ca', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const existing = await findActiveOrganizationCa(db, organizationId)
    if (existing) {
      const denied = await assertCanReadOr403(c, 'tls', existing.id)
      if (denied) return denied
      return organizationCaRowResponse(c, existing)
    }

    const deniedCreate = await assertCanCreateOr403(c, 'organization', organizationId)
    if (deniedCreate) return deniedCreate

    const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
    if (!dataEncryptionSecrets) {
      return c.json({ error: 'Encryption unavailable — no encryption key configured' }, 503)
    }

    const material = await materialFromOrganizationCa(dataEncryptionSecrets)
    if (isCreateTlsFailure(material)) {
      return createTlsFailureResponse(c, material)
    }

    const idOrResponse = await ensureOrganizationCaId(
      c,
      db,
      organizationId,
      material,
    )
    if (idOrResponse instanceof Response) return idOrResponse

    const [row] = await db
      .select(TLS_PUBLIC_SELECT)
      .from(tls)
      .where(eq(tls.id, idOrResponse))
      .limit(1)
    if (!row) return c.json({ error: 'Not found' }, 404)
    return organizationCaRowResponse(c, row)
  })

  router.post('/tls/ca/rotate', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const denied = await assertCanOr403(
      c,
      'organization:manage',
      'organization',
      organizationId,
    )
    if (denied) return denied

    const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
    if (!dataEncryptionSecrets) {
      return c.json({ error: 'Encryption unavailable — no encryption key configured' }, 503)
    }

    const material = await materialFromOrganizationCa(dataEncryptionSecrets)
    if (isCreateTlsFailure(material)) {
      return createTlsFailureResponse(c, material)
    }

    const { columns, residual } = splitTlsMetadata(material.metadata)
    const now = new Date().toISOString()
    let id: string
    try {
      id = await db.transaction(async (tx) => {
        await tx
          .update(tls)
          .set({ status: 'revoked', updatedAt: now })
          .where(
            and(
              eq(tls.organizationId, organizationId),
              eq(tls.source, 'organization_ca'),
              ne(tls.status, 'revoked'),
            ),
          )

        const [inserted] = await tx
          .insert(tls)
          .values({
            organizationId,
            name: 'Organization CA',
            source: 'organization_ca',
            certificatePem: material.certificatePem,
            privateKeyPem: material.privateKeyPemSealed,
            status: columns.status,
            notAfter: columns.notAfter,
            fingerprintSha256: columns.fingerprintSha256,
            metadata: residual,
            options: null,
          })
          .returning({ id: tls.id })
        return inserted.id
      })
    } catch (err) {
      if (isTlsFingerprintUniqueViolation(err)) {
        return c.json({ error: 'tls_fingerprint_conflict' }, 409)
      }
      throw err
    }

    return c.json({ ok: true as const, id })
  })

  router.get('/tls/ca/download', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const row = await findActiveOrganizationCa(db, organizationId)
    if (!row?.certificatePem) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanReadOr403(c, 'tls', row.id)
    if (denied) return denied

    return new Response(row.certificatePem, {
      status: 200,
      headers: { ...ORGANIZATION_CA_DOWNLOAD_HEADERS },
    })
  })

  router.get('/tls/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'tls', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanReadOr403(c, 'tls', id)
    if (denied) return denied

    const [row] = await db
      .select(TLS_PUBLIC_SELECT)
      .from(tls)
      .where(eq(tls.id, id))
      .limit(1)

    if (!row) return c.json({ error: 'Not found' }, 404)
    const publicRow = toPublicTlsRow(row)
    if (!publicRow) return c.json({ error: 'Invalid request' }, 500)

    return c.json({ tls: publicRow })
  })

  router.post('/tls', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const denied = await assertCanCreateOr403(c, 'organization', organizationId)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const source = parseSource(body.source)
    if (!source) {
      return c.json({ error: 'Invalid request' }, 400)
    }

    if (source === 'organization_ca') {
      const existing = await findActiveOrganizationCa(db, organizationId)
      if (existing) {
        return c.json({ error: 'organization_ca_exists' }, 409)
      }
    }

    let displayName: string | null
    try {
      displayName = parseDisplayName(body)
    } catch {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
    if (!dataEncryptionSecrets) {
      return c.json({ error: 'Encryption unavailable — no encryption key configured' }, 503)
    }

    const material = await buildCreateTlsMaterial(
      source,
      body,
      dataEncryptionSecrets,
    )
    if (isCreateTlsFailure(material)) {
      return createTlsFailureResponse(c, material)
    }

    const options = withPreferOption(material.options, body.prefer)

    const idOrResponse = await insertTlsRow(c, db, {
      organizationId,
      displayName,
      source,
      material,
      options,
    })
    if (idOrResponse instanceof Response) return idOrResponse

    return c.json({ ok: true as const, id: idOrResponse })
  })

  router.patch('/tls/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'tls', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:manage', 'tls', id)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const [existing] = await db
      .select({
        options: tls.options,
        status: tls.status,
        notAfter: tls.notAfter,
        fingerprintSha256: tls.fingerprintSha256,
        metadata: tls.metadata,
      })
      .from(tls)
      .where(eq(tls.id, id))
      .limit(1)
    if (!existing) return c.json({ error: 'Not found' }, 404)

    const patch: {
      displayName?: string | null
      options?: TlsOptions | null
      status?: string
      updatedAt: string
    } = { updatedAt: new Date().toISOString() }

    if (body.displayName !== undefined) {
      try {
        patch.displayName = parseDisplayName(body)
      } catch {
        return c.json({ error: 'Invalid request' }, 400)
      }
    }

    const optionsPatch = applyTlsOptionsPatch(
      parseTlsOptions(existing.options) ?? {},
      body,
    )
    if (!optionsPatch.ok) {
      return c.json({ error: 'Invalid request' }, 400)
    }
    if (optionsPatch.changed) {
      patch.options = optionsPatch.options
    }

    if (shouldRevokeTlsFromBody(body)) {
      const metadata = assembleTlsMetadata(
        {
          status: existing.status,
          notAfter: existing.notAfter,
          fingerprintSha256: existing.fingerprintSha256,
        },
        existing.metadata,
      )
      if (!metadata) return c.json({ error: 'Invalid request' }, 500)
      patch.status = 'revoked'
    }

    await db.update(tls).set(patch).where(eq(tls.id, id))
    return c.json({ ok: true as const })
  })

  router.delete('/tls/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    if (!isTlsUuid(id)) {
      return c.json({ error: 'Not found' }, 404)
    }

    const entityOrgId = await resolveEntityOrganizationId(db, 'tls', id)
    if (!entityOrgId || entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:manage', 'tls', id)
    if (denied) return denied

    const result = await runHierarchyDelete(db, async (tx) => {
      await tx.delete(tls).where(eq(tls.id, id))
    })
    if (result === 'has_children') {
      return hierarchyDeleteHasChildrenResponse(c)
    }

    return c.json({ ok: true as const })
  })
}
