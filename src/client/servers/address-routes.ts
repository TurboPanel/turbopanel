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
 * these entries only say what clients are told to dial. With databases to
 * front, the save is refused up front (503 / 422) when the server cannot be
 * told, like the external access switch. A reconcile that still fails answers
 * 502 with `reason`: `enqueue_failed` (saved; save again or wait for the next
 * listener update) or `prepare_failed` (saved; the listener cannot be rebuilt
 * until its databases' problem is fixed).
 */
import { and, eq } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { nudgeTunnelRoutesFromRequest } from '../organizations/tunnel-nudge.ts'
import { assertCanManageOr403, parseJsonBody } from '../shared.ts'
import { resolveOrgRequest } from '../org-request.ts'
import { assertDispatchInfrastructure } from './command-dispatch.ts'
import type { Db } from '../../db/connection.ts'
import { server } from '../../db/schema.ts'
import { recordAudit } from '../../features/audit/audit-records.ts'
import {
  loadFrontedManagedIds,
  readManagedExternalAccess,
} from '../../features/managed/external-access.ts'
import {
  preflightManagedApplyInfrastructure,
  prepareErrorResponse,
} from '../../features/managed/apply-prepare.ts'
import { enqueueManagedIngressReconcile } from '../../features/managed/ingress-desired.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import {
  loadClientAddressDatacenterPins,
  loadServerClientAddresses,
  saveClientAddressEntries,
} from '../../features/net/client-addresses.ts'
import {
  type ClientAddressPortKey,
  type EffectiveClientAddress,
  mainDatabaseListeners,
  parseClientAddressesBody,
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

function serializeEntry(entry: EffectiveClientAddress, mainFor: readonly ClientAddressPortKey[]) {
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
    main: mainFor.length > 0,
    mainFor,
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

/**
 * `main` / `mainFor` / `addressNeeded` follow the same port rules as the
 * managed detail's endpoints (`mainDatabaseListeners`), so the two screens
 * never disagree about which address fills the main connection string.
 */
function serializeAddresses(addresses: ServerClientAddresses, externalAccess: boolean) {
  const mainFor = mainDatabaseListeners(addresses)
  const anyMain = [...mainFor.values()].some((keys) => keys.length > 0)
  return {
    externalAccess,
    linuxHostname: addresses.linuxHostname,
    addressNeeded: externalAccess && !anyMain,
    addresses: addresses.entries.map((entry) => serializeEntry(entry, mainFor.get(entry) ?? [])),
  }
}

async function loadView(db: Db, serverId: string, options: unknown) {
  const addresses = await loadServerClientAddresses(db, serverId)
  return serializeAddresses(addresses, readManagedExternalAccess(options).enabled)
}

type ListenerPushFailure = 'prepare_failed' | 'enqueue_failed'

/** Queue the ingress reconcile that reissues the listener certificate with the new names. */
async function pushListenerNames(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  serverId: string,
  userId: string
): Promise<'queued' | 'not_needed' | ListenerPushFailure> {
  const secretsConfig = c.get('secretsConfig')
  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  // The preflight already refused a request without these.
  if (!secretsConfig || !dataEncryptionSecrets) return 'prepare_failed'
  const result = await enqueueManagedIngressReconcile(db, commandQueue, {
    serverId,
    actorType: 'user',
    actorId: userId,
    secretsConfig,
    dataEncryptionSecrets,
  })
  return result.ok ? 'queued' : result.reason
}

/** What a 502 tells the operator, honest about whether a later update can succeed. */
function describeFailedPush(label: string, reason: ListenerPushFailure): string {
  if (reason === 'prepare_failed') {
    return `Saved, but the database listener on ${label} could not be rebuilt, so its certificate still has the old names. Every listener update on this server fails the same way until the problem with its databases is fixed; then save again.`
  }
  return `Saved, but ${label} could not be told yet, so its database certificate still has the old names. Save again once the server can take changes; any later update of its database listener also adds them.`
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

    // Refuse before saving when the server cannot be told: no queue, or (with
    // databases to front) no usable daemon key, the external access switch's
    // own preflight.
    const commandQueue = assertDispatchInfrastructure(c)
    if (commandQueue instanceof Response) return commandQueue
    const frontsDatabases = (await loadFrontedManagedIds(loaded.db, loaded.serverId)).length > 0
    if (frontsDatabases) {
      const refusal = await preflightManagedApplyInfrastructure(c, loaded.db, {
        serverId: loaded.serverId,
      })
      if (refusal) return prepareErrorResponse(c, refusal)
    }

    await saveClientAddressEntries(loaded.db, {
      organizationId: loaded.organizationId,
      serverId: loaded.serverId,
      entries,
    })
    await nudgeTunnelRoutesFromRequest(c, loaded.db, loaded.organizationId)
    const outcome = frontsDatabases
      ? await pushListenerNames(c, loaded.db, commandQueue, loaded.serverId, loaded.session.userId)
      : 'not_needed'
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
    if (outcome === 'queued' || outcome === 'not_needed') {
      return c.json({ ok: true, reconcile: outcome, ...view })
    }
    const label = loaded.row.label || loaded.row.hostname || loaded.serverId
    return c.json(
      {
        error: 'ingress_reconcile_failed',
        reason: outcome,
        message: describeFailedPush(label, outcome),
        ...view,
      },
      502
    )
  })
}
