/**
 * Certificates ordered through a DNS proof: one name, several names, or a
 * wildcard (`*.example.com`). An order is a certificate row that waits for a
 * server that serves the organization to place it; the control plane never talks
 * to the certificate authority itself. The server asks the panel only to publish
 * and remove the challenge records, with the organization's DNS token, which
 * never leaves the panel. The list shows these rows and the earlier panel-ordered
 * ones. Owners and managers only.
 */
import { and, eq, or, sql } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { tls } from '../../db/schema.ts'
import { parseCertificateNames } from '../../features/tls/dns-certificates/names.ts'
import { HTTP_CERT_KEY } from '../../features/tls/http-issuance/state.ts'
import { splitTlsMetadata } from '../../lib/tls/index.ts'
import { isPanelManagedAcme } from '../../features/tls/dns-certificates/order-state.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { materialFromLetsEncrypt } from '../tls/routes-helpers.ts'
import { isUuid } from '../access/routes-helpers.ts'
import { loadScope, type Scope } from './carrier-routes.ts'

/** What an issued certificate in use says while no other warning is due. */
export const NO_RENEWAL_MESSAGE =
  'This certificate will not renew from the control plane. It keeps working until it expires.'

const PATHS = [
  '/organizations/:id/dns-certificates',
  '/organizations/:id/dns-certificates/:tlsId/check',
  '/organizations/:id/dns-certificates/:tlsId/retry',
] as const

type Row = typeof tls.$inferSelect

type Acme = {
  stage?: string
  staging?: boolean
  lastError?: string
  warning?: string
  attempts?: number
  nextAttemptAt?: string
  renewAt?: string
}

export type ApiDnsCertificate = {
  id: string
  names: string[]
  wildcard: boolean
  /** `pending` while ordering, `ready`, `failed` after three failed orders, `expired`. */
  status: string
  /** Where an order stands: queued, presented, validating, finalizing, issued, backoff, failed. */
  stage: string
  /** The authority's test directory: no browser trusts these certificates. */
  staging: boolean
  lastError: string | null
  /** In plain words: something wrong with the certificate, or that it will not renew from the control plane. */
  warning: string | null
  attempts: number
  nextAttemptAt: string | null
  renewAt: string | null
  notAfter: string | null
  issuer: string | null
  createdAt: string
  updatedAt: string
}

