import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanManageOr403, parseJsonBody } from '../shared.ts'
import { type Db, getDb } from '../../db/connection.ts'
import { isUuid } from '../access/routes-helpers.ts'
import {
  edictConsistencyError,
  type EdictValues,
  formatStoredAddress,
  parseEdictCreate,
  parseEdictPatch,
} from '../../features/firewall/edict-input.ts'
import { parseFirewallPolicyPatch } from '../../features/firewall/policy.ts'
import {
  createEdict,
  deleteEdict,
  type EdictRecord,
  EdictLimitError,
  findEdict,
  listEdicts,
  readBulwark,
  readOrganizationFirewallPolicy,
  serverBelongsToOrganization,
  setBulwarkMode,
  updateEdict,
  updateOrganizationFirewallPolicy,
} from '../../features/firewall/records.ts'
import { FIREWALL_MODES } from '../../features/firewall/vocabulary.ts'

/**
 * Firewall settings for an organization: its policy, the rules its operators
 * typed, and each server's mode. Owners and managers only (the same
 * `organization:manage` check as TurboFabric). Nothing here pushes anything
 * to a host: stage 4 builds and sends the ruleset.
 */

function toEdictApiRow(row: EdictRecord) {
  return {
    id: row.id,
    label: row.label,
    scope: row.scope,
    action: row.action,
    proto: row.proto,
    ports: row.ports,
    sourceKind: row.sourceKind,
    sourceAddresses: row.sourceAddresses.map(formatStoredAddress),
    isEnabled: row.isEnabled,
    serverId: row.serverId,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

type Scope = { db: Db; organizationId: string }

async function loadScope(c: Context<AppEnv>): Promise<Scope | Response> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)
  const organizationId = c.req.param('id') as string
  const denied = await assertCanManageOr403(c, 'organization', organizationId)
  if (denied) return denied
  if (
    !isUuid(organizationId) ||
    (await readOrganizationFirewallPolicy(db, organizationId)) === null
  ) {
    return c.json({ error: 'Not found' }, 404)
  }
  return { db, organizationId }
}

/** The server a request names, only if it belongs to the organization in the URL. */
async function resolveServerId(c: Context<AppEnv>, scope: Scope): Promise<string | Response> {
  const serverId = c.req.param('serverId') as string
  if (
    !isUuid(serverId) ||
    !(await serverBelongsToOrganization(scope.db, scope.organizationId, serverId))
  ) {
    return c.json({ error: 'Not found' }, 404)
  }
  return serverId
}

async function checkRuleServer(
  c: Context<AppEnv>,
  scope: Scope,
  serverId: string | null
): Promise<Response | null> {
  if (serverId === null) return null
  if (
    !isUuid(serverId) ||
    !(await serverBelongsToOrganization(scope.db, scope.organizationId, serverId))
  ) {
    return c.json({ error: 'serverId must be a server of this organization' }, 400)
  }
  return null
}

function mergeEdict(current: EdictRecord, patch: Partial<EdictValues>): EdictValues {
  return {
    label: patch.label ?? current.label,
    scope: patch.scope ?? (current.scope as EdictValues['scope']),
    action: patch.action ?? (current.action as EdictValues['action']),
    proto: patch.proto ?? (current.proto as EdictValues['proto']),
    ports: patch.ports === undefined ? current.ports : patch.ports,
    sourceKind: patch.sourceKind ?? (current.sourceKind as EdictValues['sourceKind']),
    sourceAddresses: patch.sourceAddresses ?? current.sourceAddresses,
    isEnabled: patch.isEnabled ?? current.isEnabled,
    serverId: patch.serverId === undefined ? current.serverId : patch.serverId,
  }
}

async function createEdictResponse(
  c: Context<AppEnv>,
  scope: Scope,
  userId: string
): Promise<Response> {
  const body = await parseJsonBody(c)
  if (body instanceof Response) return body
  const parsed = parseEdictCreate(body)
  if (!parsed.ok) return c.json({ error: 'firewall_rule_invalid', message: parsed.error }, 400)
  const badServer = await checkRuleServer(c, scope, parsed.values.serverId)
  if (badServer) return badServer
  try {
    const row = await createEdict(scope.db, scope.organizationId, userId, parsed.values)
    return c.json({ rule: toEdictApiRow(row) }, 201)
  } catch (err) {
    if (err instanceof EdictLimitError)
      return c.json({ error: 'firewall_rule_limit', message: err.message }, 409)
    throw err
  }
}

