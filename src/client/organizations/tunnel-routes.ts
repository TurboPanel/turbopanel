/**
 * Tunnels, where they run, and the hostnames they carry. Owners and managers
 * only (`organization:manage`, like provider accounts). A run token is sealed
 * in `secret` and never returned. Provider failures arrive as plain-words
 * errors already scrubbed of tokens.
 */
import type { Context, Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import type { AppEnv } from '../../app/app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { parseJsonBody } from '../shared.ts'
import { isUuid } from '../access/routes-helpers.ts'
import { loadScope, type Scope } from './carrier-routes.ts'
import { server } from '../../db/schema.ts'
import { recordAudit, type AuditAction } from '../../features/audit/audit-records.ts'
import { parseServerOptions } from '../../features/servers/server-metadata.ts'
import {
  addDoorway,
  createTunnel,
  deleteTunnel,
  findTunnel,
  listDoorways,
  listTunnels,
  parseDoorwayBody,
  parseTunnelName,
  removeDoorway,
  toApiDoorway,
  toApiTunnel,
  TunnelRefusal,
  updatePlacement,
  type TunnelRow,
} from '../../features/tunnels/lifecycle.ts'
import { syncOrganizationTunnelConnectors } from '../../features/tunnels/connector-sync.ts'
import { serversWithoutTunnelSupport } from '../../features/tunnels/daemon-gate.ts'
import { parsePlacementBody } from '../../features/tunnels/placement.ts'
import { findCarrier } from '../../features/tunnels/records.ts'
import {
  createTunnelAdapterRegistry,
  type TunnelAdapterRegistry,
} from '../../features/tunnels/registry.ts'
import type { TunnelProvider } from '../../features/tunnels/vocabulary.ts'

const TUNNEL_PATHS = [
  '/organizations/:id/tunnels',
  '/organizations/:id/tunnels/:tunnelId',
  '/organizations/:id/tunnels/:tunnelId/placement',
  '/organizations/:id/tunnels/:tunnelId/hostnames',
  '/organizations/:id/tunnels/:tunnelId/hostnames/:doorwayId',
  '/organizations/:id/servers/:serverId/tunnel-carrying',
] as const

async function audit(
  c: Context<AppEnv>,
  scope: Scope,
  action: AuditAction,
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

function invalid(c: Context<AppEnv>, error: string, field: string, detail: string): Response {
  return c.json({ error, field, detail }, 400)
}

/** A refusal from the lifecycle code as a response; anything else is rethrown. */
function refused(c: Context<AppEnv>, err: unknown): Response {
  if (err instanceof TunnelRefusal) {
    return c.json({ error: err.code, message: err.message }, err.status)
  }
  throw err
}

async function loadTunnelParam(c: Context<AppEnv>, scope: Scope): Promise<TunnelRow | Response> {
  const tunnelId = c.req.param('tunnelId') as string
  if (!isUuid(tunnelId)) return c.json({ error: 'Not found' }, 404)
  return (
    (await findTunnel(scope.db, scope.organizationId, tunnelId)) ??
    c.json({ error: 'Not found' }, 404)
  )
}

/** The tunnel as the API shows it, with a warning for servers whose daemon is too old to carry it. */
async function tunnelWithSupportWarning(scope: Scope, row: TunnelRow) {
  const shown = await toApiTunnel(scope.db, row)
  const old = await serversWithoutTunnelSupport(scope.db, shown.carryingServerIds)
  if (old.length === 0) return shown
  const names = old.length === 1 ? '1 server runs' : `${old.length} servers run`
  return {
    ...shown,
    warnings: [
      ...shown.warnings,
      `${names} a daemon too old to carry Tunnels. Update it, or the Tunnel will not work there.`,
    ],
  }
}

function secretsOrFail(c: Context<AppEnv>) {
  return c.get('dataEncryptionSecrets') ?? null
}

/**
 * Tell the servers right away which connectors to run. The periodic sweep does
 * the same, so a failure here is not an error for the person.
 */
async function nudgeConnectors(c: Context<AppEnv>, scope: Scope): Promise<void> {
  const commandQueue = c.get('commandQueue')
  const secretsConfig = c.get('secretsConfig')
  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  if (!commandQueue || !secretsConfig || !dataEncryptionSecrets) return
  try {
    await syncOrganizationTunnelConnectors(
      scope.db,
      { commandQueue, secretsConfig, dataEncryptionSecrets },
      scope.organizationId
    )
  } catch {
    // The sweep sends the list again.
  }
}

async function listResponse(c: Context<AppEnv>, scope: Scope): Promise<Response> {
  const rows = await listTunnels(scope.db, scope.organizationId)
  const tunnels = await Promise.all(rows.map((row) => tunnelWithSupportWarning(scope, row)))
  return c.json({ tunnels })
}

async function getResponse(c: Context<AppEnv>, scope: Scope): Promise<Response> {
  const row = await loadTunnelParam(c, scope)
  if (row instanceof Response) return row
  return c.json({ tunnel: await tunnelWithSupportWarning(scope, row) })
}

function createResponse(registry: TunnelAdapterRegistry) {
  return async (c: Context<AppEnv>, scope: Scope): Promise<Response> => {
    const body = await parseJsonBody(c)
    if (body instanceof Response) return body
    const secrets = secretsOrFail(c)
    if (!secrets) return c.json({ error: 'secrets_unavailable' }, 503)
    const name = parseTunnelName(body.name)
    if (!name.ok) return invalid(c, 'tunnel_invalid', name.field, name.detail)
    const placement = parsePlacementBody(body)
    if (!placement.ok) return invalid(c, 'tunnel_invalid', placement.field, placement.detail)
    const carrierId = typeof body.carrierId === 'string' ? body.carrierId : ''
    if (!isUuid(carrierId)) return invalid(c, 'tunnel_invalid', 'carrierId', 'Choose a Carrier')
    const owner = await findCarrier(scope.db, scope.organizationId, carrierId)
    if (!owner)
      return invalid(c, 'tunnel_invalid', 'carrierId', 'Choose a Carrier of this organization')
    const datacenterId = typeof body.datacenterId === 'string' ? body.datacenterId : null
    if (datacenterId !== null && !isUuid(datacenterId)) {
      return invalid(c, 'tunnel_invalid', 'datacenterId', 'Choose a datacenter')
    }
    try {
      const row = await createTunnel(
        scope.db,
        { adapter: registry(owner.provider as TunnelProvider), secrets },
        { name: name.value, carrier: owner, placement: placement.value, datacenterId }
      )
      await audit(c, scope, 'tunnel.create', row.id, {
        name: row.name,
        provider: row.provider,
        placement: row.placement,
      })
      await nudgeConnectors(c, scope)
      return c.json({ tunnel: await tunnelWithSupportWarning(scope, row) }, 201)
    } catch (err) {
      return refused(c, err)
    }
  }
}

async function placementResponse(c: Context<AppEnv>, scope: Scope): Promise<Response> {
  const row = await loadTunnelParam(c, scope)
  if (row instanceof Response) return row
  const body = await parseJsonBody(c)
  if (body instanceof Response) return body
  const placement = parsePlacementBody(body)
  if (!placement.ok) return invalid(c, 'tunnel_invalid', placement.field, placement.detail)
  const datacenterId = typeof body.datacenterId === 'string' ? body.datacenterId : null
  if (datacenterId !== null && !isUuid(datacenterId)) {
    return invalid(c, 'tunnel_invalid', 'datacenterId', 'Choose a datacenter')
  }
  try {
    const updated = await updatePlacement(scope.db, row, placement.value, datacenterId)
    await audit(c, scope, 'tunnel.update', row.id, {
      name: row.name,
      placement: updated.placement,
    })
    await nudgeConnectors(c, scope)
    return c.json({ tunnel: await tunnelWithSupportWarning(scope, updated) })
  } catch (err) {
    return refused(c, err)
  }
}

function deleteResponse(registry: TunnelAdapterRegistry) {
  return async (c: Context<AppEnv>, scope: Scope): Promise<Response> => {
    const row = await loadTunnelParam(c, scope)
    if (row instanceof Response) return row
    const secrets = secretsOrFail(c)
    if (!secrets) return c.json({ error: 'secrets_unavailable' }, 503)
    const owner = row.carrierId
      ? await findCarrier(scope.db, scope.organizationId, row.carrierId)
      : null
    let outcome: 'removed' | 'removing'
    try {
      outcome = await deleteTunnel(
        scope.db,
        { adapter: registry(row.provider as TunnelProvider), secrets },
        row,
        owner
      )
    } catch (err) {
      return refused(c, err)
    }
    await audit(c, scope, 'tunnel.delete', row.id, {
      name: row.name,
      provider: row.provider,
      removing: outcome === 'removing',
    })
    await nudgeConnectors(c, scope)
    return c.json({ ok: true, removing: outcome === 'removing' })
  }
}

async function listDoorwaysResponse(c: Context<AppEnv>, scope: Scope): Promise<Response> {
  const row = await loadTunnelParam(c, scope)
  if (row instanceof Response) return row
  return c.json({ hostnames: (await listDoorways(scope.db, row.id)).map(toApiDoorway) })
}

function addDoorwayResponse(registry: TunnelAdapterRegistry) {
  return async (c: Context<AppEnv>, scope: Scope): Promise<Response> => {
    const row = await loadTunnelParam(c, scope)
    if (row instanceof Response) return row
    const body = await parseJsonBody(c)
    if (body instanceof Response) return body
    const parsed = parseDoorwayBody(body)
    if (!parsed.ok) return invalid(c, 'hostname_invalid', parsed.field, parsed.detail)
    const secrets = secretsOrFail(c)
    if (!secrets) return c.json({ error: 'secrets_unavailable' }, 503)
    const owner = row.carrierId
      ? await findCarrier(scope.db, scope.organizationId, row.carrierId)
      : null
    if (!owner) return c.json({ error: 'carrier_missing' }, 409)
    try {
      const created = await addDoorway(
        scope.db,
        { adapter: registry(row.provider as TunnelProvider), secrets },
        row,
        owner,
        parsed.value
      )
      await audit(c, scope, 'doorway.create', created.id, {
        tunnelId: row.id,
        hostname: created.hostname,
        dns: created.externalDnsRecordId ? 'created' : 'none',
      })
      return c.json({ hostname: toApiDoorway(created) }, 201)
    } catch (err) {
      return refused(c, err)
    }
  }
}

function removeDoorwayResponse(registry: TunnelAdapterRegistry) {
  return async (c: Context<AppEnv>, scope: Scope): Promise<Response> => {
    const row = await loadTunnelParam(c, scope)
    if (row instanceof Response) return row
    const doorwayId = c.req.param('doorwayId') as string
    const current = (await listDoorways(scope.db, row.id)).find((d) => d.id === doorwayId)
    if (!current) return c.json({ error: 'Not found' }, 404)
    const secrets = secretsOrFail(c)
    if (!secrets) return c.json({ error: 'secrets_unavailable' }, 503)
    const owner = row.carrierId
      ? await findCarrier(scope.db, scope.organizationId, row.carrierId)
      : null
    if (!owner) return c.json({ error: 'carrier_missing' }, 409)
    try {
      await removeDoorway(
        scope.db,
        { adapter: registry(row.provider as TunnelProvider), secrets },
        row,
        owner,
        current
      )
    } catch (err) {
      return refused(c, err)
    }
    await audit(c, scope, 'doorway.delete', current.id, {
      tunnelId: row.id,
      hostname: current.hostname,
    })
    return c.json({ ok: true })
  }
}

/** "This server never runs Tunnels": stored in the server's options, read by the placement rules. */
async function carryingResponse(c: Context<AppEnv>, scope: Scope): Promise<Response> {
  const serverId = c.req.param('serverId') as string
  if (!isUuid(serverId)) return c.json({ error: 'Not found' }, 404)
  const body = await parseJsonBody(c)
  if (body instanceof Response) return body
  if (typeof body.carry !== 'boolean') {
    return invalid(c, 'carry_invalid', 'carry', 'Must be true or false')
  }
  const [row] = await scope.db
    .select({ options: server.options })
    .from(server)
    .where(and(eq(server.id, serverId), eq(server.organizationId, scope.organizationId)))
    .limit(1)
  if (!row) return c.json({ error: 'Not found' }, 404)
  const options = { ...parseServerOptions(row.options), tunnels: { carry: body.carry } }
  await scope.db
    .update(server)
    .set({ options })
    .where(and(eq(server.id, serverId), eq(server.organizationId, scope.organizationId)))
  await audit(c, scope, 'server.tunnel_carrying', serverId, { carry: body.carry })
  return c.json({ serverId, carry: body.carry })
}

/** `fetchImpl` lets tests stand in for the provider; production uses the real one. */
export function registerOrganizationTunnelRoutes(
  router: Hono<AppEnv>,
  opts: AuthRouteOpts,
  fetchImpl?: typeof fetch
) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for tunnel routes')
  }
  for (const path of TUNNEL_PATHS) {
    router.use(path, createSessionMiddleware(opts.secrets))
  }
  const registry = createTunnelAdapterRegistry(fetchImpl)

  const guarded =
    (handler: (c: Context<AppEnv>, scope: Scope) => Promise<Response>) =>
    async (c: Context<AppEnv>) => {
      const scope = await loadScope(c)
      return scope instanceof Response ? scope : await handler(c, scope)
    }

  router.get('/organizations/:id/tunnels', guarded(listResponse))
  router.post('/organizations/:id/tunnels', guarded(createResponse(registry)))
  router.get('/organizations/:id/tunnels/:tunnelId', guarded(getResponse))
  router.put('/organizations/:id/tunnels/:tunnelId/placement', guarded(placementResponse))
  router.delete('/organizations/:id/tunnels/:tunnelId', guarded(deleteResponse(registry)))
  router.get('/organizations/:id/tunnels/:tunnelId/hostnames', guarded(listDoorwaysResponse))
  router.post(
    '/organizations/:id/tunnels/:tunnelId/hostnames',
    guarded(addDoorwayResponse(registry))
  )
  router.delete(
    '/organizations/:id/tunnels/:tunnelId/hostnames/:doorwayId',
    guarded(removeDoorwayResponse(registry))
  )
  router.put('/organizations/:id/servers/:serverId/tunnel-carrying', guarded(carryingResponse))
}
