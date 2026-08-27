/**
 * Deterministic per-(segment, task) address allocation for spanning compose
 * networks. A task carries at most one `address` — a service that joins more
 * than one spanning network keeps the address from the first compose key
 * (sorted). Removed slots free their addresses for reuse.
 */

import {
  cidrHostRange,
  ipToBigInt,
  nextFreeHostAddress,
  stripInetPrefixSuffix,
} from '../ip-address.ts'
import { reservedManagedIngressAddress } from '../fabric/cidr.ts'
import type { DesiredSlotInput } from '../db/slot-records.ts'

export type SlotAddressExisting = {
  serviceId: string
  slot: number
  serverId: string
  address: string | null
}

export type SpanningHostsForService = {
  primary: string
  replicas: ReadonlyMap<number, string>
  /** Spanning compose network keys this service joins. */
  networks: ReadonlySet<string>
}

function slotKey(serviceId: string, slot: number): string {
  return `${serviceId}:${String(slot)}`
}

function normalizeAddress(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const stripped = stripInetPrefixSuffix(value)
  return stripped.length > 0 ? stripped : null
}

function addressInCidrHostRange(cidr: string, address: string): boolean {
  const range = cidrHostRange(cidr)
  const value = ipToBigInt(address)
  if (!range || value === null) return false
  return value >= range.first && value <= range.last
}

function usedSetForServer(
  occupied: Map<string, Set<string>>,
  serverId: string,
): Set<string> {
  const existing = occupied.get(serverId)
  if (existing) return existing
  const created = new Set<string>()
  occupied.set(serverId, created)
  return created
}

function seedReservedAddresses(
  segments: ReadonlyMap<string, string>,
): { occupied: Map<string, Set<string>>; reservedByServer: Map<string, string> } {
  const occupied = new Map<string, Set<string>>()
  const reservedByServer = new Map<string, string>()
  for (const [serverId, cidr] of segments) {
    const reserved = reservedManagedIngressAddress(cidr)
    if (!reserved) continue
    reservedByServer.set(serverId, reserved)
    usedSetForServer(occupied, serverId).add(reserved)
  }
  return { occupied, reservedByServer }
}

function stickyAddressForSlot(
  task: DesiredSlotInput,
  cidr: string,
  previous: SlotAddressExisting | undefined,
  reserved: string | undefined,
): string | null {
  const previousAddress = normalizeAddress(previous?.address)
  if (
    previous?.serverId !== task.serverId ||
    previousAddress === null ||
    previousAddress === reserved ||
    !addressInCidrHostRange(cidr, previousAddress)
  ) {
    return null
  }
  return previousAddress
}

function reuseStickyAddresses(
  participating: readonly DesiredSlotInput[],
  segments: ReadonlyMap<string, string>,
  existingByKey: ReadonlyMap<string, SlotAddressExisting>,
  reservedByServer: ReadonlyMap<string, string>,
  occupied: Map<string, Set<string>>,
  assigned: Map<string, string>,
): void {
  for (const task of participating) {
    const key = slotKey(task.serviceId, task.slot)
    if (assigned.has(key)) continue
    const cidr = segments.get(task.serverId)
    if (!cidr) continue
    const sticky = stickyAddressForSlot(
      task,
      cidr,
      existingByKey.get(key),
      reservedByServer.get(task.serverId),
    )
    if (!sticky) continue
    assigned.set(key, sticky)
    usedSetForServer(occupied, task.serverId).add(sticky)
  }
}

function allocateRemainingAddresses(
  participating: readonly DesiredSlotInput[],
  segments: ReadonlyMap<string, string>,
  occupied: Map<string, Set<string>>,
  assigned: Map<string, string>,
): void {
  for (const task of participating) {
    const key = slotKey(task.serviceId, task.slot)
    if (assigned.has(key)) continue
    const cidr = segments.get(task.serverId)
    if (!cidr) continue
    const used = usedSetForServer(occupied, task.serverId)
    const next = nextFreeHostAddress(cidr, used)
    if (!next) continue
    assigned.set(key, next)
    used.add(next)
  }
}

