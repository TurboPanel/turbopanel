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
import { firstResult } from '../../features/tunnels/sequence.ts'
import { isValidHostname } from '../../contracts/commands/hostname.ts'
import { tls } from '../../db/schema.ts'
import { TunnelProviderError } from '../../features/tunnels/errors.ts'
import { findTunnel, toApiTunnel, TunnelRefusal } from '../../features/tunnels/lifecycle.ts'
import { setVerifyOrigin } from '../../features/tunnels/verify-origin.ts'
import {
  badgeCoversZone,
  describeExistingOriginCertificates,
  ensureOriginCertificate,
  hostingsPinning,
  listOriginCertificates,
  originCertificateIsDue,
  OriginCertificateRefusal,
  readProviderOrigin,
  revokeOriginCertificate,
  type TlsRow,
} from '../../features/tunnels/origin-certificate.ts'
import {
  type BadgeRow,
  type CarrierRow,
  findCarrier,
  listBadges,
  openBadgeToken,
  recordBadgeCheck,
} from '../../features/tunnels/records.ts'
import {
  createTunnelAdapterRegistry,
  type TunnelAdapterRegistry,
} from '../../features/tunnels/registry.ts'
import { NO_CAPABILITIES, type TunnelProvider } from '../../features/tunnels/vocabulary.ts'
import {
  audit,
  loadCarrierParam,
  loadScope,
  providerFailure,
  type Scope,
} from './carrier-routes.ts'

const ORIGIN_CERTIFICATE_PATHS = [
  '/organizations/:id/carriers/:carrierId/origin-certificates',
  '/organizations/:id/carriers/:carrierId/origin-certificates/:tlsId',
  '/organizations/:id/carriers/:carrierId/origin-certificates/existing',
  '/organizations/:id/tunnels/:tunnelId/verify-origin',
] as const

type ApiOriginCertificate = {
  id: string
  carrierId: string
  zone: string
  names: string[]
  /** `names` is a certificate for exact hostnames (the default); `wildcard` covers the zone and one label below it. */
  scope: 'names' | 'wildcard'
  /** No longer needed; it is revoked once no site uses it. */
  retired: boolean
  notAfter: string | null
  status: string
  createdAt: string
  /** Sites that use it; it cannot be removed while any do. */
  inUse: boolean
  /** True when it is close enough to expiry to be replaced. */
  renewalDue: boolean
}

async function toApi(scope: Scope, row: TlsRow): Promise<ApiOriginCertificate | null> {
  const link = readProviderOrigin(row.metadata)
  if (!link) return null
  return {
    id: row.id,
    carrierId: link.carrierId,
    zone: link.zoneName,
    names: link.hostnames,
    scope: link.scope,
    retired: link.retiredAt !== null,
    notAfter: row.notAfter,
    status: row.status,
    createdAt: row.createdAt,
    inUse: (await hostingsPinning(scope.db, row.id)).length > 0,
    renewalDue: originCertificateIsDue(row.notAfter),
  }
}

const REFUSAL_STATUS: Partial<Record<OriginCertificateRefusal['error'], 409 | 503>> = {
  secrets_unavailable: 503,
  tls_in_use: 409,
  origin_certificate_limit: 409,
  badge_missing: 409,
}

function refusalResponse(c: Context<AppEnv>, err: OriginCertificateRefusal): Response {
  return c.json({ error: err.error, message: err.message }, REFUSAL_STATUS[err.error] ?? 400)
}

/**
 * A token added before certificates were checked has no certificate rights
 * recorded. Check the carrier's tokens once, store what they reach, and pick
 * the first that covers the zone.
 */
async function checkedBadge(
  c: Context<AppEnv>,
  scope: Scope,
  registry: TunnelAdapterRegistry,
  current: CarrierRow,
  candidate: BadgeRow,
  zone: string
): Promise<BadgeRow | null | Response> {
  const secrets = c.get('dataEncryptionSecrets')
  const token = secrets ? await openBadgeToken(scope.db, secrets, candidate) : null
  if (token === null) return null
  try {
    const report = await registry(current.provider as TunnelProvider).checkCredential(token, {
      accountId: current.externalAccountId,
    })
    const updated = await recordBadgeCheck(scope.db, candidate, {
      capabilities: report.capabilities ?? NO_CAPABILITIES,
      status: candidate.status === 'active' ? 'active' : 'attention',
      token: report.token,
    })
    return badgeCoversZone(updated, zone) ? updated : null
  } catch (err) {
    if (err instanceof TunnelProviderError && err.code !== 'unauthorized') {
      return providerFailure(c, err)
    }
    return null
  }
}

