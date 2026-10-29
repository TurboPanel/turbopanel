/**
 * Certificates this panel orders itself and proves by a DNS challenge, through
 * the account that hosts the domain's DNS. Exact names by default; a wildcard
 * only when it is asked for by name (`*.example.com`). Owners and managers
 * only. Ordering takes minutes, so the routes only start it and report where
 * it stands; the periodic sweep (and "check now") carries it forward.
 */
import { and, eq } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { tls } from '../../db/schema.ts'
import { recordAudit } from '../../features/audit/audit-records.ts'
import {
  advanceDnsCertificate,
  retryDnsCertificate,
  startDnsCertificate,
} from '../../features/tls/dns-certificates/issuance.ts'
import { parseCertificateNames } from '../../features/tls/dns-certificates/names.ts'
import { isPanelManagedAcme } from '../../features/tls/dns-certificates/order-state.ts'
import { NoDnsTokenError, resolveZones } from '../../features/tls/dns-certificates/zones.ts'
import type { DnsCertContext } from '../../features/tls/dns-certificates/context.ts'
import { TunnelProviderError } from '../../features/tunnels/errors.ts'
import { findCarrier } from '../../features/tunnels/records.ts'
import { TUNNEL_PROVIDERS } from '../../features/tunnels/vocabulary.ts'
import { runAfterResponse } from '../../lib/http/after-response.ts'
import { isUuid } from '../access/routes-helpers.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { loadAcmeEnabled } from '../hostings/letsencrypt-store.ts'
import { parseJsonBody } from '../shared.ts'
import { buildDnsCertContext } from '../tls/dns-certificate-context.ts'
import { loadScope, type Scope } from './carrier-routes.ts'

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
  /** Something that will stop the next renewal, in plain words. */
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
    warning: meta.acme?.warning ?? null,
    attempts: meta.acme?.attempts ?? 0,
    nextAttemptAt: meta.acme?.nextAttemptAt ?? null,
    renewAt: meta.acme?.renewAt ?? null,
    notAfter: issued ? row.notAfter : null,
    issuer: issued && meta.issuer ? meta.issuer : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

type Wiring = { fetch?: typeof fetch; acmeFetch?: typeof fetch; presentGraceMs?: number }

function contextOf(c: Context<AppEnv>, scope: Scope, wiring: Wiring): DnsCertContext | null {
  const secrets = c.get('dataEncryptionSecrets')
  if (!secrets) return null
  const commandQueue = c.get('commandQueue')
  return buildDnsCertContext(scope.db, {
    secrets,
    ...(commandQueue
      ? { push: { commandQueue, secretsConfig: c.get('secretsConfig') ?? null } }
      : {}),
    ...wiring,
  })
}

async function loadCertificate(c: Context<AppEnv>, scope: Scope): Promise<Row | Response> {
  const id = c.req.param('tlsId') as string
  if (!isUuid(id)) return c.json({ error: 'Not found' }, 404)
  const [row] = await scope.db
    .select()
    .from(tls)
    .where(
      and(eq(tls.id, id), eq(tls.organizationId, scope.organizationId), eq(tls.source, 'upload'))
    )
    .limit(1)
  return row && isPanelManagedAcme(row.metadata) ? row : c.json({ error: 'Not found' }, 404)
}

