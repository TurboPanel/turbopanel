/**
 * Certificates the panel ordered itself and proved by a DNS challenge. The
 * control plane no longer orders them, on either edition: a certificate is
 * ordered by the server that runs the site instead. Starting an order, "check
 * now" and "try again" answer a plain refusal (`ORDERING_OFF_ERROR`) before any
 * database read, so nothing reaches the certificate authority. The list stays:
 * certificates already issued keep serving until they expire, and are deleted
 * in the certificate library like any other. Owners and managers only.
 */
import { and, eq } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { tls } from '../../db/schema.ts'
import { isPanelManagedAcme } from '../../features/tls/dns-certificates/order-state.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { loadScope, type Scope } from './carrier-routes.ts'

/** The error code of the refusal to start, check or retry an order. */
export const ORDERING_OFF_ERROR = 'certificate_ordering_off'
/** The plain sentence that goes with it. */
export const ORDERING_OFF_MESSAGE =
  'Ordering certificates from the control plane is turned off. Certificates will be ordered by the server that runs the site in a coming release.'
/** What every listed certificate says while no other warning is due. */
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
    warning: meta.acme?.warning ?? NO_RENEWAL_MESSAGE,
    attempts: meta.acme?.attempts ?? 0,
    // Nothing is tried again or renewed from the control plane.
    nextAttemptAt: null,
    renewAt: null,
    notAfter: issued ? row.notAfter : null,
    issuer: issued && meta.issuer ? meta.issuer : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

async function listResponse(c: Context<AppEnv>, scope: Scope): Promise<Response> {
  const rows = await scope.db
    .select()
    .from(tls)
    .where(and(eq(tls.organizationId, scope.organizationId), eq(tls.source, 'upload')))
    .orderBy(tls.createdAt)
  const certificates = rows
    .filter((row) => isPanelManagedAcme(row.metadata))
    .map((row) => toApiDnsCertificate(row))
  return c.json({ certificates })
}

/** Starting, checking and retrying an order all answer this, on both editions. */
function refuseOrdering(c: Context<AppEnv>): Response {
  return c.json({ error: ORDERING_OFF_ERROR, message: ORDERING_OFF_MESSAGE }, 422)
}

/**
 * The list behind the session and the organization's manage check; the three
 * order routes behind the session only, refused before anything is read.
 */
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
  router.get('/organizations/:id/dns-certificates', async (c) => {
    const scope = await loadScope(c)
    return scope instanceof Response ? scope : await listResponse(c, scope)
  })
  for (const path of PATHS) router.post(path, refuseOrdering)
}
