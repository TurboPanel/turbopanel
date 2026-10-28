/**
 * Provider accounts (carriers) and their API tokens (badges) for tunnels.
 * Owners and managers only (`organization:manage`, the same check as backup
 * targets). A token is accepted once, checked against the provider, sealed
 * into the `secret` table and never returned: responses carry the label and
 * the last four characters. Audit rows never carry a token.
 */
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanManageOr403, parseJsonBody } from '../shared.ts'
import { type Db, getDb } from '../../db/connection.ts'
import { isUuid } from '../access/routes-helpers.ts'
import { isForeignKeyViolation } from '../hierarchy-delete.ts'
import { isPostgresUniqueViolation } from '../../db/unique-violation.ts'
import { recordAudit } from '../../features/audit/audit-records.ts'
import type { CredentialReport } from '../../features/tunnels/adapter.ts'
import { TunnelProviderError } from '../../features/tunnels/errors.ts'
import {
  type BadgeRow,
  type CarrierRow,
  carrierHasTunnels,
  deleteBadge,
  deleteCarrier,
  findBadge,
  findCarrier,
  insertBadge,
  insertCarrier,
  isUsefulReport,
  listBadges,
  listCarriers,
  MAX_BADGES_PER_CARRIER,
  MAX_CARRIERS_PER_ORG,
  openBadgeToken,
  parseBadgeBody,
  parseCarrierBody,
  recordBadgeCheck,
  sealToken,
  toApiBadge,
  toApiCarrier,
} from '../../features/tunnels/records.ts'
import {
  createTunnelAdapterRegistry,
  type TunnelAdapterRegistry,
} from '../../features/tunnels/registry.ts'
import { NO_CAPABILITIES, type TunnelProvider } from '../../features/tunnels/vocabulary.ts'

const CARRIER_PATHS = [
  '/organizations/:id/carriers',
  '/organizations/:id/carriers/:carrierId',
  '/organizations/:id/carriers/:carrierId/badges',
  '/organizations/:id/carriers/:carrierId/badges/:badgeId',
  '/organizations/:id/carriers/:carrierId/badges/:badgeId/check',
] as const

type Scope = { db: Db; organizationId: string }

async function loadScope(c: Context<AppEnv>): Promise<Scope | Response> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)
  const organizationId = c.req.param('id') as string
  const denied = await assertCanManageOr403(c, 'organization', organizationId)
  if (denied) return denied
  if (!isUuid(organizationId)) return c.json({ error: 'Not found' }, 404)
  return { db, organizationId }
}

function invalid(c: Context<AppEnv>, error: string, field: string, detail: string): Response {
  return c.json({ error, field, detail }, 400)
}

async function audit(
  c: Context<AppEnv>,
  scope: Scope,
  action: 'carrier.create' | 'carrier.delete' | 'badge.create' | 'badge.check' | 'badge.delete',
  targetId: string,
  context: Record<string, unknown>
) {
  const session = c.get('session')
  await recordAudit(scope.db, {
    organizationId: scope.organizationId,
    actorUserId: session?.userId ?? null,
    actorEmail: session?.email ?? null,
    action,
    targetType: 'organization',
    targetId,
    context,
  })
}

async function loadCarrierParam(c: Context<AppEnv>, scope: Scope): Promise<CarrierRow | Response> {
  const carrierId = c.req.param('carrierId') as string
  if (!isUuid(carrierId)) return c.json({ error: 'Not found' }, 404)
  return (
    (await findCarrier(scope.db, scope.organizationId, carrierId)) ??
    c.json({ error: 'Not found' }, 404)
  )
}

async function loadBadgeParam(
  c: Context<AppEnv>,
  scope: Scope,
  carrier: CarrierRow
): Promise<BadgeRow | Response> {
  const badgeId = c.req.param('badgeId') as string
  if (!isUuid(badgeId)) return c.json({ error: 'Not found' }, 404)
  return (await findBadge(scope.db, carrier.id, badgeId)) ?? c.json({ error: 'Not found' }, 404)
}

/** The plain-words reply for a provider failure; the message is already scrubbed. */
function providerFailure(c: Context<AppEnv>, err: TunnelProviderError): Response {
  if (err.code === 'unauthorized') {
    return c.json(
      { error: 'badge_rejected', message: 'The provider did not accept this token.' },
      400
    )
  }
  return c.json({ error: 'provider_unavailable', message: err.message }, 502)
}

