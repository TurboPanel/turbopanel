/**
 * Tunnel records and the writes around them: create and delete a tunnel,
 * change where it runs, add and remove the hostnames (doorways) it carries.
 * The provider is only reached through an adapter and a token opened here for
 * the call; nothing here returns a token.
 */
import { and, asc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import {
  datacenter,
  doorway,
  hostname as hostnameTable,
  hosting,
  ip,
  portal,
  secret,
  server,
  tunnel,
} from '../../db/schema.ts'
import { isValidHostname } from '../../contracts/commands/hostname.ts'
import { isUniqueViolationOn } from '../../db/unique-violation.ts'
import { decryptSecret, encryptSecret } from '../../lib/secrets/data-encryption.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import { hostingIdsOfOrganization } from './hosting-scope.ts'
import { compareText } from './order.ts'
import { type VerifyState, tunnelVerifyState, verifyOriginHostnames } from './verify-state.ts'
import { retireUnusedOriginCertificates } from './origin-certificate.ts'
import { parseServerOptions } from '../servers/server-metadata.ts'
import type { TunnelAdapter } from './adapter.ts'
import {
  BadgeRefused,
  BadgeUnavailable,
  needZoneName,
  openBestBadge,
  useBadges,
} from './badge-use.ts'
import { TunnelProviderError } from './errors.ts'
import {
  type PlacementInput,
  placementWarnings,
  resolveCarryingServers,
  type PortalFact,
} from './placement.ts'
import {
  deleteTunnelRecord,
  findStoredZone,
  listBadges,
  pickBadges,
  type BadgeNeed,
  type CarrierRow,
  type Parsed,
} from './records.ts'
import { RUN_SECRET_PROVIDER, type TunnelPlacement } from './vocabulary.ts'

export type TunnelRow = typeof tunnel.$inferSelect
export type PortalRow = typeof portal.$inferSelect
export type DoorwayRow = typeof doorway.$inferSelect

/** A refusal with a stable code the route turns into a status. */
export class TunnelRefusal extends Error {
  readonly code: string
  readonly status: 400 | 404 | 409 | 502
  constructor(code: string, status: 400 | 404 | 409 | 502, message: string) {
    super(message)
    this.name = 'TunnelRefusal'
    this.code = code
    this.status = status
  }
}

export const MAX_TUNNELS_PER_ORG = 50
export const MAX_DOORWAYS_PER_TUNNEL = 200
/** One server's table holds at most this many names (the daemon's contract cap), so an organization stays under it. */
export const MAX_DOORWAYS_PER_ORG = 2000

export type ApiPortal = {
  serverId: string
  wanted: string
  reported: string
  lastSeenAt: string | null
  lastError: string | null
  connectorVersion: string | null
}

export type ApiTunnel = {
  id: string
  name: string
  provider: string
  carrierId: string | null
  placement: string
  datacenterId: string | null
  status: string
  createdAt: string
  portals: ApiPortal[]
  /** Servers that run a connector right now, from the placement rules. */
  carryingServerIds: string[]
  warnings: string[]
  doorwayCount: number
  /** The verified connection to the web server: asked for, in effect, and which names still wait. */
  verifyOrigin: VerifyState
}

export type ApiDoorway = {
  id: string
  tunnelId: string
  hostname: string
  hostingId: string | null
  isLocalOnly: boolean
  status: string
  dns: 'created' | 'none'
  /** A plain-words reason a removal is waiting (for example no API Token can edit its DNS), else null. */
  warning: string | null
  createdAt: string
}

export function toApiDoorway(row: DoorwayRow): ApiDoorway {
  return {
    id: row.id,
    tunnelId: row.tunnelId,
    hostname: row.hostname,
    hostingId: row.hostingId,
    isLocalOnly: row.isLocalOnly,
    status: row.status,
    dns: row.externalDnsRecordId ? 'created' : 'none',
    warning: doorwayWarning(row),
    createdAt: row.createdAt,
  }
}

function doorwayWarning(row: DoorwayRow): string | null {
  if (row.status !== 'attention') return null
  const warning = (row.metadata as { warning?: unknown } | null)?.warning
  return typeof warning === 'string' ? warning : null
}

// ---------------------------------------------------------------------------
// Reads

/** Servers of the organization that are marked as never carrying tunnels. */
export async function neverCarryingServerIds(db: Db, organizationId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: server.id, options: server.options })
    .from(server)
    .where(eq(server.organizationId, organizationId))
  return new Set(
    rows.filter((r) => parseServerOptions(r.options)?.tunnels?.carry === false).map((r) => r.id)
  )
}

/** Servers that hold an address on the datacenter's network. */
export async function datacenterServerIds(db: Db, datacenterId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ serverId: ip.serverId })
    .from(ip)
    .where(
      and(eq(ip.scope, 'datacenter'), eq(ip.datacenterId, datacenterId), isNotNull(ip.serverId))
    )
  return rows.flatMap((r) => (r.serverId ? [r.serverId] : []))
}