async function audit(
  c: Context<AppEnv>,
  scope: Scope,
  action: 'tls.dns_certificate.create' | 'tls.dns_certificate.retry',
  targetId: string,
  context: Record<string, unknown>
) {
  const session = c.get('session')
  await recordAudit(scope.db, {
    organizationId: scope.organizationId,
    actorUserId: session?.userId ?? null,
    actorEmail: session?.email ?? null,
    action,
    targetType: 'tls',
    targetId,
    context,
  })
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

/** The plain-words reply for a provider failure while looking up zones. */
function zoneFailure(c: Context<AppEnv>, err: unknown, names: readonly string[]): Response {
  if (err instanceof NoDnsTokenError) {
    return c.json(
      {
        error: 'no_dns_token',
        message:
          'No token on this account can edit DNS records. Add one with the DNS edit permission.',
      },
      400
    )
  }
  if (err instanceof TunnelProviderError) {
    if (err.code === 'zone_not_found') {
      return c.json(
        {
          error: 'zone_not_found',
          hostnames: names,
          message:
            'No zone for these names was found among the zones the account’s tokens can edit.',
        },
        400
      )
    }
    if (err.code === 'unauthorized' || err.code === 'forbidden') {
      return c.json(
        { error: 'badge_rejected', message: 'The provider did not accept this token.' },
        400
      )
    }
    return c.json({ error: 'provider_unavailable', message: err.message }, 502)
  }
  throw err
}

function createResponse(wiring: Wiring) {
  return async (c: Context<AppEnv>, scope: Scope): Promise<Response> => {
    const body = await parseJsonBody(c)
    if (body instanceof Response) return body
    const names = parseCertificateNames(body.names)
    if (!names.ok)
      return c.json({ error: 'names_invalid', field: 'names', detail: names.detail }, 400)
    const carrierId = typeof body.carrierId === 'string' ? body.carrierId : ''
    if (!isUuid(carrierId)) {
      return c.json(
        { error: 'carrier_invalid', field: 'carrierId', detail: 'Choose an account' },
        400
      )
    }
    if (!(await loadAcmeEnabled(scope.db, scope.organizationId))) {
      return c.json({ error: 'lets_encrypt_not_enabled' }, 403)
    }
    const carrier = await findCarrier(scope.db, scope.organizationId, carrierId)
    if (!carrier) return c.json({ error: 'Not found' }, 404)
    if (!(TUNNEL_PROVIDERS as readonly string[]).includes(carrier.provider)) {
      return c.json({ error: 'provider_unsupported' }, 400)
    }
    const ctx = contextOf(c, scope, wiring)
    if (!ctx) return c.json({ error: 'secrets_unavailable' }, 503)
    let zones
    try {
      zones = await resolveZones(ctx, carrier, names.names)
    } catch (err) {
      return zoneFailure(c, err, names.names)
    }
    const staging = body.staging === true
    const started = await startDnsCertificate(ctx, {
      organizationId: scope.organizationId,
      carrierId: carrier.id,
      names: names.names,
      zones,
      staging,
    })
    if (started.kind === 'limit') return c.json({ error: 'dns_certificate_limit' }, 429)
    if (started.kind === 'created') {
      await audit(c, scope, 'tls.dns_certificate.create', started.id, {
        names: names.names,
        staging,
      })
      // The first steps (the order and the records) run after the answer is sent.
      runAfterResponse(c, 'tls', async () => {
        await advanceDnsCertificate(ctx, started.id)
      })
    }
    const [row] = await scope.db.select().from(tls).where(eq(tls.id, started.id)).limit(1)
    return c.json(
      { certificate: toApiDnsCertificate(row!), reused: started.kind === 'reused' },
      started.kind === 'created' ? 201 : 200
    )
  }
}

function checkResponse(wiring: Wiring) {
  return async (c: Context<AppEnv>, scope: Scope): Promise<Response> => {
    const row = await loadCertificate(c, scope)
    if (row instanceof Response) return row
    const ctx = contextOf(c, scope, wiring)
    if (!ctx) return c.json({ error: 'secrets_unavailable' }, 503)
    const outcome = await advanceDnsCertificate(ctx, row.id)
    const [fresh] = await scope.db.select().from(tls).where(eq(tls.id, row.id)).limit(1)
    return c.json({ certificate: toApiDnsCertificate(fresh ?? row), outcome })
  }
}

function retryResponse(wiring: Wiring) {
  return async (c: Context<AppEnv>, scope: Scope): Promise<Response> => {
    const row = await loadCertificate(c, scope)
    if (row instanceof Response) return row
    const ctx = contextOf(c, scope, wiring)
    if (!ctx) return c.json({ error: 'secrets_unavailable' }, 503)
    const outcome = await retryDnsCertificate(ctx, row.id)
    if (outcome === 'not_failed') return c.json({ error: 'not_failed' }, 409)
    if (outcome === 'too_soon') return c.json({ error: 'retry_too_soon' }, 429)
    if (outcome === 'not_found') return c.json({ error: 'Not found' }, 404)
    await audit(c, scope, 'tls.dns_certificate.retry', row.id, {})
    const [fresh] = await scope.db.select().from(tls).where(eq(tls.id, row.id)).limit(1)
    return c.json({ certificate: toApiDnsCertificate(fresh ?? row) })
  }
}

/** `wiring` lets tests stand in for the provider and the certificate authority. */
export function registerOrganizationDnsCertificateRoutes(
  router: Hono<AppEnv>,
  opts: AuthRouteOpts,
  wiring: Wiring = {}
) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for DNS certificate routes')
  }
  for (const path of PATHS) {
    router.use(path, createSessionMiddleware(opts.secrets))
  }
  const guarded =
    (handler: (c: Context<AppEnv>, scope: Scope) => Promise<Response>) =>
    async (c: Context<AppEnv>) => {
      const scope = await loadScope(c)
      return scope instanceof Response ? scope : await handler(c, scope)
    }
  router.get('/organizations/:id/dns-certificates', guarded(listResponse))
  router.post('/organizations/:id/dns-certificates', guarded(createResponse(wiring)))
  router.post('/organizations/:id/dns-certificates/:tlsId/check', guarded(checkResponse(wiring)))
  router.post('/organizations/:id/dns-certificates/:tlsId/retry', guarded(retryResponse(wiring)))
}