/** Run a check against the provider; a provider failure becomes a response. */
async function runCheck(
  c: Context<AppEnv>,
  registry: TunnelAdapterRegistry,
  provider: TunnelProvider,
  token: string,
  accountId: string | null
): Promise<CredentialReport | Response> {
  try {
    return await registry(provider).checkCredential(token, { accountId })
  } catch (err) {
    if (err instanceof TunnelProviderError) return providerFailure(c, err)
    throw err
  }
}

function checkSummary(report: CredentialReport) {
  return { zones: report.zones, missing: report.missing }
}

async function listResponse(c: Context<AppEnv>, scope: Scope): Promise<Response> {
  const rows = await listCarriers(scope.db, scope.organizationId)
  return c.json({ carriers: rows.map((r) => toApiCarrier(r.carrier, r.badges)) })
}

async function createCarrierResponse(c: Context<AppEnv>, scope: Scope): Promise<Response> {
  const body = await parseJsonBody(c)
  if (body instanceof Response) return body
  const parsed = parseCarrierBody(body)
  if (!parsed.ok) return invalid(c, 'carrier_invalid', parsed.field, parsed.detail)
  if ((await listCarriers(scope.db, scope.organizationId)).length >= MAX_CARRIERS_PER_ORG) {
    return c.json({ error: 'carrier_limit', limit: MAX_CARRIERS_PER_ORG }, 409)
  }
  try {
    const row = await insertCarrier(scope.db, {
      organizationId: scope.organizationId,
      ...parsed.value,
    })
    await audit(c, scope, 'carrier.create', row.id, {
      provider: row.provider,
      name: row.name,
    })
    return c.json({ carrier: toApiCarrier(row, []) }, 201)
  } catch (err) {
    if (isPostgresUniqueViolation(err)) return c.json({ error: 'carrier_exists' }, 409)
    throw err
  }
}

async function deleteCarrierResponse(c: Context<AppEnv>, scope: Scope): Promise<Response> {
  const current = await loadCarrierParam(c, scope)
  if (current instanceof Response) return current
  if (await carrierHasTunnels(scope.db, current.id)) return carrierInUse(c)
  try {
    await deleteCarrier(scope.db, current)
  } catch (err) {
    // A tunnel still uses this account: the foreign key refuses the delete.
    if (isForeignKeyViolation(err)) return carrierInUse(c)
    throw err
  }
  await audit(c, scope, 'carrier.delete', current.id, {
    provider: current.provider,
    name: current.name,
  })
  return c.json({ ok: true })
}

function carrierInUse(c: Context<AppEnv>): Response {
  return c.json(
    { error: 'carrier_in_use', message: 'This Carrier still has Tunnels. Remove them first.' },
    409
  )
}

async function listBadgesResponse(c: Context<AppEnv>, scope: Scope): Promise<Response> {
  const current = await loadCarrierParam(c, scope)
  if (current instanceof Response) return current
  return c.json({ badges: (await listBadges(scope.db, current.id)).map(toApiBadge) })
}

function accountMismatch(c: Context<AppEnv>): Response {
  return c.json(
    {
      error: 'badge_wrong_account',
      message: 'This token cannot see the account this connection is for.',
    },
    400
  )
}

function notUseful(c: Context<AppEnv>, report: CredentialReport): Response {
  return c.json(
    {
      error: 'badge_not_useful',
      message: `This token cannot be used. It needs: ${report.missing.join(', ')}.`,
      missing: report.missing,
    },
    400
  )
}