export async function listPortals(db: Db, tunnelId: string): Promise<PortalRow[]> {
  return await db.select().from(portal).where(eq(portal.tunnelId, tunnelId))
}

/** The servers that run a connector for a tunnel right now. */
export async function carryingServers(db: Db, row: TunnelRow): Promise<string[]> {
  // A tunnel being removed runs no connector: they are told to stop before it is deleted.
  if (row.status === 'removing') return []
  const [portals, never, inDatacenter] = await Promise.all([
    listPortals(db, row.id),
    neverCarryingServerIds(db, row.organizationId),
    row.placement === 'all' && row.datacenterId
      ? datacenterServerIds(db, row.datacenterId)
      : Promise.resolve([] as string[]),
  ])
  return resolveCarryingServers({
    placement: row.placement as TunnelPlacement,
    portals: portals.map((p) => ({ serverId: p.serverId, wanted: p.wanted as 'run' | 'skip' })),
    datacenterServerIds: inDatacenter,
    neverServerIds: never,
  })
}

export async function toApiTunnel(db: Db, row: TunnelRow): Promise<ApiTunnel> {
  const [portals, carrying, doorways, verify] = await Promise.all([
    listPortals(db, row.id),
    carryingServers(db, row),
    db.select({ id: doorway.id }).from(doorway).where(eq(doorway.tunnelId, row.id)),
    tunnelVerifyState(db, row),
  ])
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    carrierId: row.carrierId,
    placement: row.placement,
    datacenterId: row.datacenterId,
    status: row.status,
    createdAt: row.createdAt,
    portals: portals.map((p) => ({
      serverId: p.serverId,
      wanted: p.wanted,
      reported: p.reported,
      lastSeenAt: p.lastSeenAt,
      lastError: p.lastError,
      connectorVersion: p.connectorVersion,
    })),
    carryingServerIds: carrying,
    warnings: [...removalWarnings(row), ...placementWarnings(carrying)],
    doorwayCount: doorways.length,
    verifyOrigin: verify,
  }
}

export async function listTunnels(db: Db, organizationId: string): Promise<TunnelRow[]> {
  return await db
    .select()
    .from(tunnel)
    .where(eq(tunnel.organizationId, organizationId))
    .orderBy(asc(tunnel.name))
}

export async function findTunnel(
  db: Db,
  organizationId: string,
  tunnelId: string
): Promise<TunnelRow | null> {
  const [row] = await db
    .select()
    .from(tunnel)
    .where(and(eq(tunnel.id, tunnelId), eq(tunnel.organizationId, organizationId)))
    .limit(1)
  return row ?? null
}

export async function listDoorways(db: Db, tunnelId: string): Promise<DoorwayRow[]> {
  return await db
    .select()
    .from(doorway)
    .where(eq(doorway.tunnelId, tunnelId))
    .orderBy(asc(doorway.hostname))
}

// ---------------------------------------------------------------------------
// Tokens

/**
 * A refusal the person can act on, from the reason no API Token served a call:
 * none has the right, none covers the zone, or the provider refused every one.
 * `action` finishes "can ..." for tunnel calls ("create Tunnels").
 */
export function badgeRefusal(err: BadgeUnavailable | BadgeRefused, action: string): TunnelRefusal {
  const need = err.need
  const zone = needZoneName(need)
  if (need.capability === 'tunnels') {
    return new TunnelRefusal(
      'badge_cannot_tunnel',
      409,
      err instanceof BadgeRefused
        ? `The provider refused every API Token that could ${action}. Check that one has Account · Cloudflare Tunnel · Edit.`
        : `No API Token on this Carrier can ${action}`
    )
  }
  const area = need.capability === 'dns' ? 'DNS' : 'certificates'
  const code = need.capability === 'dns' ? 'badge_cannot_dns' : 'badge_cannot_certify'
  if (err instanceof BadgeRefused) {
    return new TunnelRefusal(
      code,
      409,
      `The provider lets an API Token read ${area} for ${zone} but refused to change it. Give that token the edit permission for the zone.`
    )
  }
  return new TunnelRefusal(
    code,
    409,
    err.missing === 'zone'
      ? `No API Token on this Carrier covers ${area} for ${zone}. Add one for that zone, or use Add Zone on an existing token.`
      : `No API Token on this Carrier can edit ${area}. Add one that has the permission.`
  )
}

/** A failed provider call as a refusal: no-token cases get the actionable text, the rest the provider's. */
export function refuse(err: unknown, action: string): unknown {
  if (err instanceof BadgeUnavailable || err instanceof BadgeRefused) {
    return badgeRefusal(err, action)
  }
  return providerRefusal(err)
}

/** Open the run token a tunnel's connectors use. */
export async function openRunToken(
  db: Db,
  secrets: DerivedSecretsConfig,
  row: Pick<TunnelRow, 'secretId'>
): Promise<string | null> {
  if (!row.secretId) return null
  const [stored] = await db
    .select({ secretEnvelope: secret.secretEnvelope })
    .from(secret)
    .where(eq(secret.id, row.secretId))
    .limit(1)
  return stored ? await decryptSecret(secrets, stored.secretEnvelope) : null
}

