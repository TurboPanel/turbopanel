import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
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
  mintSelfSignedCertificate,
  parseCertificatePem,
  parseTlsOptions,
  privateKeyMatchesCertificate,
  refreshTlsStatus,
  splitCertificateChain,
  splitTlsMetadata,
  TLS_SOURCES,
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

type CreateTlsMaterial = {
  certificatePem: string | null
  privateKeyPemSealed: string | null
  metadata: TlsMetadata
  options: TlsOptions | null
}

type CreateTlsFailure = {
  error: string
  detail?: string
  status: 400
}

type CreateTlsResult = CreateTlsMaterial | CreateTlsFailure

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
  displayName: tls.displayName,
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

function parseSource(value: unknown): TlsSource | null {
  if (typeof value !== 'string') return null
  return (TLS_SOURCES as readonly string[]).includes(value)
    ? (value as TlsSource)
    : null
}

function parseHostnames(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const names = value
    .filter((n): n is string => typeof n === 'string')
    .map((n) => n.trim().toLowerCase())
    .filter((n) => n.length > 0)
  return names.length > 0 ? names : null
}

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

function isCreateTlsFailure(result: CreateTlsResult): result is CreateTlsFailure {
  return 'status' in result
}

function isPostgresUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null &&
    'code' in err && (err as { code: string }).code === '23505'
}

function isTlsFingerprintUniqueViolation(err: unknown): boolean {
  if (!isPostgresUniqueViolation(err)) return false
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('uniq_tls_organization_fingerprint_sha256')
}

function createFailure(error: string, detail?: string): CreateTlsFailure {
  if (detail === undefined) {
    return { error, status: 400 }
  }
  return { error, detail, status: 400 }
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

function materialFromLetsEncrypt(body: Record<string, unknown>): CreateTlsResult {
  const hostnames = parseHostnames(body.hostnames)
  if (!hostnames) {
    return createFailure('Invalid request')
  }
  return {
    certificatePem: null,
    privateKeyPemSealed: null,
    metadata: {
      dnsNames: hostnames,
      hasWildcard: hostnames.some((n) => n.startsWith('*.')),
      notBefore: new Date(0).toISOString(),
      notAfter: new Date(0).toISOString(),
      fingerprintSha256: '',
      subject: '',
      issuer: '',
      status: 'pending',
      acme: {
        challengeType:
          body.challengeType === 'dns-01' ? 'dns-01' : 'http-01',
      },
    },
    options: {
      autoRenew: body.autoRenew !== false,
      requestedHostnames: hostnames,
    },
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
  }
}

function withPreferOption(
  options: TlsOptions | null,
  prefer: unknown,
): TlsOptions | null {
  if (typeof prefer !== 'number' || !Number.isFinite(prefer)) {
    return options
  }
  if (options) {
    return { ...options, prefer }
  }
  return { prefer }
}

type OptionsPatchResult =
  | { ok: true; options: TlsOptions; changed: boolean }
  | { ok: false }

function applyTlsOptionsPatch(
  currentOptions: TlsOptions,
  body: Record<string, unknown>,
): OptionsPatchResult {
  const nextOptions: TlsOptions = { ...currentOptions }
  let changed = false

  if (body.prefer !== undefined) {
    if (body.prefer === null) {
      delete nextOptions.prefer
      changed = true
    } else if (typeof body.prefer === 'number' && Number.isFinite(body.prefer)) {
      nextOptions.prefer = body.prefer
      changed = true
    } else {
      return { ok: false }
    }
  }

  if (body.autoRenew !== undefined) {
    if (typeof body.autoRenew !== 'boolean') {
      return { ok: false }
    }
    nextOptions.autoRenew = body.autoRenew
    changed = true
  }

  return { ok: true, options: nextOptions, changed }
}

export function registerTlsRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for tls routes')
  }
  const secrets = opts.secrets

  router.use('/tls', createSessionMiddleware(secrets))
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
      if (material.detail === undefined) {
        return c.json({ error: material.error }, material.status)
      }
      return c.json(
        { error: material.error, detail: material.detail },
        material.status,
      )
    }

    const options = withPreferOption(material.options, body.prefer)

    const { columns, residual } = splitTlsMetadata(material.metadata)
    let id: string
    try {
      id = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(tls)
          .values({
            organizationId,
            displayName,
            source,
            certificatePem: material.certificatePem,
            privateKeyPem: material.privateKeyPemSealed,
            status: columns.status,
            notAfter: columns.notAfter,
            fingerprintSha256: columns.fingerprintSha256,
            metadata: residual,
            options,
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