function createBadgeResponse(registry: TunnelAdapterRegistry) {
  return async (c: Context<AppEnv>, scope: Scope): Promise<Response> => {
    const current = await loadCarrierParam(c, scope)
    if (current instanceof Response) return current
    const body = await parseJsonBody(c)
    if (body instanceof Response) return body
    const parsed = parseBadgeBody(body)
    if (!parsed.ok) return invalid(c, 'badge_invalid', parsed.field, parsed.detail)
    const secrets = c.get('dataEncryptionSecrets')
    if (!secrets) return c.json({ error: 'secrets_unavailable' }, 503)
    if ((await listBadges(scope.db, current.id)).length >= MAX_BADGES_PER_CARRIER) {
      return c.json({ error: 'badge_limit', limit: MAX_BADGES_PER_CARRIER }, 409)
    }
    const { label, token } = parsed.value
    const report = await runCheck(
      c,
      registry,
      current.provider as TunnelProvider,
      token,
      current.externalAccountId
    )
    if (report instanceof Response) return report
    if (!report.accountVisible) return accountMismatch(c)
    if (!isUsefulReport(report)) return notUseful(c, report)
    const row = await insertBadge(scope.db, {
      organizationId: scope.organizationId,
      carrier: current,
      label,
      sealed: await sealToken(secrets, token),
      lastFour: token.slice(-4),
      report,
    })
    await audit(c, scope, 'badge.create', row.id, {
      carrierId: current.id,
      label,
      capabilities: report.capabilities,
    })
    return c.json({ badge: toApiBadge(row), ...checkSummary(report) }, 201)
  }
}

function checkBadgeResponse(registry: TunnelAdapterRegistry) {
  return async (c: Context<AppEnv>, scope: Scope): Promise<Response> => {
    const current = await loadCarrierParam(c, scope)
    if (current instanceof Response) return current
    const row = await loadBadgeParam(c, scope, current)
    if (row instanceof Response) return row
    const secrets = c.get('dataEncryptionSecrets')
    if (!secrets) return c.json({ error: 'secrets_unavailable' }, 503)
    const token = await openBadgeToken(scope.db, secrets, row)
    if (token === null) return c.json({ error: 'Not found' }, 404)
    let report: CredentialReport | null = null
    try {
      report = await registry(current.provider as TunnelProvider).checkCredential(token, {
        accountId: current.externalAccountId,
      })
    } catch (err) {
      if (!(err instanceof TunnelProviderError)) throw err
      // A provider that is down says nothing about the token; a refusal does.
      if (err.code !== 'unauthorized') return providerFailure(c, err)
    }
    const useful = report !== null && report.accountVisible && isUsefulReport(report)
    const updated = await recordBadgeCheck(scope.db, row, {
      capabilities: report?.capabilities ?? NO_CAPABILITIES,
      status: useful ? 'active' : 'attention',
    })
    await audit(c, scope, 'badge.check', row.id, { carrierId: current.id, ok: useful })
    return c.json({
      badge: toApiBadge(updated),
      ok: useful,
      ...(report ? checkSummary(report) : { zones: [], missing: [] }),
    })
  }
}

async function deleteBadgeResponse(c: Context<AppEnv>, scope: Scope): Promise<Response> {
  const current = await loadCarrierParam(c, scope)
  if (current instanceof Response) return current
  const row = await loadBadgeParam(c, scope, current)
  if (row instanceof Response) return row
  await deleteBadge(scope.db, row)
  await audit(c, scope, 'badge.delete', row.id, { carrierId: current.id, label: row.label })
  return c.json({ ok: true })
}

/** `fetchImpl` lets tests stand in for the provider; production uses the real one. */
export function registerOrganizationCarrierRoutes(
  router: Hono<AppEnv>,
  opts: AuthRouteOpts,
  fetchImpl?: typeof fetch
) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for carrier routes')
  }
  for (const path of CARRIER_PATHS) {
    router.use(path, createSessionMiddleware(opts.secrets))
  }
  const registry = createTunnelAdapterRegistry(fetchImpl)

  const guarded =
    (handler: (c: Context<AppEnv>, scope: Scope) => Promise<Response>) =>
    async (c: Context<AppEnv>) => {
      const scope = await loadScope(c)
      return scope instanceof Response ? scope : await handler(c, scope)
    }

  router.get('/organizations/:id/carriers', guarded(listResponse))
  router.post('/organizations/:id/carriers', guarded(createCarrierResponse))
  router.delete('/organizations/:id/carriers/:carrierId', guarded(deleteCarrierResponse))
  router.get('/organizations/:id/carriers/:carrierId/badges', guarded(listBadgesResponse))
  router.post(
    '/organizations/:id/carriers/:carrierId/badges',
    guarded(createBadgeResponse(registry))
  )
  router.delete(
    '/organizations/:id/carriers/:carrierId/badges/:badgeId',
    guarded(deleteBadgeResponse)
  )
  router.post(
    '/organizations/:id/carriers/:carrierId/badges/:badgeId/check',
    guarded(checkBadgeResponse(registry))
  )
}
