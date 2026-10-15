/**
 * "Addresses clients use" for one server (owners and managers):
 *
 * - `GET /servers/:id/addresses` — the public side and every datacenter the
 *   server belongs to, each with what the operator saved and what the panel
 *   will use (`features/net/client-addresses.ts`).
 * - `PUT /servers/:id/addresses` — replace the saved entries, then queue the
 *   ingress reconcile so the database certificate is reissued with the new
 *   names and addresses.
 *
 * The server's "allow external access" switch stays the only on/off control;
 * these entries only say what clients are told to dial. A reconcile that could
 * not be queued answers 502: the entries are saved and reach the certificate
 * the next time the server's database listener is updated.
 */
import { and, eq } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { assertCanManageOr403, parseJsonBody } from '../shared.ts'
import { resolveOrgRequest } from '../org-request.ts'
import { assertDispatchInfrastructure } from './command-dispatch.ts'
import type { Db } from '../../db/connection.ts'
import { server } from '../../db/schema.ts'
import { recordAudit } from '../../features/audit/audit-records.ts'
import {
  enqueueManagedExternalAccessReconcile,
  readManagedExternalAccess,
} from '../../features/managed/external-access.ts'
import {
  loadClientAddressDatacenterPins,
  loadServerClientAddresses,
  saveClientAddressEntries,
} from '../../features/net/client-addresses.ts'
import {
  type EffectiveClientAddress,
  mainClientAddressHost,
  parseClientAddressesBody,
  pickMainClientAddress,
  type ServerClientAddresses,
} from '../../features/net/client-addresses-pure.ts'

/** The server in the caller's organization, manage-gated: another org's server is 404. */
async function loadManagedServer(c: Context<AppEnv>) {
  const scope = await resolveOrgRequest(c)
  if (scope instanceof Response) return scope
  const serverId = c.req.param('id') ?? ''
  const [row] = await scope.db
    .select({ label: server.name, hostname: server.hostname, options: server.options })
    .from(server)
    .where(and(eq(server.id, serverId), eq(server.organizationId, scope.organizationId)))
    .limit(1)
  if (!row) return c.json({ error: 'Not found' }, 404)
  const denied = await assertCanManageOr403(c, 'server', serverId)
  if (denied) return denied
  return { ...scope, serverId, row }
}

function serializeEntry(entry: EffectiveClientAddress, main: boolean) {
  return {
    scope: entry.scope,
    datacenterId: entry.datacenterId,
    label: entry.label,
    saved: entry.saved,
    hostname: entry.hostname,
    addressV4: entry.addressV4,
    addressV6: entry.addressV6,
    ports: entry.ports,
    primary: entry.primary,
    main,
    effective: {
      v4: entry.effectiveV4,
      v4Source: entry.effectiveV4Source,
      v6: entry.effectiveV6,
      v6Source: entry.effectiveV6Source,
      host: entry.host,
      hostSource: entry.hostSource,
    },
  }
}

function serializeAddresses(addresses: ServerClientAddresses, externalAccess: boolean) {
  const main = pickMainClientAddress(
    addresses.entries.filter((entry) => entry.host !== null),
    (entry) => entry
  )
  return {
    externalAccess,
    linuxHostname: addresses.linuxHostname,
    addressNeeded: externalAccess && mainClientAddressHost(addresses) === null,
    addresses: addresses.entries.map((entry) => serializeEntry(entry, entry === main)),
  }
}

async function loadView(db: Db, serverId: string, options: unknown) {
  const addresses = await loadServerClientAddresses(db, serverId)
  return serializeAddresses(addresses, readManagedExternalAccess(options).enabled)
}

export function registerServerAddressRoutes(router: Hono<AppEnv>) {
  router.get('/servers/:id/addresses', async (c) => {
    const loaded = await loadManagedServer(c)
    if (loaded instanceof Response) return loaded
    return c.json(await loadView(loaded.db, loaded.serverId, loaded.row.options))
  })

  router.put('/servers/:id/addresses', async (c) => {
    const loaded = await loadManagedServer(c)
    if (loaded instanceof Response) return loaded
    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const pins = await loadClientAddressDatacenterPins(loaded.db, loaded.serverId)
    const entries = parseClientAddressesBody(body, new Set(pins.map((pin) => pin.datacenterId)))
    if ('error' in entries) return c.json(entries, 400)

    // Refuse before saving when the server cannot be told.
    const commandQueue = assertDispatchInfrastructure(c)
    if (commandQueue instanceof Response) return commandQueue

    await saveClientAddressEntries(loaded.db, {
      organizationId: loaded.organizationId,
      serverId: loaded.serverId,
      entries,
    })
    const outcome = await enqueueManagedExternalAccessReconcile(c, loaded.db, commandQueue, {
      serverId: loaded.serverId,
      userId: loaded.session.userId,
    })
    await recordAudit(loaded.db, {
      organizationId: loaded.organizationId,
      actorUserId: loaded.session.userId,
      actorEmail: loaded.session.email ?? null,
      action: 'server.addresses.set',
      targetType: 'server',
      targetId: loaded.serverId,
      context: {
        count: entries.length,
        hostnames: entries.flatMap((entry) => (entry.hostname ? [entry.hostname] : [])),
      },
    })
    const view = await loadView(loaded.db, loaded.serverId, loaded.row.options)
    if (outcome === 'failed') {
      const label = loaded.row.label || loaded.row.hostname || loaded.serverId
      return c.json(
        {
          error: 'ingress_reconcile_failed',
          message: `Saved, but ${label} could not be told yet, so its database certificate still has the old names. They are added the next time its database listener is updated.`,
          ...view,
        },
        502
      )
    }
    return c.json({ ok: true, reconcile: outcome, ...view })
  })
}
