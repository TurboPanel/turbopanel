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
import { forEachSequential } from '../../lib/sequential.ts'
import { isPostgresUniqueViolation } from '../../db/unique-violation.ts'
import { recordAudit } from '../../features/audit/audit-records.ts'
import type { CredentialReport, TokenDiscovery } from '../../features/tunnels/adapter.ts'
import { TunnelProviderError } from '../../features/tunnels/errors.ts'
import {
  type BadgeRow,
  type ApiBadge,
  type ApiCarrier,
  type CarrierRow,
  TunnelLimitError,
  carrierHasTunnels,
  deleteBadge,
  deleteCarrier,
  findBadge,
  findBadgeByTokenId,
  findCarrier,
  findCarrierByAccount,
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
import { countOriginCertificatesFrom } from '../../features/tunnels/origin-certificate.ts'
import {
  createTunnelAdapterRegistry,
  type TunnelAdapterRegistry,
} from '../../features/tunnels/registry.ts'
import {
  NO_CAPABILITIES,
  TUNNEL_PROVIDERS,
  type TunnelProvider,
} from '../../features/tunnels/vocabulary.ts'

const CARRIER_PATHS = [
  '/organizations/:id/carriers',
  '/organizations/:id/carriers/connect',
  '/organizations/:id/carriers/:carrierId',
  '/organizations/:id/carriers/:carrierId/badges',
  '/organizations/:id/carriers/:carrierId/badges/:badgeId',
  '/organizations/:id/carriers/:carrierId/badges/:badgeId/check',
] as const

export type Scope = { db: Db; organizationId: string }

export async function loadScope(c: Context<AppEnv>): Promise<Scope | Response> {
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

export async function audit(
  c: Context<AppEnv>,
  scope: Scope,
  action:
    | 'carrier.create'
    | 'carrier.delete'
    | 'badge.create'
    | 'badge.check'
    | 'badge.delete'
    | 'origin_certificate.issue'
    | 'origin_certificate.revoke',
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

export async function loadCarrierParam(
  c: Context<AppEnv>,
  scope: Scope
): Promise<CarrierRow | Response> {
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
export function providerFailure(c: Context<AppEnv>, err: TunnelProviderError): Response {
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
    if (err instanceof TunnelLimitError) return limitReached(c, err)
    throw err
  }
}

async function deleteCarrierResponse(c: Context<AppEnv>, scope: Scope): Promise<Response> {
  const current = await loadCarrierParam(c, scope)
  if (current instanceof Response) return current
  if (await carrierHasTunnels(scope.db, current.id)) return carrierInUse(c)
  if (
    await countOriginCertificatesFrom(scope.db, scope.organizationId, { carrierId: current.id })
  ) {
    return originCertificateInUse(c)
  }
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

/** A certificate issued through this account or token must be removed first, or it could not be revoked. */
function originCertificateInUse(c: Context<AppEnv>): Response {
  return c.json(
    {
      error: 'origin_certificate_in_use',
      message: 'Origin certificates were issued through this. Remove them first.',
    },
    409
  )
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

type Vetted = { report: CredentialReport }

function limitReached(c: Context<AppEnv>, err: TunnelLimitError): Response {
  return c.json({ error: err.error, limit: err.limit }, 409)
}

/**
 * Everything that can refuse a token, before anything is written: the badge
 * limit, the token's shape, the provider check, the account, whether it is
 * useful, and whether this carrier already holds it. `existing` is null when
 * the carrier has not been created yet.
 */
async function vetBadge(
  c: Context<AppEnv>,
  scope: Scope,
  registry: TunnelAdapterRegistry,
  target: { provider: TunnelProvider; accountId: string | null; existing: CarrierRow | null },
  token: string
): Promise<Vetted | Response> {
  if (
    target.existing &&
    (await listBadges(scope.db, target.existing.id)).length >= MAX_BADGES_PER_CARRIER
  ) {
    return c.json({ error: 'badge_limit', limit: MAX_BADGES_PER_CARRIER }, 409)
  }
  const problem = registry(target.provider).tokenShapeProblem(token)
  if (problem) return invalid(c, 'badge_invalid', 'token', problem)
  const report = await runCheck(c, registry, target.provider, token, target.accountId)
  if (report instanceof Response) return report
  if (!report.accountVisible) return accountMismatch(c)
  if (!isUsefulReport(report)) return notUseful(c, report)
  if (
    target.existing &&
    report.token.id &&
    (await findBadgeByTokenId(scope.db, target.existing.id, report.token.id))
  ) {
    return c.json(
      { error: 'badge_exists', message: 'This API Token is already added to this Carrier.' },
      409
    )
  }
  return { report }
}

/** Seal and store a vetted token on a carrier. */
async function storeBadge(
  c: Context<AppEnv>,
  scope: Scope,
  current: CarrierRow,
  input: { label: string; token: string },
  report: CredentialReport
): Promise<BadgeRow | Response> {
  const secrets = c.get('dataEncryptionSecrets')
  if (!secrets) return c.json({ error: 'secrets_unavailable' }, 503)
  let row: BadgeRow
  try {
    row = await insertBadge(scope.db, {
      organizationId: scope.organizationId,
      carrier: current,
      label: input.label,
      sealed: await sealToken(secrets, input.token),
      lastFour: input.token.slice(-4),
      report,
    })
  } catch (err) {
    if (err instanceof TunnelLimitError) return limitReached(c, err)
    throw err
  }
  await audit(c, scope, 'badge.create', row.id, {
    carrierId: current.id,
    label: input.label,
    kind: report.token.kind,
    capabilities: report.capabilities,
  })
  return row
}

function createBadgeResponse(registry: TunnelAdapterRegistry) {
  return async (c: Context<AppEnv>, scope: Scope): Promise<Response> => {
    const current = await loadCarrierParam(c, scope)
    if (current instanceof Response) return current
    const body = await parseJsonBody(c)
    if (body instanceof Response) return body
    const parsed = parseBadgeBody(body)
    if (!parsed.ok) return invalid(c, 'badge_invalid', parsed.field, parsed.detail)
    if (!c.get('dataEncryptionSecrets')) return c.json({ error: 'secrets_unavailable' }, 503)
    const vetted = await vetBadge(
      c,
      scope,
      registry,
      {
        provider: current.provider as TunnelProvider,
        accountId: current.externalAccountId,
        existing: current,
      },
      parsed.value.token
    )
    if (vetted instanceof Response) return vetted
    const row = await storeBadge(c, scope, current, parsed.value, vetted.report)
    if (row instanceof Response) return row
    return c.json({ badge: toApiBadge(row), ...checkSummary(vetted.report) }, 201)
  }
}

/** The accounts to connect: the ones asked for, or the only one there is. */
function pickAccounts(
  c: Context<AppEnv>,
  accounts: readonly { id: string; name: string }[],
  asked: unknown
): { id: string; name: string }[] | Response {
  if (accounts.length === 0) {
    return invalid(
      c,
      'account_required',
      'accountIds',
      'The provider listed no accounts for this API Token. Add the Cloudflare Account by its id first, then add the token to it.'
    )
  }
  if (asked === undefined) {
    if (accounts.length === 1) return [...accounts]
    return c.json(
      {
        error: 'account_choice_needed',
        message: 'This API Token reaches more than one account. Choose which to connect.',
        accounts,
      },
      409
    )
  }
  const ids = Array.isArray(asked) ? asked : []
  const chosen = accounts.filter((a) => ids.includes(a.id))
  if (ids.length === 0 || chosen.length !== new Set(ids).size) {
    return invalid(c, 'account_invalid', 'accountIds', 'Choose accounts this API Token can reach')
  }
  return chosen
}

/**
 * The person pastes only the API token: the panel lists the accounts it
 * reaches and connects the chosen one(s) (the only one, when there is exactly
 * one). Each account gets its own carrier (created if missing) and its own
 * separately sealed copy of the token.
 */
function connectResponse(registry: TunnelAdapterRegistry) {
  return async (c: Context<AppEnv>, scope: Scope): Promise<Response> => {
    const body = await parseJsonBody(c)
    if (body instanceof Response) return body
    const provider = TUNNEL_PROVIDERS.find((p) => p === body.provider)
    const parsed = parseBadgeBody(body)
    if (!provider) return invalid(c, 'carrier_invalid', 'provider', 'Choose a known provider')
    if (!parsed.ok) return invalid(c, 'badge_invalid', parsed.field, parsed.detail)
    const adapter = registry(provider)
    const problem = adapter.tokenShapeProblem(parsed.value.token)
    if (problem) return invalid(c, 'badge_invalid', 'token', problem)
    let found: TokenDiscovery
    try {
      found = await adapter.discoverAccounts(parsed.value.token)
    } catch (err) {
      if (err instanceof TunnelProviderError) return providerFailure(c, err)
      throw err
    }
    const accounts = pickAccounts(c, found.accounts, body.accountIds)
    if (accounts instanceof Response) return accounts
    if (!c.get('dataEncryptionSecrets')) return c.json({ error: 'secrets_unavailable' }, 503)
    // Vet every account first: a refused token creates nothing, and a partly
    // refused list creates nothing at all.
    const vetted: { account: { id: string; name: string }; report: CredentialReport }[] = []
    for (const account of accounts) {
      const existing = await findCarrierByAccount(
        scope.db,
        scope.organizationId,
        provider,
        account.id
      )
      const result = await vetBadge(
        c,
        scope,
        registry,
        { provider, accountId: account.id, existing },
        parsed.value.token
      )
      if (result instanceof Response) return result
      vetted.push({ account, report: result.report })
    }
    return await connectVetted(c, scope, provider, parsed.value, vetted)
  }
}

type ConnectResult = { carrier: ApiCarrier; badge: ApiBadge; zones: unknown; missing: string[] }

/**
 * Write the vetted accounts. Each carrier and its badge are stored separately,
 * so if a write fails part-way the carriers this call created are removed again
 * (an account that already had a carrier keeps it, and keeps any badge added
 * before the failure).
 */
async function connectVetted(
  c: Context<AppEnv>,
  scope: Scope,
  provider: TunnelProvider,
  input: { label: string; token: string },
  vetted: { account: { id: string; name: string }; report: CredentialReport }[]
): Promise<Response> {
  const created: CarrierRow[] = []
  const results: ConnectResult[] = []
  try {
    for (const { account, report } of vetted) {
      let current = await findCarrierByAccount(scope.db, scope.organizationId, provider, account.id)
      if (!current) {
        current = await ensureCarrier(scope, provider, account)
        created.push(current)
      }
      const row = await storeBadge(c, scope, current, input, report)
      if (row instanceof Response) {
        await removeEmptyCarriers(scope, created)
        return row
      }
      results.push({
        carrier: toApiCarrier({ ...current, status: 'active' }, []),
        badge: toApiBadge(row),
        ...checkSummary(report),
      })
    }
  } catch (err) {
    await removeEmptyCarriers(scope, created)
    if (err instanceof TunnelLimitError) return limitReached(c, err)
    throw err
  }
  return c.json({ connected: results }, 201)
}

/** Remove carriers this call created that ended up with no badge. */
async function removeEmptyCarriers(scope: Scope, carriers: readonly CarrierRow[]): Promise<void> {
  await forEachSequential(carriers, async (row) => {
    if ((await listBadges(scope.db, row.id)).length === 0) await deleteCarrier(scope.db, row)
  })
}

async function ensureCarrier(
  scope: Scope,
  provider: TunnelProvider,
  account: { id: string; name: string }
): Promise<CarrierRow> {
  return await insertCarrier(scope.db, {
    organizationId: scope.organizationId,
    provider,
    name: account.name.trim().slice(0, 64) || account.id,
    externalAccountId: account.id,
  })
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
      token: report?.token,
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
  if (await countOriginCertificatesFrom(scope.db, scope.organizationId, { badgeId: row.id })) {
    return originCertificateInUse(c)
  }
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
  router.post('/organizations/:id/carriers/connect', guarded(connectResponse(registry)))
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
