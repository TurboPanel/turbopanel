/**
 * DB round trip for the automatic membership repin.
 *
 * Runs as a best-effort follow-up of the change-detected
 * `touchServerMetadata` write (see `src/features/servers/server-registry.ts`) whenever a
 * daemon's reported `resources.ips` moved. It loads the server's pins, asks
 * {@link decideRepinActions} what to do, and writes only `ip.address` /
 * `ip.metadata`:
 *
 * - `repin` → new address + `metadata.repin { at, from }` plus
 *   `ip.repin_pending_fanout_at` (any `stale` flag dropped);
 * - `mark_stale` → `metadata.stale { since, reason }`;
 * - `clear_stale` → `stale` removed;
 * - `link_down` / `link_up` → `metadata.linkDown { since }` set / removed plus
 *   `ip.repin_pending_fanout_at`: the daemon reports each NIC's link state with
 *   its addresses, and routing moves traffic off a network whose link is down
 *   (see `partitionSharedDatacenters` consumers in `private-endpoint.ts`).
 *
 * Nothing is enqueued here: hello / Durable Object handlers must not enqueue
 * commands, so the routing fan-out is deferred to the maintenance sweep
 * (`src/client/datacenters/repin-fanout.ts`), which selects pins by
 * `ip.repin_pending_fanout_at`.
 *
 * The common case — a server with no pins — costs one indexed read. Never
 * throws: a failed write is logged and the rest of the pass continues.
 */

import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { ip } from '../../db/schema.ts'
import { inetAddressToString } from '../../lib/ip-address.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import type { ServerReportedIp } from '../../contracts/server-addresses.ts'
import { isUniqueViolationOn } from '../../db/unique-violation.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import {
  type DatacenterMembershipPinDetailRow,
  loadDatacenterMembershipPinDetailsForServers,
  normalizeReportedPrivateAddresses,
  validateMemberPinAddress,
} from './datacenter-membership.ts'
import {
  clearedLinkDownMetadata,
  clearedStaleMetadata,
  decideLinkActions,
  decideRepinActions,
  type LinkAction,
  parseIpPinMetadata,
  type RepinAction,
  type RepinPinInput,
  type RepinStaleReason,
  withLinkDownMetadata,
  withRepinMetadata,
  withStaleMetadata,
} from './repin.ts'

const LOG_COMPONENT = 'datacenter-repin'

type PinDetail = DatacenterMembershipPinDetailRow & {
  networkId: string
  subnetCidr: string
}

function isRepinablePin(pin: DatacenterMembershipPinDetailRow): pin is PinDetail {
  return pin.networkId !== null && pin.subnetCidr !== null
}

function toRepinInput(pin: PinDetail): RepinPinInput {
  return {
    ipId: pin.ipId,
    serverId: pin.serverId,
    datacenterId: pin.datacenterId,
    networkId: pin.networkId,
    address: pin.address,
    subnetCidr: pin.subnetCidr,
    stale: parseIpPinMetadata(pin.metadata).stale !== undefined,
  }
}

/**
 * Org-wide `ip.address` values among the candidate set. Only the candidates
 * are looked up (`WHERE organization_id = … AND address IN (…)`), never the
 * whole table. The server's own pin addresses are excluded so a pin never
 * blocks itself.
 */
async function loadAddressesInUse(
  db: Db,
  organizationId: string,
  candidates: readonly string[],
  ownPinIds: ReadonlySet<string>
): Promise<Set<string>> {
  const inUse = new Set<string>()
  if (candidates.length === 0) return inUse
  const rows = await db
    .select({ id: ip.id, address: ip.address })
    .from(ip)
    .where(and(eq(ip.organizationId, organizationId), inArray(ip.address, [...candidates])))
  for (const row of rows) {
    if (ownPinIds.has(row.id)) continue
    const address = inetAddressToString(row.address)
    if (address) inUse.add(address)
  }
  return inUse
}

async function writeRepin(
  db: Db,
  pin: PinDetail,
  action: Extract<RepinAction, { kind: 'repin' }>,
  serverMetadata: unknown,
  nowIso: string
): Promise<RepinAction> {
  const validated = validateMemberPinAddress(action.to, pin.subnetCidr, serverMetadata)
  if (!validated.ok) {
    compatLogWarn(
      LOG_COMPONENT,
      `repin ${pin.ipId} ${action.from} -> ${action.to} rejected: ${validated.error}`
    )
    return writeStale(db, pin, 'address_gone_no_candidate', nowIso)
  }
  try {
    const metadata = withRepinMetadata(pin.metadata, {
      at: nowIso,
      from: action.from,
    })
    await db
      .update(ip)
      .set({
        address: validated.address,
        metadata,
        repinPendingFanoutAt: nowIso,
        updatedAt: nowIso,
      })
      .where(eq(ip.id, pin.ipId))
    // Later writes of this pass (link state) build on what is stored now.
    pin.address = validated.address
    pin.metadata = metadata
    return action
  } catch (err) {
    if (!isUniqueViolationOn(err, 'uniq_ip_org_address')) throw err
    // Lost the race for the address (another row claimed it between the
    // in-use lookup and this write). Never abort the pass — flag instead.
    return writeStale(db, pin, 'address_gone_ambiguous', nowIso)
  }
}