// ---------------------------------------------------------------------------
// Placement

type PlacementTargets = {
  datacenterId: string | null
  runServerIds: string[]
  skipServerIds: string[]
}

/** Servers must belong to the organization and, for `all`, sit in the datacenter. */
async function checkPlacementTargets(
  db: Db,
  organizationId: string,
  input: PlacementInput,
  datacenterId: string | null
): Promise<PlacementTargets> {
  if (input.placement === 'all' && !datacenterId) {
    throw new TunnelRefusal(
      'datacenter_required',
      400,
      'Choose the datacenter for an all-servers Tunnel'
    )
  }
  const listed = [...input.serverIds, ...input.exceptServerIds]
  if (listed.length > 0) {
    const rows = await db
      .select({ id: server.id })
      .from(server)
      .where(and(eq(server.organizationId, organizationId), inArray(server.id, listed)))
    if (rows.length !== new Set(listed).size) {
      throw new TunnelRefusal('server_invalid', 400, 'Choose servers of this organization')
    }
  }
  if (datacenterId) {
    const [dc] = await db
      .select({ id: datacenter.id })
      .from(datacenter)
      .where(and(eq(datacenter.id, datacenterId), eq(datacenter.organizationId, organizationId)))
      .limit(1)
    if (!dc)
      throw new TunnelRefusal('datacenter_invalid', 400, 'Choose a datacenter of this organization')
    const inDc = new Set(await datacenterServerIds(db, datacenterId))
    if (!listed.every((id) => inDc.has(id))) {
      throw new TunnelRefusal(
        'server_not_in_datacenter',
        400,
        'Every server must be in the Tunnel datacenter'
      )
    }
  }
  const never = await neverCarryingServerIds(db, organizationId)
  if (input.serverIds.some((id) => never.has(id))) {
    throw new TunnelRefusal(
      'server_never_carries',
      409,
      'One of these servers is set to never run Tunnels'
    )
  }
  return {
    datacenterId,
    runServerIds: input.serverIds,
    skipServerIds: input.exceptServerIds,
  }
}

/** Replace a tunnel's portals with the ones the placement asks for. */
async function replacePortals(
  tx: Pick<Db, 'delete' | 'insert'>,
  tunnelId: string,
  targets: PlacementTargets
): Promise<void> {
  await tx.delete(portal).where(eq(portal.tunnelId, tunnelId))
  const rows = [
    ...targets.runServerIds.map((serverId) => ({ tunnelId, serverId, wanted: 'run' })),
    ...targets.skipServerIds.map((serverId) => ({ tunnelId, serverId, wanted: 'skip' })),
  ]
  if (rows.length > 0) await tx.insert(portal).values(rows)
}

export async function updatePlacement(
  db: Db,
  row: TunnelRow,
  input: PlacementInput,
  datacenterId: string | null
): Promise<TunnelRow> {
  assertNotRemoving(row)
  // Same rule as create: only an all-servers tunnel keeps a datacenter.
  const dcId = input.placement === 'all' ? (datacenterId ?? row.datacenterId) : null
  const targets = await checkPlacementTargets(db, row.organizationId, input, dcId)
  return await db.transaction(async (tx) => {
    await replacePortals(tx, row.id, targets)
    const [updated] = await tx
      .update(tunnel)
      .set({ placement: input.placement, datacenterId: dcId })
      .where(eq(tunnel.id, row.id))
      .returning()
    return updated!
  })
}

/**
 * Keep the portals of the `run` side in step with a new `all` coverage: nothing
 * to write, since `all` is read from the datacenter. Exposed for tests of the
 * rule that only `all` picks up new servers.
 */
export function portalFacts(portals: readonly PortalRow[]): PortalFact[] {
  return portals.map((p) => ({ serverId: p.serverId, wanted: p.wanted as 'run' | 'skip' }))
}

// ---------------------------------------------------------------------------
// Create and delete

export type CreateTunnelInput = {
  name: string
  carrier: CarrierRow
  placement: PlacementInput
  datacenterId: string | null
}

export function parseTunnelName(value: unknown): Parsed<string> {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(name)) {
    return {
      ok: false,
      field: 'name',
      detail: 'The name must be 1 to 64 letters, numbers, spaces, dots, dashes or underscores',
    }
  }
  return { ok: true, value: name }
}

/**
 * Create the tunnel at the provider, then store it with its sealed run token and
 * its portals. If the store fails the provider tunnel is removed again, so a
 * failed create leaves nothing behind at either end.
 */
