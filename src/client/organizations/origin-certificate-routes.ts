/**
 * Origin certificates a tunnel provider issues for an organization's zones,
 * for the optional verified hop between the connector and the web server.
 * Owners and managers only (the same check as provider accounts). The key is
 * made here and stays sealed in the certificate library; responses carry the
 * names, expiry and whether a site uses the certificate, never a key.
 */
import type { Context, Hono } from 'hono'
import { eq } from 'drizzle-orm'
import type { AppEnv } from '../../app/app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { parseJsonBody } from '../shared.ts'
import { isUuid } from '../access/routes-helpers.ts'
import { isValidHostname } from '../../contracts/commands/hostname.ts'
import { tls } from '../../db/schema.ts'
import { TunnelProviderError } from '../../features/tunnels/errors.ts'
import {
  badgeCoversZone,
  hostingsPinning,
  issueOriginCertificate,
  listOriginCertificates,
  originCertificateIsDue,
  originCertificateNames,
  OriginCertificateRefusal,
  readProviderOrigin,
  revokeOriginCertificate,
  type TlsRow,
} from '../../features/tunnels/origin-certificate.ts'
import {
  type BadgeRow,
  type CarrierRow,
  listBadges,
  openBadgeToken,
  recordBadgeCheck,
} from '../../features/tunnels/records.ts'
import {
  createTunnelAdapterRegistry,
  type TunnelAdapterRegistry,
} from '../../features/tunnels/registry.ts'
import { NO_CAPABILITIES, type TunnelProvider } from '../../features/tunnels/vocabulary.ts'
import { audit, loadCarrierParam, loadScope, providerFailure, type Scope } from './carrier-routes.ts'

const ORIGIN_CERTIFICATE_PATHS = [
  '/organizations/:id/carriers/:carrierId/origin-certificates',
  '/organizations/:id/carriers/:carrierId/origin-certificates/:tlsId',
] as const

type ApiOriginCertificate = {
  id: string
  carrierId: string
  zone: string
  names: string[]
  notAfter: string | null
  status: string
  createdAt: string
  /** Sites that use it; it cannot be removed while any do. */
  inUse: boolean
  /** True when it is close enough to expiry to be replaced. */
  renewalDue: boolean
}

async function toApi(
  scope: Scope,
  row: TlsRow
): Promise<ApiOriginCertificate | null> {
  const link = readProviderOrigin(row.metadata)
  if (!link) return null
  return {
    id: row.id,
    carrierId: link.carrierId,
    zone: link.zoneName,
    names: originCertificateNames(link.zoneName),
    notAfter: row.notAfter,
    status: row.status,
    createdAt: row.createdAt,
    inUse: (await hostingsPinning(scope.db, row.id)).length > 0,
    renewalDue: originCertificateIsDue(row.notAfter),
  }
}

function refusalResponse(c: Context<AppEnv>, err: OriginCertificateRefusal): Response {
  const status =
    err.error === 'secrets_unavailable'
      ? 503
      : err.error === 'tls_in_use' ||
          err.error === 'origin_certificate_limit' ||
          err.error === 'badge_missing'
        ? 409
        : 400
  return c.json({ error: err.error, message: err.message }, status)
}

/**
 * A token added before certificates were checked has no certificate rights
 * recorded. Check the carrier's tokens once, store what they reach, and pick
 * the first that covers the zone.
 */
async function badgeForZone(
  c: Context<AppEnv>,
  scope: Scope,
  registry: TunnelAdapterRegistry,
  current: CarrierRow,
  zone: string,
  wanted: string | null
): Promise<BadgeRow | null | Response> {
  const secrets = c.get('dataEncryptionSecrets')
  if (!secrets) return c.json({ error: 'secrets_unavailable' }, 503)
  let candidates = await listBadges(scope.db, current.id)
  if (wanted) candidates = candidates.filter((b) => b.id === wanted)
  const covering = candidates.find((b) => badgeCoversZone(b, zone))
  if (covering) return covering
  for (const candidate of candidates) {
    const token = await openBadgeToken(scope.db, secrets, candidate)
    if (token === null) continue
    try {
      const report = await registry(current.provider as TunnelProvider).checkCredential(token, {
        accountId: current.externalAccountId,
      })
      const updated = await recordBadgeCheck(scope.db, candidate, {
        capabilities: report.capabilities ?? NO_CAPABILITIES,
        status: candidate.status === 'active' ? 'active' : 'attention',
        token: report.token,
      })
      if (badgeCoversZone(updated, zone)) return updated
    } catch (err) {
      if (err instanceof TunnelProviderError && err.code !== 'unauthorized') {
        return providerFailure(c, err)
      }
    }
  }
  return null
}

function listResponse() {
  return async (c: Context<AppEnv>, scope: Scope): Promise<Response> => {
    const current = await loadCarrierParam(c, scope)
    if (current instanceof Response) return current
    const rows = await listOriginCertificates(scope.db, scope.organizationId, current.id)
    const items = (await Promise.all(rows.map((row) => toApi(scope, row)))).filter(
      (item): item is ApiOriginCertificate => item !== null
    )
    return c.json({ originCertificates: items })
  }
}

