/**
 * Topology-derived inputs to the recommended tier, shared by the placement
 * evaluation (`tier-enforcement.ts`) and the derived assignment
 * (`assignment-records.ts`), so both read one definition of "monitored".
 * Pure.
 */
import { parseServerHardwareProfile, parseServerHostResources } from '../servers/server-metadata.ts'
import { computeSlotMapping, isWholeDisk } from '../../contracts/topology-slot-mapping.ts'
import {
  EMPTY_TOPOLOGY_OVERRIDES,
  type TopologyOverrides,
  type TopologySnapshot,
} from '../../contracts/topology-types.ts'
import { resolveRecommendedTier } from './tier-placement.ts'

export type DiscoveredDeviceIds = {
  nics: string[]
  drives: string[]
  gpus: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSlotMappableTopologySnapshot(value: Record<string, unknown>): value is TopologySnapshot {
  return (
    Array.isArray(value.networks) &&
    Array.isArray(value.filesystems) &&
    Array.isArray(value.blockDevices) &&
    Array.isArray(value.gpus) &&
    Array.isArray(value.hardwareSignals)
  )
}

export function parseTopologySnapshot(value: unknown): TopologySnapshot | undefined {
  if (!isRecord(value)) return undefined
  if (!isSlotMappableTopologySnapshot(value)) return undefined
  return value
}

function sortedIds(ids: readonly string[]): string[] {
  return [...ids].sort((a, b) => a.localeCompare(b))
}

export function discoveredDeviceIds(snapshot: TopologySnapshot | undefined): DiscoveredDeviceIds {
  if (!snapshot) {
    return { nics: [], drives: [], gpus: [] }
  }
  const nics = snapshot.networks
    .filter((device) => device.kind === 'uplink')
    .map((device) => device.deviceId)
  // Real whole disks, RAID members included. md/dm arrays and partitions are
  // never drives: RAID is covered by RAID health and filesystem free space.
  const drives = snapshot.blockDevices.filter(isWholeDisk).map((device) => device.deviceId)
  const gpus = snapshot.gpus.map((gpu) => gpu.gpuId)
  return {
    nics: sortedIds(nics),
    drives: sortedIds(drives),
    gpus: sortedIds(gpus),
  }
}

export function topologyOverridesFromMetadata(
  metadata: Record<string, unknown> | undefined
): TopologyOverrides {
  const hardwareProfile = parseServerHardwareProfile(metadata?.hardwareProfile)
  return {
    ...EMPTY_TOPOLOGY_OVERRIDES,
    nicSlotDeviceIds: hardwareProfile?.nicSlotDeviceIds ?? [],
    hostingFilesystemId: hardwareProfile?.hostingFilesystemId ?? null,
    drivetempEnabled: hardwareProfile?.drivetempEnabled ?? false,
  }
}

/**
 * The operator's monitored NIC set, in slot order — the slot mapping's
 * `normalNicSlots`: `nicSlotDeviceIds` when pinned, otherwise the
 * `defaultRoute` uplink, otherwise the first uplink by sorted id — never
 * "alphabetical first N". This is the same list hosted ingest truncates and
 * the picker renders, so the recommendation, the unwatched notice and the
 * stored sample all describe one selection.
 */
export function monitoredNicIds(
  snapshot: TopologySnapshot | undefined,
  overrides: TopologyOverrides | undefined
): string[] {
  if (!snapshot) return []
  return computeSlotMapping(snapshot, overrides ?? EMPTY_TOPOLOGY_OVERRIDES).normalNicSlots
}

/** Recommended tier rank for one server from its stored metadata and latest topology snapshot. */
export function recommendedRankFromMetadata(
  metadata: unknown,
  snapshot: TopologySnapshot | undefined
): number {
  const record = isRecord(metadata) ? metadata : undefined
  const discovered = discoveredDeviceIds(snapshot)
  return resolveRecommendedTier(
    parseServerHostResources(record?.resources) ?? {},
    monitoredNicIds(snapshot, topologyOverridesFromMetadata(record)).length,
    discovered.drives.length,
    discovered.gpus.length
  ).rank
}