export async function createTunnel(
  db: Db,
  deps: { adapter: TunnelAdapter; secrets: DerivedSecretsConfig },
  input: CreateTunnelInput
): Promise<TunnelRow> {
  const { carrier: owner } = input
  const existing = await listTunnels(db, owner.organizationId)
  if (existing.length >= MAX_TUNNELS_PER_ORG) {
    throw new TunnelRefusal(
      'tunnel_limit',
      409,
      `An organization can have ${MAX_TUNNELS_PER_ORG} Tunnels`
    )
  }
  if (existing.some((t) => t.name === input.name)) {
    throw new TunnelRefusal('tunnel_exists', 409, 'A Tunnel with this name already exists')
  }
  const dcId = input.placement.placement === 'all' ? input.datacenterId : null
  const targets = await checkPlacementTargets(db, owner.organizationId, input.placement, dcId)
  const used = await useBadges(db, deps.secrets, owner.id, { capability: 'tunnels' }, (token) =>
    deps.adapter.createTunnel(token, { accountId: owner.externalAccountId, name: input.name })
  ).catch((err: unknown) => {
    throw refuse(err, 'create Tunnels')
  })
  const created = used.value
  const token = used.token
  try {
    return await db.transaction(async (tx) => {
      const [sealed] = await tx
        .insert(secret)
        .values({
          organizationId: owner.organizationId,
          provider: RUN_SECRET_PROVIDER,
          name: `${input.name} run token`.slice(0, 120),
          secretEnvelope: await encryptSecret(deps.secrets, created.runToken),
        })
        .returning({ id: secret.id })
      const [row] = await tx
        .insert(tunnel)
        .values({
          organizationId: owner.organizationId,
          routingOrganizationId: owner.organizationId,
          carrierId: owner.id,
          provider: owner.provider,
          name: input.name,
          externalId: created.externalId,
          placement: input.placement.placement,
          datacenterId: targets.datacenterId,
          secretId: sealed!.id,
          status: 'pending',
        })
        .returning()
      await replacePortals(tx, row!.id, targets)
      return row!
    })
  } catch (err) {
    await removeAtProviderQuietly(deps.adapter, token, owner, created.externalId)
    if (isUniqueViolationOn(err, 'uniq_tunnel_organization_id_name')) {
      throw new TunnelRefusal('tunnel_exists', 409, 'A Tunnel with this name already exists')
    }
    throw err
  }
}

async function removeAtProviderQuietly(
  adapter: TunnelAdapter,
  token: string,
  owner: CarrierRow,
  externalId: string
): Promise<void> {
  try {
    await adapter.deleteTunnel(token, { accountId: owner.externalAccountId, externalId })
  } catch {
    // The store failed first; the provider tunnel is left for the person to remove by hand.
  }
}

/** A provider failure as a refusal; the message is already scrubbed. */
export function providerRefusal(err: unknown): unknown {
  if (err instanceof TunnelProviderError) {
    if (err.code === 'unauthorized') {
      return new TunnelRefusal('badge_rejected', 400, 'The provider did not accept this API Token.')
    }
    if (err.code === 'zone_not_found') {
      return new TunnelRefusal('zone_not_found', 409, err.message)
    }
    return new TunnelRefusal('provider_unavailable', 502, err.message)
  }
  return err
}

export type RemovalOutcome = 'removed' | 'removing'

/** The wait before the next try, doubling from 30 seconds up to ten minutes. */
export function removalBackoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 10 * 60_000)
}

type RemovalState = { attempts: number; nextAt: string; error: string }

function readRemovalState(metadata: unknown): RemovalState | null {
  const raw = (metadata as { removal?: Partial<RemovalState> } | null)?.removal
  if (
    raw &&
    typeof raw.attempts === 'number' &&
    typeof raw.nextAt === 'string' &&
    typeof raw.error === 'string'
  ) {
    return { attempts: raw.attempts, nextAt: raw.nextAt, error: raw.error }
  }
  return null
}

function removalWarnings(row: Pick<TunnelRow, 'status' | 'metadata'>): string[] {
  if (row.status !== 'removing') return []
  const state = readRemovalState(row.metadata)
  if (state === null) return ['This Tunnel is being removed. Its connectors are stopping first.']
  return [`Removing this Tunnel is waiting: ${state.error}`]
}

async function noteRemovalWaiting(
  db: Db,
  row: Pick<TunnelRow, 'id' | 'metadata'>,
  error: string,
  now: Date
): Promise<void> {
  const attempts = (readRemovalState(row.metadata)?.attempts ?? 0) + 1
  const state: RemovalState = {
    attempts,
    nextAt: new Date(now.getTime() + removalBackoffMs(attempts)).toISOString(),
    error,
  }
  await db
    .update(tunnel)
    .set({
      metadata: sql`jsonb_set(coalesce(${tunnel.metadata}, '{}'::jsonb), '{removal}', ${JSON.stringify(state)}::jsonb)`,
    })
    .where(eq(tunnel.id, row.id))
}