async function writeStale(
  db: Db,
  pin: PinDetail,
  reason: RepinStaleReason,
  nowIso: string
): Promise<RepinAction> {
  const metadata = withStaleMetadata(pin.metadata, { since: nowIso, reason })
  await db.update(ip).set({ metadata, updatedAt: nowIso }).where(eq(ip.id, pin.ipId))
  pin.metadata = metadata
  return { kind: 'mark_stale', ipId: pin.ipId, reason }
}

async function writeClearStale(db: Db, pin: PinDetail, nowIso: string): Promise<RepinAction> {
  const metadata = clearedStaleMetadata(pin.metadata)
  await db.update(ip).set({ metadata, updatedAt: nowIso }).where(eq(ip.id, pin.ipId))
  pin.metadata = metadata
  return { kind: 'clear_stale', ipId: pin.ipId }
}

async function applyAction(
  db: Db,
  pin: PinDetail,
  action: RepinAction,
  serverMetadata: unknown,
  nowIso: string
): Promise<RepinAction> {
  switch (action.kind) {
    case 'repin':
      return writeRepin(db, pin, action, serverMetadata, nowIso)
    case 'mark_stale':
      return writeStale(db, pin, action.reason, nowIso)
    case 'clear_stale':
      return writeClearStale(db, pin, nowIso)
  }
}

async function writeLink(
  db: Db,
  pin: DatacenterMembershipPinDetailRow,
  action: LinkAction,
  nowIso: string
): Promise<LinkAction> {
  const metadata =
    action.kind === 'link_down'
      ? withLinkDownMetadata(pin.metadata, { since: nowIso })
      : clearedLinkDownMetadata(pin.metadata)
  await db
    .update(ip)
    .set({ metadata, repinPendingFanoutAt: nowIso, updatedAt: nowIso })
    .where(eq(ip.id, pin.ipId))
  pin.metadata = metadata
  return action
}

/** Repin decisions for the pins that have a subnet; returns what was applied. */
async function runRepinPass(
  db: Db,
  pins: readonly PinDetail[],
  reportedIps: ServerReportedIp[] | null | undefined,
  nowIso: string
): Promise<RepinAction[]> {
  if (pins.length === 0) return []
  const reported = normalizeReportedPrivateAddresses(reportedIps)
  const ownPinIds = new Set(pins.map((pin) => pin.ipId))
  const organizationId = pins[0]?.organizationId
  if (!organizationId) return []
  const addressesInUse = await loadAddressesInUse(db, organizationId, reported, ownPinIds)

  const decided = decideRepinActions({
    pins: pins.map(toRepinInput),
    reportedPrivateAddresses: reported,
    addressesInUse,
  })
  if (decided.length === 0) return []

  const byIpId = new Map(pins.map((pin) => [pin.ipId, pin]))
  const serverMetadata = { resources: { ips: reportedIps ?? [] } }
  const applied: RepinAction[] = []
  await forEachSequential(decided, async (action) => {
    const pin = byIpId.get(action.ipId)
    if (!pin) return
    try {
      applied.push(await applyAction(db, pin, action, serverMetadata, nowIso))
    } catch (err) {
      compatLogWarn(
        LOG_COMPONENT,
        `${action.kind} for pin ${action.ipId} failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  })
  return applied
}

/**
 * Flag / unflag the pins whose NIC link state moved. Runs after the repin
 * pass on the pins' current address and metadata, so a repinned pin is judged
 * on its new address and no earlier write of the pass is overwritten.
 */
async function runLinkPass(
  db: Db,
  pins: readonly DatacenterMembershipPinDetailRow[],
  reportedIps: ServerReportedIp[] | null | undefined,
  nowIso: string
): Promise<LinkAction[]> {
  const decided = decideLinkActions(
    pins.map((pin) => ({
      ipId: pin.ipId,
      address: pin.address,
      linkDown: parseIpPinMetadata(pin.metadata).linkDown !== undefined,
    })),
    reportedIps ?? []
  )
  const byIpId = new Map(pins.map((pin) => [pin.ipId, pin]))
  const applied: LinkAction[] = []
  await forEachSequential(decided, async (action) => {
    const pin = byIpId.get(action.ipId)
    if (!pin) return
    try {
      applied.push(await writeLink(db, pin, action, nowIso))
    } catch (err) {
      compatLogWarn(
        LOG_COMPONENT,
        `${action.kind} for pin ${action.ipId} failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  })
  return applied
}

export type AppliedPinAction = RepinAction | LinkAction

/**
 * Re-point / flag the server's membership pins against its freshly reported
 * addresses, then record each pin's NIC link state. Returns the actions
 * actually applied (a `repin` that lost a unique race comes back as
 * `mark_stale`). Never throws.
 *
 * `reportedIps` is the daemon's full reported list; `validateMemberPinAddress`
 * needs it in `server.metadata` shape, so a `{ resources: { ips } }` view is
 * built for the re-validation step.
 */
export async function applyReportedAddressRepin(
  db: Db,
  serverId: string,
  reportedIps: ServerReportedIp[] | null | undefined
): Promise<AppliedPinAction[]> {
  try {
    const byServer = await loadDatacenterMembershipPinDetailsForServers(db, [serverId])
    const allPins = byServer.get(serverId) ?? []
    if (allPins.length === 0) return []

    const nowIso = new Date().toISOString()
    const repinned = await runRepinPass(db, allPins.filter(isRepinablePin), reportedIps, nowIso)
    const linked = await runLinkPass(db, allPins, reportedIps, nowIso)
    return [...repinned, ...linked]
  } catch (err) {
    compatLogWarn(
      LOG_COMPONENT,
      `repin pass for server ${serverId} failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    return []
  }
}
