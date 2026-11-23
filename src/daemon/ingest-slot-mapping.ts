/**
 * Slot mapping for metrics ingest: resolves the `SlotMapping` a sample is
 * packed with from the server's recorded topology snapshot (see api-routes.ts).
 */
import { computeSlotMapping } from '../contracts/topology-slot-mapping.ts'
import {
  EMPTY_TOPOLOGY_OVERRIDES,
  type SlotMapping,
  type TopologyOverrides,
  type TopologySnapshot,
} from '../contracts/topology-types.ts'
import { describeError } from '../lib/describe-error.ts'
import { parseServerHardwareProfile } from '../features/servers/server-metadata.ts'
import { rateLimitedMetricsLog } from './metrics/validation.ts'

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A snapshot is only usable for slot mapping once it carries every array
 * `computeSlotMapping` reads. `resolveServerMachineClass` only ever
 * needs `hardwareSignals`, so some recorded/test snapshots are intentionally
 * that minimal — treat those the same as "no snapshot" here rather than
 * letting `computeSlotMapping` throw on a missing array.
 */
function isSlotMappableTopologySnapshot(value: Record<string, unknown>): value is TopologySnapshot {
  return (
    Array.isArray(value.networks) &&
    Array.isArray(value.filesystems) &&
    Array.isArray(value.blockDevices) &&
    Array.isArray(value.gpus) &&
    Array.isArray(value.hardwareSignals)
  )
}

/**
 * Resolve the {@link SlotMapping} for a sample from the snapshot it was
 * collected under (`sampleMatchesRecordedTopology`: the entity ids
 * the sample names) and the
 * operator's `hardwareProfile` overrides. `undefined` when the sample does not
 * match the stored snapshot, the snapshot is not a plausible topology report,
 * or resolution otherwise fails — callers must fall back to topology-agnostic packing in that case
 * (see `field-map.ts`).
 */
export function resolveSlotMappingForIngest(
  serverId: string,
  topologySnapshot: unknown,
  serverMetadata: unknown
): SlotMapping | undefined {
  if (!isPlainObject(topologySnapshot)) return undefined
  if (!isSlotMappableTopologySnapshot(topologySnapshot)) return undefined
  try {
    const hardwareProfile = parseServerHardwareProfile(
      isPlainObject(serverMetadata) ? serverMetadata.hardwareProfile : undefined
    )
    const overrides: TopologyOverrides = {
      ...EMPTY_TOPOLOGY_OVERRIDES,
      nicSlotDeviceIds: hardwareProfile?.nicSlotDeviceIds ?? [],
      hostingFilesystemId: hardwareProfile?.hostingFilesystemId ?? null,
      drivetempEnabled: hardwareProfile?.drivetempEnabled ?? false,
    }
    return computeSlotMapping(topologySnapshot, overrides)
  } catch (err) {
    rateLimitedMetricsLog(serverId, 'slot_mapping_resolve_failed', () => {
      console.warn(`metrics slot mapping resolution failed for ${serverId}: ${describeError(err)}`)
    })
    return undefined
  }
}