function removalWaitingText(err: unknown): string {
  if (err instanceof BadgeUnavailable) {
    return 'No API Token on this Carrier can remove Tunnels. Add or fix one and it finishes on its own.'
  }
  if (err instanceof BadgeRefused) {
    return 'The provider refused every API Token that could remove Tunnels. Fix their permissions and it finishes on its own.'
  }
  if (err instanceof TunnelProviderError && err.code === 'conflict') {
    return 'Cloudflare still sees a connector for it. The connectors are being stopped and the removal finishes on its own.'
  }
  if (err instanceof TunnelProviderError) return err.message
  return 'The removal could not be finished yet. It is tried again shortly.'
}

/**
 * Finish removing a tunnel that is marked `removing`: delete it at the provider,
 * then here with its sealed run token. The provider refuses (409) while a
 * connector is still connected, and may be out of reach or the token may have
 * changed; none of that loses the tunnel. It stays `removing` with the reason
 * shown, and the sweep tries again after a growing wait. A tunnel the provider
 * no longer has counts as removed.
 */
export async function finishTunnelRemoval(
  db: Db,
  deps: { adapter: TunnelAdapter; secrets: DerivedSecretsConfig },
  row: TunnelRow,
  owner: CarrierRow | null,
  now: Date = new Date()
): Promise<RemovalOutcome> {
  // Never reached the provider: nothing there to take down.
  if (!row.externalId) {
    await deleteTunnelRecord(db, row)
    await retireUnusedCertificatesQuietly(db, row.organizationId)
    return 'removed'
  }
  // A hostname added in the wait would be left routed with a DNS name nobody tracks.
  if ((await listDoorways(db, row.id)).length > 0) {
    await noteRemovalWaiting(
      db,
      row,
      'This Tunnel still carries hostnames. Remove them and the removal finishes on its own.',
      now
    )
    return 'removing'
  }
  if (!owner) {
    await noteRemovalWaiting(
      db,
      row,
      'The provider account of this Tunnel is not connected here. Connect it again, or remove the Tunnel at the provider yourself.',
      now
    )
    return 'removing'
  }
  try {
    await useBadges(db, deps.secrets, owner.id, { capability: 'tunnels' }, async (token) => {
      try {
        await deps.adapter.deleteTunnel(token, {
          accountId: owner.externalAccountId,
          externalId: row.externalId!,
        })
      } catch (err) {
        // Already gone at the provider counts as removed.
        if (!(err instanceof TunnelProviderError && err.code === 'not_found')) throw err
      }
    })
  } catch (err) {
    await noteRemovalWaiting(db, row, removalWaitingText(err), now)
    return 'removing'
  }
  await deleteTunnelRecord(db, row)
  await retireUnusedCertificatesQuietly(db, row.organizationId)
  return 'removed'
}

/**
 * Remove a tunnel: refused while it carries hostnames. A tunnel with a
 * connector somewhere is marked `removing` first, which tells its servers to
 * stop (they leave `carryingServers`); the provider only lets go of a tunnel
 * with no connected connector, so the delete is finished by the sweep. A tunnel
 * with nothing running is deleted at once.
 */
export async function deleteTunnel(
  db: Db,
  deps: { adapter: TunnelAdapter; secrets: DerivedSecretsConfig },
  row: TunnelRow,
  owner: CarrierRow | null
): Promise<RemovalOutcome> {
  if ((await listDoorways(db, row.id)).length > 0) throw tunnelInUse()
  if (!row.externalId) return await finishTunnelRemoval(db, deps, row, owner)
  if (owner && !(await openBestBadge(db, deps.secrets, owner.id, { capability: 'tunnels' }))) {
    throw new TunnelRefusal(
      'badge_cannot_tunnel',
      409,
      'No API Token on this Carrier can remove Tunnels'
    )
  }
  const carrying = await carryingServers(db, row)
  // One guarded statement: it marks the tunnel only if no hostname is on it at
  // this moment, so a hostname added at the same time is refused or refuses us.
  const [marked] = await db
    .update(tunnel)
    .set({ status: 'removing' })
    .where(
      and(
        eq(tunnel.id, row.id),
        ne(tunnel.status, 'removing'),
        sql`NOT EXISTS (SELECT 1 FROM doorway d WHERE d.tunnel_id = ${tunnel.id})`
      )
    )
    .returning()
  const current = marked ?? (row.status === 'removing' ? row : undefined)
  if (current === undefined) throw tunnelInUse()
  if (carrying.length > 0 || !owner) return 'removing'
  return await finishTunnelRemoval(db, deps, current, owner)
}

function tunnelInUse(): TunnelRefusal {
  return new TunnelRefusal(
    'tunnel_in_use',
    409,
    'This Tunnel still carries hostnames. Remove them first.'
  )
}

/** A tunnel being removed takes no new hostnames and no placement change. */
function assertNotRemoving(row: Pick<TunnelRow, 'status'>): void {
  if (row.status === 'removing') {
    throw new TunnelRefusal(
      'tunnel_removing',
      409,
      'This Tunnel is being removed. Use another Tunnel, or wait until it is gone.'
    )
  }
}