export function toApiDnsCertificate(row: Row, now: Date = new Date()): ApiDnsCertificate {
  const meta = (row.metadata ?? {}) as {
    dnsNames?: string[]
    hasWildcard?: boolean
    issuer?: string
    acme?: Acme
  }
  const ordered = row.source === 'lets_encrypt'
  const ended = row.status === 'ready' && row.notAfter && Date.parse(row.notAfter) < now.getTime()
  const issued = row.status === 'ready'
  return {
    id: row.id,
    names: Array.isArray(meta.dnsNames) ? meta.dnsNames : [],
    wildcard: meta.hasWildcard === true,
    status: ended ? 'expired' : row.status,
    stage: meta.acme?.stage ?? 'queued',
    staging: meta.acme?.staging === true,
    lastError: meta.acme?.lastError ?? null,
    // Only a certificate in use keeps working; an order left open never finishes.
    warning: meta.acme?.warning ?? (issued && !ended && !ordered ? NO_RENEWAL_MESSAGE : null),
    attempts: meta.acme?.attempts ?? 0,
    // A panel-ordered certificate is never tried again or renewed from here; a server-placed one is.
    nextAttemptAt: ordered ? (meta.acme?.nextAttemptAt ?? null) : null,
    renewAt: ordered ? (meta.acme?.renewAt ?? null) : null,
    notAfter: issued ? row.notAfter : null,
    issuer: issued && meta.issuer ? meta.issuer : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** Rows this list shows: earlier panel-ordered uploads and certificates ordered over the DNS proof. */
const SHOWN = or(
  eq(tls.source, 'upload'),
  and(eq(tls.source, 'lets_encrypt'), sql`${tls.metadata} #>> '{acme,challengeType}' = 'dns-01'`)
)

async function listResponse(c: Context<AppEnv>, scope: Scope): Promise<Response> {
  const rows = await scope.db
    .select()
    .from(tls)
    .where(and(eq(tls.organizationId, scope.organizationId), SHOWN))
    .orderBy(tls.createdAt)
  const certificates = rows
    .filter((row) => row.source === 'lets_encrypt' || isPanelManagedAcme(row.metadata))
    .map((row) => toApiDnsCertificate(row))
  return c.json({ certificates })
}

async function ownRow(scope: Scope, tlsId: string): Promise<Row | null> {
  if (!isUuid(tlsId)) return null
  const [row] = await scope.db
    .select()
    .from(tls)
    .where(
      and(
        eq(tls.id, tlsId),
        eq(tls.organizationId, scope.organizationId),
        eq(tls.source, 'lets_encrypt'),
        sql`${tls.metadata} #>> '{acme,challengeType}' = 'dns-01'`
      )
    )
    .limit(1)
  return row ?? null
}

/**
 * Order a certificate: one to ten names, each a name or a wildcard. The row waits
 * for a server to place the order; nothing is sent to the authority from here.
 */
async function createOrder(c: Context<AppEnv>, scope: Scope): Promise<Response> {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  const parsed = parseCertificateNames(body?.names)
  if (!body || !parsed.ok) {
    return c.json(
      {
        error: 'Invalid request',
        message: parsed?.ok === false ? parsed.detail : 'Give the names to order',
      },
      400
    )
  }
  const material = materialFromLetsEncrypt(
    { hostnames: parsed.names, challengeType: 'dns-01', autoRenew: body.autoRenew },
    'library'
  )
  if ('status' in material) {
    return c.json({ error: material.error, message: material.detail ?? material.error }, 400)
  }
  const { columns, residual } = splitTlsMetadata(material.metadata)
  const [row] = await scope.db
    .insert(tls)
    .values({
      organizationId: scope.organizationId,
      name: null,
      source: 'lets_encrypt',
      certificatePem: null,
      privateKeyPem: null,
      status: columns.status,
      notAfter: columns.notAfter,
      fingerprintSha256: columns.fingerprintSha256,
      metadata: residual,
      options: material.options,
    })
    .returning()
  return c.json({ certificate: toApiDnsCertificate(row) }, 201)
}

/** "Try again": lift the wait after a failed order so the next sweep places it. */
async function retryOrder(c: Context<AppEnv>, scope: Scope): Promise<Response> {
  const row = await ownRow(scope, c.req.param('tlsId') as string)
  if (!row) return c.json({ error: 'Not found' }, 404)
  const [updated] = await scope.db
    .update(tls)
    .set({
      metadata: sql`case when jsonb_typeof(${tls.metadata} -> ${HTTP_CERT_KEY}) = 'object' then jsonb_set(${tls.metadata}, '{httpCert,nextAttemptAt}', 'null'::jsonb) else ${tls.metadata} end`,
    })
    .where(eq(tls.id, row.id))
    .returning()
  return c.json({ certificate: toApiDnsCertificate(updated ?? row) })
}

/** "Check now": the current state; the sweep moves an order on every minute. */
async function checkOrder(c: Context<AppEnv>, scope: Scope): Promise<Response> {
  const row = await ownRow(scope, c.req.param('tlsId') as string)
  return row
    ? c.json({ certificate: toApiDnsCertificate(row) })
    : c.json({ error: 'Not found' }, 404)
}

/** The routes sit behind the session; each also needs the organization's manage check. */
export function registerOrganizationDnsCertificateRoutes(
  router: Hono<AppEnv>,
  opts: AuthRouteOpts
) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for DNS certificate routes')
  }
  for (const path of PATHS) {
    router.use(path, createSessionMiddleware(opts.secrets))
  }
  const scoped =
    (run: (c: Context<AppEnv>, scope: Scope) => Promise<Response>) =>
    async (c: Context<AppEnv>) => {
      const scope = await loadScope(c)
      return scope instanceof Response ? scope : await run(c, scope)
    }
  router.get('/organizations/:id/dns-certificates', scoped(listResponse))
  router.post('/organizations/:id/dns-certificates', scoped(createOrder))
  router.post('/organizations/:id/dns-certificates/:tlsId/check', scoped(checkOrder))
  router.post('/organizations/:id/dns-certificates/:tlsId/retry', scoped(retryOrder))
}
