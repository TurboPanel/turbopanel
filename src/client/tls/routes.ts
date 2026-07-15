import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import {
  ENVELOPE_MAGIC,
  encryptSecret,
  isSealedEnvelope,
} from '../authn/data-encryption.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403, listVisible } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDb } from '../../db.ts'
import {
  metadataFromParsed,
  mintSelfSignedCertificate,
  parseCertificatePem,
  parseTlsMetadata,
  parseTlsOptions,
  privateKeyMatchesCertificate,
  refreshTlsStatus,
  splitCertificateChain,
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

function toPublicRow(row: {
  id: string
  displayName: string | null
  source: string
  organizationId: string
  metadata: unknown
  options: unknown
  certificatePem: string | null
  createdAt: string
  updatedAt: string
}): TlsPublicRow | null {
  const metadata = parseTlsMetadata(row.metadata)
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

/** Private keys at rest must be `tpsecret` envelopes — never PEM plaintext. */
function assertTpSecretPrivateKey(sealed: string): void {
  if (
    !isSealedEnvelope(sealed) ||
    !sealed.startsWith(`${ENVELOPE_MAGIC}.`) ||
    sealed.includes('BEGIN')
  ) {
    throw new TypeError('tls private key must be a tpsecret envelope')
  }
}

export function registerTlsRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  router.use('/tls', createSessionMiddleware(opts.secrets))
  router.use('/tls/:id', createSessionMiddleware(opts.secrets))

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
      .select({
        id: tls.id,
        displayName: tls.displayName,
        source: tls.source,
        organizationId: tls.organizationId,
        metadata: tls.metadata,
        options: tls.options,
        certificatePem: tls.certificatePem,
        createdAt: tls.createdAt,
        updatedAt: tls.updatedAt,
      })
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
      .select({
        id: tls.id,
        displayName: tls.displayName,
        source: tls.source,
        organizationId: tls.organizationId,
        metadata: tls.metadata,
        options: tls.options,
        certificatePem: tls.certificatePem,
        createdAt: tls.createdAt,
        updatedAt: tls.updatedAt,
      })
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

    let certificatePem: string | null = null
    let privateKeyPemSealed: string | null = null
    let metadata: TlsMetadata
    let options: TlsOptions | null = null

    if (source === 'upload') {
      if (typeof body.certificatePem !== 'string' || typeof body.privateKeyPem !== 'string') {
        return c.json({ error: 'Invalid request' }, 400)
      }
      try {
        // Normalize chain ordering (leaf first).
        certificatePem = splitCertificateChain(body.certificatePem).join('')
        const parsed = await parseCertificatePem(certificatePem)
        const matches = await privateKeyMatchesCertificate(body.privateKeyPem, parsed)
        if (!matches) {
          return c.json({ error: 'certificate_key_mismatch' }, 400)
        }
        privateKeyPemSealed = await encryptSecret(
          dataEncryptionSecrets,
          body.privateKeyPem.trim(),
        )
        assertTpSecretPrivateKey(privateKeyPemSealed)
        metadata = metadataFromParsed(parsed, 'ready')
      } catch (err) {
        const message = err instanceof Error ? err.message : 'invalid certificate'
        return c.json({ error: 'invalid_certificate', detail: message }, 400)
      }
    } else if (source === 'self_signed') {
      const hostnames = parseHostnames(body.hostnames)
      if (!hostnames) {
        return c.json({ error: 'Invalid request' }, 400)
      }
      try {
        const material = await mintSelfSignedCertificate(hostnames)
        certificatePem = material.certificatePem
        privateKeyPemSealed = await encryptSecret(
          dataEncryptionSecrets,
          material.privateKeyPem,
        )
        assertTpSecretPrivateKey(privateKeyPemSealed)
        metadata = metadataFromParsed(material.parsed, 'ready')
        options = { requestedHostnames: hostnames }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'self-signed mint failed'
        return c.json({ error: 'invalid_certificate', detail: message }, 400)
      }
    } else {
      // lets_encrypt seam — pending until ACME worker fills PEMs
      const hostnames = parseHostnames(body.hostnames)
      if (!hostnames) {
        return c.json({ error: 'Invalid request' }, 400)
      }
      metadata = {
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
      }
      options = {
        autoRenew: body.autoRenew !== false,
        requestedHostnames: hostnames,
      }
    }

    if (
      typeof body.prefer === 'number' &&
      Number.isFinite(body.prefer)
    ) {
      options = { ...(options ?? {}), prefer: body.prefer }
    }

    const id = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(tls)
        .values({
          organizationId,
          displayName,
          source,
          certificatePem,
          privateKeyPem: privateKeyPemSealed,
          metadata,
          options,
        })
        .returning({ id: tls.id })
      return inserted.id
    })

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
        metadata: tls.metadata,
      })
      .from(tls)
      .where(eq(tls.id, id))
      .limit(1)
    if (!existing) return c.json({ error: 'Not found' }, 404)

    const patch: {
      displayName?: string | null
      options?: TlsOptions | null
      metadata?: TlsMetadata
      updatedAt: string
    } = { updatedAt: new Date().toISOString() }

    if (body.displayName !== undefined) {
      try {
        patch.displayName = parseDisplayName(body)
      } catch {
        return c.json({ error: 'Invalid request' }, 400)
      }
    }

    const currentOptions = parseTlsOptions(existing.options) ?? {}
    let optionsChanged = false
    const nextOptions: TlsOptions = { ...currentOptions }

    if (body.prefer !== undefined) {
      if (body.prefer === null) {
        delete nextOptions.prefer
        optionsChanged = true
      } else if (typeof body.prefer === 'number' && Number.isFinite(body.prefer)) {
        nextOptions.prefer = body.prefer
        optionsChanged = true
      } else {
        return c.json({ error: 'Invalid request' }, 400)
      }
    }

    if (body.autoRenew !== undefined) {
      if (typeof body.autoRenew !== 'boolean') {
        return c.json({ error: 'Invalid request' }, 400)
      }
      nextOptions.autoRenew = body.autoRenew
      optionsChanged = true
    }

    if (optionsChanged) {
      patch.options = nextOptions
    }

    if (body.revoke === true) {
      const metadata = parseTlsMetadata(existing.metadata)
      if (!metadata) return c.json({ error: 'Invalid request' }, 500)
      patch.metadata = { ...metadata, status: 'revoked' }
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

    const denied = await assertCanOr403(c, 'organization:own', 'tls', id)
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