async function badgeForZone(
  c: Context<AppEnv>,
  scope: Scope,
  registry: TunnelAdapterRegistry,
  current: CarrierRow,
  zone: string,
  wanted: string | null
): Promise<BadgeRow | null | Response> {
  if (!c.get('dataEncryptionSecrets')) return c.json({ error: 'secrets_unavailable' }, 503)
  const listed = await listBadges(scope.db, current.id)
  const candidates = wanted ? listed.filter((b) => b.id === wanted) : listed
  const covering = candidates.find((b) => badgeCoversZone(b, zone))
  if (covering) return covering
  // One token after another; a provider failure other than a refused token stops the search.
  const found = await firstResult(candidates, async (candidate) => {
    const checked = await checkedBadge(c, scope, registry, current, candidate, zone)
    return checked ?? undefined
  })
  return found ?? null
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

type IssueBody = {
  zone: string
  wildcard: boolean
  names: string[] | undefined
}

/** The zone and the names (or the wildcard choice) of an issue request, or what is wrong with them. */
function parseIssueBody(
  body: Record<string, unknown>
): { ok: true; value: IssueBody } | { ok: false; field: string; detail: string } {
  const zone = typeof body.zone === 'string' ? body.zone.trim().toLowerCase() : ''
  if (!zone.includes('.') || !isValidHostname(zone)) {
    return { ok: false, field: 'zone', detail: 'Give the zone name, such as example.com.' }
  }
  // The default is a certificate for exact hostnames; a wildcard is an explicit choice.
  const wildcard = body.wildcard === true
  const names =
    Array.isArray(body.names) && body.names.every((n) => typeof n === 'string')
      ? (body.names as string[])
      : undefined
  if (!wildcard && !names?.length) {
    return {
      ok: false,
      field: 'names',
      detail: 'Give the hostnames the certificate is for, or choose the wildcard option.',
    }
  }
  return { ok: true, value: { zone, wildcard, names } }
}

function cannotCertify(c: Context<AppEnv>): Response {
  return c.json(
    {
      error: 'badge_cannot_certify',
      message: 'No API Token on this account can manage certificates for that zone.',
    },
    400
  )
}

/** Turn a failed certificate call into its reply; anything unexpected is rethrown. */
function failureResponse(c: Context<AppEnv>, err: unknown): Response {
  if (err instanceof OriginCertificateRefusal) return refusalResponse(c, err)
  if (err instanceof TunnelProviderError) return providerFailure(c, err)
  throw err
}

function issueResponse(registry: TunnelAdapterRegistry) {
  return async (c: Context<AppEnv>, scope: Scope): Promise<Response> => {
    const current = await loadCarrierParam(c, scope)
    if (current instanceof Response) return current
    const body = await parseJsonBody(c)
    if (body instanceof Response) return body
    const parsed = parseIssueBody(body)
    if (!parsed.ok) {
      return c.json(
        { error: 'origin_certificate_invalid', field: parsed.field, detail: parsed.detail },
        400
      )
    }
    const { zone, wildcard, names } = parsed.value
    const wanted = typeof body.badgeId === 'string' && isUuid(body.badgeId) ? body.badgeId : null
    const secrets = c.get('dataEncryptionSecrets')
    if (!secrets) return c.json({ error: 'secrets_unavailable' }, 503)
    const chosen = await badgeForZone(c, scope, registry, current, zone, wanted)
    if (chosen instanceof Response) return chosen
    if (chosen === null) return cannotCertify(c)
    try {
      // A certificate TurboPanel already issued that covers every name is returned again.
      const ensured = await ensureOriginCertificate({
        db: scope.db,
        secrets,
        adapter: registry(current.provider as TunnelProvider),
        organizationId: scope.organizationId,
        carrier: current,
        badge: chosen,
        zoneName: zone,
        names,
        scope: wildcard ? 'wildcard' : 'names',
      })
      if (!ensured.reused) {
        await audit(c, scope, 'origin_certificate.issue', ensured.row.id, {
          carrierId: current.id,
          zone,
          scope: wildcard ? 'wildcard' : 'names',
        })
      }
      return c.json(
        {
          originCertificate: await toApi(scope, ensured.row),
          reused: ensured.reused,
          replaces: ensured.retiredIds,
        },
        ensured.reused ? 200 : 201
      )
    } catch (err) {
      return failureResponse(c, err)
    }
  }
}

/**
 * What the provider already holds for a zone, next to what TurboPanel issued.
 * Read-only. A certificate made outside TurboPanel is listed but cannot be
 * installed: its private key was never ours.
 */
function existingResponse(registry: TunnelAdapterRegistry) {
  return async (c: Context<AppEnv>, scope: Scope): Promise<Response> => {
    const current = await loadCarrierParam(c, scope)
    if (current instanceof Response) return current
    const zone = (c.req.query('zone') ?? '').trim().toLowerCase()
    if (!zone.includes('.') || !isValidHostname(zone)) {
      return c.json(
        {
          error: 'origin_certificate_invalid',
          field: 'zone',
          detail: 'Give the zone name, such as example.com.',
        },
        400
      )
    }
    const secrets = c.get('dataEncryptionSecrets')
    if (!secrets) return c.json({ error: 'secrets_unavailable' }, 503)
    const chosen = await badgeForZone(c, scope, registry, current, zone, null)
    if (chosen instanceof Response) return chosen
    const zoneInfo = chosen ? badgeCoversZone(chosen, zone) : null
    if (chosen === null || zoneInfo === null) {
      return c.json(
        {
          error: 'badge_cannot_certify',
          message: 'No API Token on this account can read certificates for that zone.',
        },
        400
      )
    }
    const adapter = registry(current.provider as TunnelProvider)
    if (!adapter.listOriginCertificates) {
      return c.json({ error: 'unsupported_provider' }, 400)
    }
    const token = await openBadgeToken(scope.db, secrets, chosen)
    if (token === null) return c.json({ error: 'secrets_unavailable' }, 503)
    try {
      const provider = await adapter.listOriginCertificates(token, { zoneId: zoneInfo.id })
      const rows = await listOriginCertificates(scope.db, scope.organizationId, current.id)
      return c.json({
        zone,
        certificates: describeExistingOriginCertificates(provider, rows, zone),
      })
    } catch (err) {
      if (err instanceof TunnelProviderError) return providerFailure(c, err)
      throw err
    }
  }
}

/** Turn the verified connection on or off for one tunnel (see `setVerifyOrigin`). */
function verifyOriginResponse(registry: TunnelAdapterRegistry) {
  return async (c: Context<AppEnv>, scope: Scope): Promise<Response> => {
    const tunnelId = c.req.param('tunnelId') as string
    if (!isUuid(tunnelId)) return c.json({ error: 'Not found' }, 404)
    const row = await findTunnel(scope.db, scope.organizationId, tunnelId)
    const owner = row?.carrierId
      ? await findCarrier(scope.db, scope.organizationId, row.carrierId)
      : null
    if (!row || !owner) return c.json({ error: 'Not found' }, 404)
    const body = await parseJsonBody(c)
    if (body instanceof Response) return body
    if (typeof body.enabled !== 'boolean') {
      return c.json(
        {
          error: 'tunnel_invalid',
          field: 'enabled',
          detail: 'Say whether to verify the connection.',
        },
        400
      )
    }
    const secrets = c.get('dataEncryptionSecrets')
    if (!secrets) return c.json({ error: 'secrets_unavailable' }, 503)
    try {
      const done = await setVerifyOrigin(
        {
          db: scope.db,
          secrets,
          adapter: registry(owner.provider as TunnelProvider),
          organizationId: scope.organizationId,
          chooseBadge: async (zone) => {
            const found = await badgeForZone(c, scope, registry, owner, zone, null)
            return found instanceof Response ? null : found
          },
        },
        owner,
        row,
        body.enabled,
        body.wildcard === true ? 'wildcard' : 'names'
      )
      await audit(c, scope, 'tunnel.update', row.id, {
        name: row.name,
        verifyOrigin: body.enabled,
      })
      return c.json({
        tunnel: await toApiTunnel(scope.db, done.tunnel),
        verifyOrigin: done.state,
        pinnedHostingIds: done.pinnedHostingIds,
        // The servers pick up a new certificate with the site's next deploy.
        needsDeploy: done.pinnedHostingIds.length > 0,
      })
    } catch (err) {
      if (err instanceof TunnelRefusal) {
        return c.json({ error: err.code, message: err.message }, err.status)
      }
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
    const link = readProviderOrigin(row?.metadata)
    if (
      row?.organizationId !== scope.organizationId ||
      row.source !== 'provider_origin' ||
      link?.carrierId !== current.id
    ) {
      return c.json({ error: 'Not found' }, 404)
    }
    let revokedWithBadgeId: string | null = null
    try {
      ;({ revokedWithBadgeId } = await revokeOriginCertificate({
        db: scope.db,
        secrets,
        adapter: registry(current.provider as TunnelProvider),
        row,
      }))
    } catch (err) {
      if (err instanceof OriginCertificateRefusal) return refusalResponse(c, err)
      if (err instanceof TunnelProviderError) return providerFailure(c, err)
      throw err
    }
    // Which token revoked it is recorded; it need not be the one that issued it.
    await audit(c, scope, 'origin_certificate.revoke', row.id, {
      carrierId: current.id,
      zone: link?.zoneName ?? null,
      revokedWithBadgeId,
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
  router.get(ORIGIN_CERTIFICATE_PATHS[2], guarded(existingResponse(registry)))
  router.put(ORIGIN_CERTIFICATE_PATHS[3], guarded(verifyOriginResponse(registry)))
}