function assignAddressesForNetwork(
  slots: readonly DesiredSlotInput[],
  existingByKey: ReadonlyMap<string, SlotAddressExisting>,
  segments: ReadonlyMap<string, string>,
  serviceIds: ReadonlySet<string>,
  assigned: Map<string, string>,
): void {
  if (serviceIds.size === 0) return
  const { occupied, reservedByServer } = seedReservedAddresses(segments)
  const participating = slots.filter((task) =>
    serviceIds.has(task.serviceId) && segments.has(task.serverId)
  )
  reuseStickyAddresses(
    participating,
    segments,
    existingByKey,
    reservedByServer,
    occupied,
    assigned,
  )
  allocateRemainingAddresses(participating, segments, occupied, assigned)
}

/**
 * First-fit allocate host addresses inside each server's segment CIDR.
 * Sticky: same `(serviceId, slot)` on the same `serverId` keeps its previous
 * address when that address still sits in the segment host range.
 */
export function assignSlotAddresses(params: {
  slots: readonly DesiredSlotInput[]
  existing: readonly SlotAddressExisting[]
  /** composeKey → serverId → segment CIDR */
  networkSegments: ReadonlyMap<string, ReadonlyMap<string, string>>
  /** composeKey → service ids that join that network */
  networkServiceIds: ReadonlyMap<string, ReadonlySet<string>>
}): DesiredSlotInput[] {
  const existingByKey = new Map(
    params.existing.map((row) => [slotKey(row.serviceId, row.slot), row]),
  )
  const assigned = new Map<string, string>()
  const composeKeys = [...params.networkSegments.keys()].sort((a, b) => a.localeCompare(b))

  for (const composeKey of composeKeys) {
    const segments = params.networkSegments.get(composeKey)
    const serviceIds = params.networkServiceIds.get(composeKey)
    if (!segments || !serviceIds) continue
    assignAddressesForNetwork(
      params.slots,
      existingByKey,
      segments,
      serviceIds,
      assigned,
    )
  }

  return params.slots.map((task) => ({
    ...task,
    address: assigned.get(slotKey(task.serviceId, task.slot)) ?? null,
  }))
}

function replicaOrdinal(slot: number): number {
  return slot + 1
}

function networksByServiceName(
  networkServiceIds: ReadonlyMap<string, ReadonlySet<string>> | undefined,
  serviceIdToName: ReadonlyMap<string, string>,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  if (!networkServiceIds) return out
  for (const [composeKey, ids] of networkServiceIds) {
    for (const id of ids) {
      const name = serviceIdToName.get(id)
      if (!name) continue
      const set = out.get(name) ?? new Set<string>()
      set.add(composeKey)
      out.set(name, set)
    }
  }
  return out
}

/**
 * Compile-time maps for `ipv4_address` (local slots) and `extra_hosts`
 * (environment slots that carry an address, keyed with spanning-network
 * membership so compile can emit sibling-only, network-scoped hosts).
 */
export function buildCompileAddressMaps(params: {
  slots: readonly DesiredSlotInput[]
  serviceIdToName: ReadonlyMap<string, string>
  serverId: string
  /** composeKey → service ids that join that spanning network */
  networkServiceIds?: ReadonlyMap<string, ReadonlySet<string>>
}): {
  taskAddressesByService: Map<string, Map<number, string>>
  spanningHostsByService: Map<string, SpanningHostsForService>
} {
  const taskAddressesByService = new Map<string, Map<number, string>>()
  const byService = new Map<string, Array<{ slot: number; address: string }>>()
  const networksByName = networksByServiceName(
    params.networkServiceIds,
    params.serviceIdToName,
  )

  for (const task of params.slots) {
    const address = normalizeAddress(task.address)
    if (!address) continue
    const name = params.serviceIdToName.get(task.serviceId)
    if (!name) continue
    const list = byService.get(name) ?? []
    list.push({ slot: task.slot, address })
    byService.set(name, list)
    if (task.serverId !== params.serverId) continue
    const slots = taskAddressesByService.get(name) ?? new Map<number, string>()
    slots.set(task.slot, address)
    taskAddressesByService.set(name, slots)
  }

  const spanningHostsByService = new Map<string, SpanningHostsForService>()
  for (const [name, entries] of byService) {
    const sorted = [...entries].sort((a, b) => a.slot - b.slot)
    const primary = sorted[0]?.address
    if (!primary) continue
    const replicas = new Map<number, string>()
    for (const entry of sorted) {
      replicas.set(replicaOrdinal(entry.slot), entry.address)
    }
    spanningHostsByService.set(name, {
      primary,
      replicas,
      networks: networksByName.get(name) ?? new Set(),
    })
  }

  return { taskAddressesByService, spanningHostsByService }
}