// ---------------------------------------------------------------------------
// Doorways

export function parseDoorwayBody(body: Record<string, unknown>): Parsed<{
  hostname: string
  isLocalOnly: boolean
}> {
  const raw = typeof body.hostname === 'string' ? body.hostname.trim().toLowerCase() : ''
  if (!isValidHostname(raw)) {
    return { ok: false, field: 'hostname', detail: 'Enter a valid hostname' }
  }
  if (body.isLocalOnly !== undefined && typeof body.isLocalOnly !== 'boolean') {
    return { ok: false, field: 'isLocalOnly', detail: 'Must be true or false' }
  }
  return { ok: true, value: { hostname: raw, isLocalOnly: body.isLocalOnly !== false } }
}

/**
 * Is the name already on a tunnel of this organization? A name may also be a
 * site hostname (a name can be both a tunnel name and a public name), so only
 * other doorways count.
 */
async function hostnameTaken(db: Db, organizationId: string, name: string): Promise<boolean> {
  const [other] = await db
    .select({ id: doorway.id })
    .from(doorway)
    .where(and(eq(doorway.routingOrganizationId, organizationId), eq(doorway.hostname, name)))
    .limit(1)
  return other !== undefined
}

/**
 * The hosting that already owns this name, if the site was added first. The
 * hosting must really sit in the organization, or the name would tie a tunnel
 * to another organization's site.
 */
async function hostingOfName(db: Db, organizationId: string, name: string): Promise<string | null> {
  const [site] = await db
    .select({ hostingId: hostnameTable.hostingId })
    .from(hostnameTable)
    .innerJoin(hosting, eq(hosting.id, hostnameTable.hostingId))
    .where(
      and(eq(hostnameTable.routingOrganizationId, organizationId), eq(hostnameTable.hostname, name))
    )
    .limit(1)
  if (!site) return null
  const own = await hostingIdsOfOrganization(db, [site.hostingId], organizationId)
  if (!own.has(site.hostingId)) {
    throw new TunnelRefusal(
      'hosting_mismatch',
      409,
      'This hostname belongs to a site of another organization'
    )
  }
  return site.hostingId
}

/** A removal that took the route down and is waiting for a token that can edit the DNS of its zone. */
function routeTakenDown(row: DoorwayRow): boolean {
  return row.status === 'attention' && doorwayWarning(row) !== null
}

export async function routeNames(
  db: Db,
  tunnelId: string,
  extra: string | null
): Promise<string[]> {
  const rows = await listDoorways(db, tunnelId)
  // A hostname waiting in attention for its DNS token has had its route taken down; it stays down.
  const names = rows.filter((r) => !routeTakenDown(r)).map((r) => r.hostname)
  if (extra && !names.includes(extra)) names.push(extra)
  return names.toSorted(compareText)
}

/**
 * Add a hostname to a tunnel. The row is stored first (the unique keys settle
 * races), then the provider is asked to route the name and to create its DNS
 * name. If either call fails the row and any DNS name made are removed again,
 * so a failed add leaves nothing behind. A name may also be a site hostname:
 * the lock is then the person's choice (`isLocalOnly`).
 */
export async function addDoorway(
  db: Db,
  deps: { adapter: TunnelAdapter; secrets: DerivedSecretsConfig },
  row: TunnelRow,
  owner: CarrierRow,
  input: { hostname: string; isLocalOnly: boolean }
): Promise<DoorwayRow> {
  assertNotRemoving(row)
  if (!row.externalId) {
    throw new TunnelRefusal(
      'tunnel_not_ready',
      409,
      'This Tunnel does not exist at the provider yet'
    )
  }
  await assertDoorwayRoom(db, row, input.hostname)
  const tunnelBadge = await openBestBadge(db, deps.secrets, owner.id, { capability: 'tunnels' })
  if (!tunnelBadge) {
    throw new TunnelRefusal(
      'badge_cannot_tunnel',
      409,
      'No API Token on this Carrier can edit Tunnels'
    )
  }
  const account = owner.externalAccountId
  const zone = await findZoneFor(
    db,
    deps.adapter,
    owner.id,
    tunnelBadge.token,
    account,
    input.hostname
  )
  // A zone with no token that can edit its DNS is refused before anything is written.
  if (zone) assertDnsTokenExists(await listBadges(db, owner.id), zone)
  const created = await insertDoorway(
    db,
    row,
    input,
    await hostingOfName(db, row.routingOrganizationId, input.hostname)
  )
  try {
    // A removal that started while this add was running: take the row back before anything is routed.
    const [now] = await db
      .select({ status: tunnel.status })
      .from(tunnel)
      .where(eq(tunnel.id, row.id))
      .limit(1)
    assertNotRemoving({ status: now?.status ?? 'removing' })
    return await publishDoorway(db, deps, { row, owner, account, zone }, created)
  } catch (err) {
    await db.delete(doorway).where(eq(doorway.id, created.id))
    await restoreRoutesQuietly(db, deps, row, owner)
    throw refuse(err, 'edit Tunnels')
  }
}

