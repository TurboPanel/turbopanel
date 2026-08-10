import { and, eq, inArray, ne } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import {
  ENVELOPE_MAGIC,
  encryptSecret,
  isSealedEnvelope,
} from '../authn/data-encryption.ts'
import type { DerivedSecretsConfig } from '../authn/secrets.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403, listVisible } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDb } from '../../db.ts'
import {
  assembleTlsMetadata,
  metadataFromParsed,
  mintOrganizationCa,
  mintSelfSignedCertificate,
  parseCertificatePem,
  parseTlsOptions,
  privateKeyMatchesCertificate,
  refreshTlsStatus,
  splitCertificateChain,
  splitTlsMetadata,
  type TlsMetadata,
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
  createFailure,
  isCreateTlsFailure,
  isOrganizationCaUniqueViolation,
  isTlsFingerprintUniqueViolation,
  materialFromLetsEncrypt,
  parseHostnames,
  parseSource,
  type CreateTlsFailure,
  type CreateTlsMaterial,
  type CreateTlsResult,
  withPreferOption,
} from './routes-helpers.ts'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type TlsPublicRow = {
  id: string
  displayName: string | null
  source: string
  organizationId: string
  metadata: TlsMetadata
  options: TlsOptions | null
  certificatePem: string | null
  createdAt: string
  updatedAt: string
}

function toPublicRow(row: {
  id: string
  displayName: string | null
  source: string
  organizationId: string
  status: string
  notAfter: string | null
  fingerprintSha256: string | null
  metadata: unknown
  options: unknown
  certificatePem: string | null
  createdAt: string
  updatedAt: string
}): TlsPublicRow | null {
  const metadata = assembleTlsMetadata(
    {
      status: row.status,
      notAfter: row.notAfter,
      fingerprintSha256: row.fingerprintSha256,
    },
    row.metadata,
  )
  if (!metadata) return null
  return {
    id: row.id,
    displayName: row.displayName,
    source: row.source,
    organizationId: row.organizationId,
    metadata: refreshTlsStatus(metadata),
    options: parseTlsOptions(row.options),
    certificatePem: row.certificatePem,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

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

/** Private keys at rest must be `enc` envelopes — never PEM plaintext. */
function assertTpSecretPrivateKey(sealed: string): void {
  if (
    !isSealedEnvelope(sealed) ||
    !sealed.startsWith(`${ENVELOPE_MAGIC}.`) ||
    sealed.includes('BEGIN')
  ) {
    throw new TypeError('tls private key must be an enc envelope')
  }
}

async function materialFromUpload(
  body: Record<string, unknown>,
  secrets: DerivedSecretsConfig,
): Promise<CreateTlsResult> {
  if (typeof body.certificatePem !== 'string' || typeof body.privateKeyPem !== 'string') {
    return createFailure('Invalid request')
  }
  try {
    // Normalize chain ordering (leaf first).
    const certificatePem = splitCertificateChain(body.certificatePem).join('')
    const parsed = await parseCertificatePem(certificatePem)
    const matches = await privateKeyMatchesCertificate(body.privateKeyPem, parsed)
    if (!matches) {
      return createFailure('certificate_key_mismatch')
    }
    const privateKeyPemSealed = await encryptSecret(
      secrets,
      body.privateKeyPem.trim(),
    )
    assertTpSecretPrivateKey(privateKeyPemSealed)
    return {
      certificatePem,
      privateKeyPemSealed,
      metadata: metadataFromParsed(parsed, 'ready'),
      options: null,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid certificate'
    return createFailure('invalid_certificate', message)
  }
}

async function materialFromSelfSigned(
  body: Record<string, unknown>,
  secrets: DerivedSecretsConfig,
): Promise<CreateTlsResult> {
  const hostnames = parseHostnames(body.hostnames)
  if (!hostnames) {
    return createFailure('Invalid request')
  }
  try {
    const material = await mintSelfSignedCertificate(hostnames)
    const privateKeyPemSealed = await encryptSecret(
      secrets,
      material.privateKeyPem,
    )
    assertTpSecretPrivateKey(privateKeyPemSealed)
    return {
      certificatePem: material.certificatePem,
      privateKeyPemSealed,
      metadata: metadataFromParsed(material.parsed, 'ready'),
      options: { requestedHostnames: hostnames },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'self-signed mint failed'
    return createFailure('invalid_certificate', message)
  }
}

async function materialFromOrganizationCa(
  secrets: DerivedSecretsConfig,
  opts?: { commonName?: string },
): Promise<CreateTlsResult> {
  try {
    const material = await mintOrganizationCa(
      opts?.commonName === undefined ? undefined : { commonName: opts.commonName },
    )
    const privateKeyPemSealed = await encryptSecret(
      secrets,
      material.privateKeyPem,
    )
    assertTpSecretPrivateKey(privateKeyPemSealed)
    return {
      certificatePem: material.certificatePem,
      privateKeyPemSealed,
      metadata: metadataFromParsed(material.parsed, 'ready'),
      options: null,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'organization CA mint failed'
    return createFailure('invalid_certificate', message)
  }
}

async function buildCreateTlsMaterial(
  source: TlsSource,
  body: Record<string, unknown>,
  secrets: DerivedSecretsConfig,
): Promise<CreateTlsResult> {
  switch (source) {
    case 'upload':
      return materialFromUpload(body, secrets)
    case 'self_signed':
      return materialFromSelfSigned(body, secrets)
    case 'lets_encrypt':
      return materialFromLetsEncrypt(body)
    case 'organization_ca':
      return materialFromOrganizationCa(
        secrets,
        typeof body.commonName === 'string' ? { commonName: body.commonName } : undefined,
      )
  }
}

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
  if (material.detail === undefined) {
    return c.json({ error: material.error }, material.status)
  }
  return c.json(
    { error: material.error, detail: material.detail },
    material.status,
  )
}

function organizationCaRowResponse(
  c: Context<AppEnv>,
  row: Parameters<typeof toPublicRow>[0],
): Response {
  const publicRow = toPublicRow(row)
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
    if (
      (typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code: string }).code === 'ORGANIZATION_CA_EXISTS') ||
      isOrganizationCaUniqueViolation(err)
    ) {
      return c.json({ error: 'organization_ca_exists' }, 409)
    }
    if (isTlsFingerprintUniqueViolation(err)) {
      return c.json({ error: 'tls_fingerprint_conflict' }, 409)
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
      .map(toPublicRow)
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
      headers: {
        'Content-Type': 'application/x-pem-file',
        'Content-Disposition': 'attachment; filename="organization-ca.pem"',
      },
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
    const publicRow = toPublicRow(row)
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

    if (body.revoke === true) {
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
    if (!UUID_RE.test(id)) {
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