async function patchEdictResponse(c: Context<AppEnv>, scope: Scope): Promise<Response> {
  const edictId = c.req.param('edictId') as string
  const current = isUuid(edictId) ? await findEdict(scope.db, scope.organizationId, edictId) : null
  if (!current) return c.json({ error: 'Not found' }, 404)
  const body = await parseJsonBody(c)
  if (body instanceof Response) return body
  const parsed = parseEdictPatch(body)
  if (!parsed.ok) return c.json({ error: 'firewall_rule_invalid', message: parsed.error }, 400)
  const merged = mergeEdict(current, parsed.values)
  const inconsistent = edictConsistencyError(merged)
  if (inconsistent) return c.json({ error: 'firewall_rule_invalid', message: inconsistent }, 400)
  const badServer = await checkRuleServer(c, scope, merged.serverId)
  if (badServer) return badServer
  const row = await updateEdict(scope.db, scope.organizationId, edictId, merged)
  if (!row) return c.json({ error: 'Not found' }, 404)
  return c.json({ rule: toEdictApiRow(row) })
}

async function putPolicyResponse(c: Context<AppEnv>, scope: Scope): Promise<Response> {
  const body = await parseJsonBody(c)
  if (body instanceof Response) return body
  const parsed = parseFirewallPolicyPatch(body)
  if (!parsed.ok) return c.json({ error: 'firewall_policy_invalid', message: parsed.error }, 400)
  const policy = await updateOrganizationFirewallPolicy(
    scope.db,
    scope.organizationId,
    parsed.patch
  )
  if (!policy) return c.json({ error: 'Not found' }, 404)
  return c.json({ policy })
}

async function putModeResponse(c: Context<AppEnv>, scope: Scope): Promise<Response> {
  const serverId = await resolveServerId(c, scope)
  if (serverId instanceof Response) return serverId
  const body = await parseJsonBody(c)
  if (body instanceof Response) return body
  const mode = (body as { mode?: unknown }).mode
  if (typeof mode !== 'string' || !(FIREWALL_MODES as readonly string[]).includes(mode)) {
    return c.json(
      { error: 'firewall_mode_invalid', message: 'mode must be observe, managed or off' },
      400
    )
  }
  return c.json({
    bulwark: await setBulwarkMode(scope.db, serverId, mode as (typeof FIREWALL_MODES)[number]),
  })
}

const FIREWALL_PATHS = [
  '/organizations/:id/firewall',
  '/organizations/:id/firewall/rules',
  '/organizations/:id/firewall/rules/:edictId',
  '/organizations/:id/firewall/servers/:serverId',
] as const

export function registerOrganizationFirewallRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for firewall routes')
  }
  for (const path of FIREWALL_PATHS) {
    router.use(path, createSessionMiddleware(opts.secrets))
  }

  router.get('/organizations/:id/firewall', async (c) => {
    const scope = await loadScope(c)
    if (scope instanceof Response) return scope
    const policy = await readOrganizationFirewallPolicy(scope.db, scope.organizationId)
    return c.json({ policy })
  })

  router.put('/organizations/:id/firewall', async (c) => {
    const scope = await loadScope(c)
    if (scope instanceof Response) return scope
    return await putPolicyResponse(c, scope)
  })

  router.get('/organizations/:id/firewall/rules', async (c) => {
    const scope = await loadScope(c)
    if (scope instanceof Response) return scope
    const rules = await listEdicts(scope.db, scope.organizationId)
    return c.json({ rules: rules.map(toEdictApiRow) })
  })

  router.post('/organizations/:id/firewall/rules', async (c) => {
    const scope = await loadScope(c)
    if (scope instanceof Response) return scope
    return await createEdictResponse(c, scope, c.get('session')!.userId)
  })

  router.patch('/organizations/:id/firewall/rules/:edictId', async (c) => {
    const scope = await loadScope(c)
    if (scope instanceof Response) return scope
    return await patchEdictResponse(c, scope)
  })

  router.delete('/organizations/:id/firewall/rules/:edictId', async (c) => {
    const scope = await loadScope(c)
    if (scope instanceof Response) return scope
    const edictId = c.req.param('edictId') as string
    const deleted = isUuid(edictId) && (await deleteEdict(scope.db, scope.organizationId, edictId))
    return deleted ? c.json({ ok: true }) : c.json({ error: 'Not found' }, 404)
  })

  router.get('/organizations/:id/firewall/servers/:serverId', async (c) => {
    const scope = await loadScope(c)
    if (scope instanceof Response) return scope
    const serverId = await resolveServerId(c, scope)
    if (serverId instanceof Response) return serverId
    return c.json({ bulwark: await readBulwark(scope.db, serverId) })
  })

  router.put('/organizations/:id/firewall/servers/:serverId', async (c) => {
    const scope = await loadScope(c)
    if (scope instanceof Response) return scope
    return await putModeResponse(c, scope)
  })
}