/** Refuse, with the reason, when no active token reaches DNS for this zone. */
function assertDnsTokenExists(
  badges: Parameters<typeof pickBadges>[0],
  zone: { id: string; name: string }
): void {
  const need: BadgeNeed = { capability: 'dns', zone }
  const picked = pickBadges(badges, need)
  if (picked.missing) throw badgeRefusal(new BadgeUnavailable(need, picked.missing), 'edit DNS')
}

/** The limits and the name check that come before anything is written or sent. */
async function assertDoorwayRoom(db: Db, row: TunnelRow, name: string): Promise<void> {
  if ((await listDoorways(db, row.id)).length >= MAX_DOORWAYS_PER_TUNNEL) {
    throw new TunnelRefusal(
      'doorway_limit',
      409,
      `A Tunnel can carry ${MAX_DOORWAYS_PER_TUNNEL} hostnames`
    )
  }
  if (await hostnameTaken(db, row.routingOrganizationId, name)) {
    throw new TunnelRefusal('hostname_in_use', 409, 'This hostname is already on a Tunnel')
  }
  const held = await db
    .select({ id: doorway.id })
    .from(doorway)
    .where(eq(doorway.routingOrganizationId, row.routingOrganizationId))
  if (held.length >= MAX_DOORWAYS_PER_ORG) {
    throw new TunnelRefusal(
      'doorway_limit',
      409,
      `An organization can carry ${MAX_DOORWAYS_PER_ORG} Tunnel hostnames in all`
    )
  }
}

type PublishPlan = {
  row: TunnelRow
  owner: CarrierRow
  account: string | null
  zone: { id: string; name: string } | null
}

type Deps = { adapter: TunnelAdapter; secrets: DerivedSecretsConfig }

/** Route the name, make its DNS name when a zone holds it, and mark the row live. */
async function publishDoorway(
  db: Db,
  deps: Deps,
  plan: PublishPlan,
  created: DoorwayRow
): Promise<DoorwayRow> {
  const { row, owner, account, zone } = plan
  const hostnames = await routeNames(db, row.id, null)
  const verifyOrigin = (await tunnelVerifyState(db, row)).active
  await useBadges(db, deps.secrets, owner.id, { capability: 'tunnels' }, (token) =>
    deps.adapter.setRoutes(token, {
      accountId: account,
      externalId: row.externalId!,
      hostnames,
      verifyOrigin,
    })
  )
  const dns = zone
    ? await useBadges(db, deps.secrets, owner.id, { capability: 'dns', zone }, (token) =>
        deps.adapter.createDnsName(token, {
          zoneId: zone.id,
          hostname: created.hostname,
          externalId: row.externalId!,
        })
      )
    : null
  const recordId = dns?.value.recordId ?? null
  try {
    const [live] = await db
      .update(doorway)
      .set({
        status: 'live',
        externalDnsRecordId: recordId,
        // The token used is kept for the record only; any token that covers the zone can remove the name later.
        metadata: zone ? { zoneId: zone.id, dnsBadgeId: dns?.badge.id ?? null } : null,
      })
      .where(eq(doorway.id, created.id))
      .returning()
    return live!
  } catch (err) {
    // The DNS name exists but the row could not be kept: take the name away again.
    if (recordId && zone && dns) {
      await deps.adapter.removeDnsName(dns.token, { zoneId: zone.id, recordId }).catch(() => {})
    }
    throw err
  }
}

/**
 * The zone for a hostname: first among the zones the account's active tokens
 * were found (or told) to reach, longest name first; only when none matches
 * is the provider asked, with the tunnel token. A token that cannot list zones
 * is not an error here: the route still works and the person makes the DNS name.
 */
async function findZoneFor(
  db: Db,
  adapter: TunnelAdapter,
  carrierId: string,
  tunnelToken: string,
  accountId: string | null,
  name: string
): Promise<{ id: string; name: string } | null> {
  const stored = findStoredZone(await listBadges(db, carrierId), name)
  if (stored) return stored
  try {
    return await adapter.findZone(tunnelToken, { accountId, hostname: name })
  } catch (err) {
    if (
      err instanceof TunnelProviderError &&
      (err.code === 'zone_not_found' || err.code === 'forbidden')
    ) {
      return null
    }
    throw providerRefusal(err)
  }
}

async function insertDoorway(
  db: Db,
  row: TunnelRow,
  input: { hostname: string; isLocalOnly: boolean },
  hostingId: string | null
): Promise<DoorwayRow> {
  try {
    const [created] = await db
      .insert(doorway)
      .values({
        routingOrganizationId: row.routingOrganizationId,
        tunnelId: row.id,
        hostname: input.hostname,
        hostingId,
        isLocalOnly: input.isLocalOnly,
        status: 'pending',
      })
      .returning()
    return created!
  } catch (err) {
    if (
      isUniqueViolationOn(err, 'uniq_doorway_routing_organization_id_hostname') ||
      isUniqueViolationOn(err, 'uniq_doorway_tunnel_id_hostname')
    ) {
      throw new TunnelRefusal('hostname_in_use', 409, 'This hostname is already on a Tunnel')
    }
    throw err
  }
}