function issueResponse(registry: TunnelAdapterRegistry) {
  return async (c: Context<AppEnv>, scope: Scope): Promise<Response> => {
    const current = await loadCarrierParam(c, scope)
    if (current instanceof Response) return current
    const body = await parseJsonBody(c)
    if (body instanceof Response) return body
    const zone = typeof body.zone === 'string' ? body.zone.trim().toLowerCase() : ''
    if (!zone.includes('.') || !isValidHostname(zone)) {
      return c.json(
        { error: 'origin_certificate_invalid', field: 'zone', detail: 'Give the zone name, such as example.com.' },
        400
      )
    }
    const wanted = typeof body.badgeId === 'string' && isUuid(body.badgeId) ? body.badgeId : null
    const secrets = c.get('dataEncryptionSecrets')
    if (!secrets) return c.json({ error: 'secrets_unavailable' }, 503)

    // One certificate per zone and account while it is healthy: asking again returns it.
    const existing = (await listOriginCertificates(scope.db, scope.organizationId, current.id)).find(
      (row) =>
        readProviderOrigin(row.metadata)?.zoneName === zone &&
        row.status === 'ready' &&
        !originCertificateIsDue(row.notAfter)
    )
    if (existing) {
      return c.json({ originCertificate: await toApi(scope, existing), reused: true })
    }

    const chosen = await badgeForZone(c, scope, registry, current, zone, wanted)
    if (chosen instanceof Response) return chosen
    if (chosen === null) {
      return c.json(
        {
          error: 'badge_cannot_certify',
          message: 'No API Token on this account can manage certificates for that zone.',
        },
        400
      )
    }
    try {
      const row = await issueOriginCertificate({
        db: scope.db,
        secrets,
        adapter: registry(current.provider as TunnelProvider),
        organizationId: scope.organizationId,
        carrier: current,
        badge: chosen,
        zoneName: zone,
      })
      await audit(c, scope, 'origin_certificate.issue', row.id, {
        carrierId: current.id,
        zone,
      })
      return c.json({ originCertificate: await toApi(scope, row), reused: false }, 201)
    } catch (err) {
      if (err instanceof OriginCertificateRefusal) return refusalResponse(c, err)
      if (err instanceof TunnelProviderError) return providerFailure(c, err)
      throw err
    }
  }
}

function revokeResponse(registry: TunnelAdapterRegistry) {
  return async (c: Context<AppEnv>, scope: Scope): Promise<Response> => {
    const current = await loadCarrierParam(c, scope)
    if (current instanceof Response) return current
    const tlsId = c.req.param('tlsId') as string
    if (!isUuid(tlsId)) return c.json({ error: 'Not found' }, 404)
    const secrets = c.get('dataEncryptionSecrets')
    if (!secrets) return c.json({ error: 'secrets_unavailable' }, 503)
    const [row] = await scope.db.select().from(tls).where(eq(tls.id, tlsId)).limit(1)
    const link = row ? readProviderOrigin(row.metadata) : null
    if (
      !row ||
      row.organizationId !== scope.organizationId ||
      row.source !== 'provider_origin' ||
      link?.carrierId !== current.id
    ) {
      return c.json({ error: 'Not found' }, 404)
    }
    try {
      await revokeOriginCertificate({
        db: scope.db,
        secrets,
        adapter: registry(current.provider as TunnelProvider),
        row,
      })
    } catch (err) {
      if (err instanceof OriginCertificateRefusal) return refusalResponse(c, err)
      if (err instanceof TunnelProviderError) return providerFailure(c, err)
      throw err
    }
    await audit(c, scope, 'origin_certificate.revoke', row.id, {
      carrierId: current.id,
      zone: link?.zoneName ?? null,
    })
    return c.json({ ok: true })
  }
}

/** `fetchImpl` lets tests stand in for the provider; production uses the real one. */
export function registerOrganizationOriginCertificateRoutes(
  router: Hono<AppEnv>,
  opts: AuthRouteOpts,
  fetchImpl?: typeof fetch
) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for origin certificate routes')
  }
  for (const path of ORIGIN_CERTIFICATE_PATHS) {
    router.use(path, createSessionMiddleware(opts.secrets))
  }
  const registry = createTunnelAdapterRegistry(fetchImpl)
  const guarded =
    (handler: (c: Context<AppEnv>, scope: Scope) => Promise<Response>) =>
    async (c: Context<AppEnv>) => {
      const scope = await loadScope(c)
      return scope instanceof Response ? scope : await handler(c, scope)
    }
  router.get(ORIGIN_CERTIFICATE_PATHS[0], guarded(listResponse()))
  router.post(ORIGIN_CERTIFICATE_PATHS[0], guarded(issueResponse(registry)))
  router.delete(ORIGIN_CERTIFICATE_PATHS[1], guarded(revokeResponse(registry)))
}