async function restoreRoutesQuietly(
  db: Db,
  deps: Deps,
  row: TunnelRow,
  owner: CarrierRow
): Promise<void> {
  try {
    const hostnames = await routeNames(db, row.id, null)
    const verifyOrigin = (await tunnelVerifyState(db, row)).active
    await useBadges(db, deps.secrets, owner.id, { capability: 'tunnels' }, (token) =>
      deps.adapter.setRoutes(token, {
        accountId: owner.externalAccountId,
        externalId: row.externalId!,
        hostnames,
        verifyOrigin,
      })
    )
  } catch {
    // The next successful change writes the whole set again.
  }
}

/**
 * Remove a hostname from a tunnel: its route, its DNS name, then the row. The
 * tokens are looked up before anything changes. With no token that can edit
 * the zone's DNS the route is still taken down (the name answers nothing) and
 * the row stays in `attention` with the reason, so a retry with a fixed token
 * finishes it.
 */
export async function removeDoorway(
  db: Db,
  deps: Deps,
  row: TunnelRow,
  owner: CarrierRow,
  current: DoorwayRow
): Promise<void> {
  if (!row.externalId) {
    await db.delete(doorway).where(eq(doorway.id, current.id))
    await retireUnusedCertificatesQuietly(db, row.organizationId)
    return
  }
  if (!(await openBestBadge(db, deps.secrets, owner.id, { capability: 'tunnels' }))) {
    throw new TunnelRefusal(
      'badge_cannot_tunnel',
      409,
      'No API Token on this Carrier can edit Tunnels'
    )
  }
  const zoneId = (current.metadata as { zoneId?: string } | null)?.zoneId
  const hasDnsName = Boolean(current.externalDnsRecordId && zoneId)
  try {
    // The route goes first, so a failed DNS removal leaves a name that answers nothing,
    // never a route to a name that is gone; a retry rewrites the same route.
    const remaining = (await routeNames(db, row.id, null)).filter((n) => n !== current.hostname)
    const verifyOrigin = remaining.length > 0 && (await tunnelVerifyState(db, row)).active
    await useBadges(db, deps.secrets, owner.id, { capability: 'tunnels' }, (token) =>
      deps.adapter.setRoutes(token, {
        accountId: owner.externalAccountId,
        externalId: row.externalId!,
        hostnames: remaining,
        verifyOrigin,
      })
    )
  } catch (err) {
    throw refuse(err, 'edit Tunnels')
  }
  if (hasDnsName) await removeDnsNameOrKeep(db, deps, owner, current, zoneId!)
  await db.delete(doorway).where(eq(doorway.id, current.id))
  await retireUnusedCertificatesQuietly(db, row.organizationId)
}

/**
 * A certificate whose last hostname is gone is marked retired (the sweep revokes
 * it once no site pins it). Never fails the removal that triggered it.
 */
async function retireUnusedCertificatesQuietly(db: Db, organizationId: string): Promise<void> {
  try {
    await retireUnusedOriginCertificates(
      db,
      organizationId,
      await verifyOriginHostnames(db, organizationId)
    )
  } catch {
    // The sweep retires it on its next pass.
  }
}

/** Take the DNS name away with any token that covers the zone; if none can, keep the row in `attention` and say why. */
async function removeDnsNameOrKeep(
  db: Db,
  deps: Deps,
  owner: CarrierRow,
  current: DoorwayRow,
  zoneId: string
): Promise<void> {
  const need: BadgeNeed = { capability: 'dns', zone: { id: zoneId } }
  try {
    await useBadges(db, deps.secrets, owner.id, need, (token) =>
      removeDnsNameTolerant(deps.adapter, token, zoneId, current.externalDnsRecordId!)
    )
  } catch (err) {
    if (err instanceof BadgeUnavailable || err instanceof BadgeRefused) {
      const refusal = badgeRefusal(err, 'edit DNS')
      await db
        .update(doorway)
        .set({
          status: 'attention',
          metadata: {
            ...(current.metadata as object | null),
            warning: `The DNS name of ${current.hostname} is still there. ${refusal.message}`,
          },
        })
        .where(eq(doorway.id, current.id))
      throw refusal
    }
    throw providerRefusal(err)
  }
}

/** A DNS name that is already gone counts as removed, so a retry after a half-done removal works. */
async function removeDnsNameTolerant(
  adapter: TunnelAdapter,
  token: string,
  zoneId: string,
  recordId: string
): Promise<void> {
  try {
    await adapter.removeDnsName(token, { zoneId, recordId })
  } catch (err) {
    if (err instanceof TunnelProviderError && err.code === 'not_found') return
    throw err
  }
}
