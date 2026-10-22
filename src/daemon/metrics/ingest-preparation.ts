/**
 * What both editions do to a validated sample before it is stored.
 *
 * Nothing here limits how many devices a server may report: a drive, a network
 * card, a GPU or a sensor is stored because the machine has it, up to the
 * shared limits the sample validator already enforces (64 of each kind, 16
 * events a sample). What remains is:
 *
 *  - the noise filter (`ingest-allowlist.ts`): entities that cannot be a real
 *    monitored thing, such as partitions, pseudo mounts and virtual adapters;
 *  - the root filesystem, which is stored in the host row, never as an extra
 *    filesystem (an older daemon may still list it);
 *  - the on/off switches an organization or a server can set: web traffic
 *    (and the router figures), database proxy figures, Docker usage, hardware
 *    health events, and mesh interfaces. A switch that is off drops that data
 *    before either store sees it.
 *
 * Pure: no I/O, the input sample is never mutated.
 */
import type { MetricsCapabilityPlan } from '../../contracts/capability-plan.ts'
import { isHardwareHealthEventKind, type MetricsSample } from '../../contracts/metrics-contract.ts'
import type { SlotMapping } from '../../contracts/topology-types.ts'
import { applyIngestAllowlist } from './ingest-allowlist.ts'

export type MetricsFeatureSwitches = Pick<
  MetricsCapabilityPlan,
  | 'turboFabricEnabled'
  | 'managedIngressEnabled'
  | 'databaseProxyMetricsEnabled'
  | 'managedDockerEnabled'
  | 'hardwareHealthEventsEnabled'
>

type SlotMappingForPreparation = Pick<SlotMapping, 'fabricDeviceIds' | 'rootFilesystemId'>

/**
 * Drop the data whose switch is off. A dropped optional section is omitted
 * entirely, never set to `undefined`: a present-but-undefined property is a
 * different object shape than an absent one, which whole-sample equality
 * assertions and `JSON.stringify` both notice.
 *
 * - `managedIngressEnabled` covers the web traffic sources and the shared
 *   router figures: both are traffic visibility for the host's HTTP front door.
 * - `managedDockerEnabled` covers Docker's disk breakdown.
 * - `hardwareHealthEventsEnabled` drops only the hardware-health event kinds;
 *   every other kind is unrelated operational history and always survives.
 * - `turboFabricEnabled` off drops the mesh interfaces named by the slot
 *   mapping.
 * - Host-wide storage accounting and diagnostics have no switch.
 */
export function applyMetricsFeatureSwitches(
  sample: MetricsSample,
  switches: MetricsFeatureSwitches,
  slotMapping?: Pick<SlotMapping, 'fabricDeviceIds'>
): MetricsSample {
  const { router: _router, ...withoutRouter } = sample
  const base = switches.managedIngressEnabled ? sample : withoutRouter
  const { dockerUsage: _dockerUsage, ...withoutDocker } = base
  const gated = switches.managedDockerEnabled ? base : withoutDocker
  const fabric = new Set(slotMapping?.fabricDeviceIds ?? [])
  return {
    ...gated,
    networks:
      switches.turboFabricEnabled || fabric.size === 0
        ? sample.networks
        : sample.networks.filter((device) => !fabric.has(device.deviceId)),
    ingressSources: switches.managedIngressEnabled ? sample.ingressSources : [],
    databaseProxies: switches.databaseProxyMetricsEnabled ? sample.databaseProxies : [],
    events: switches.hardwareHealthEventsEnabled
      ? sample.events
      : sample.events.filter((event) => !isHardwareHealthEventKind(event.kind)),
  }
}

/** The root filesystem's capacity lives in the host row; an entry for it in `filesystems` is dropped. */
function withoutRootFilesystem(
  sample: MetricsSample,
  slotMapping: Pick<SlotMapping, 'rootFilesystemId'> | undefined
): MetricsSample {
  const rootId = slotMapping?.rootFilesystemId
  if (!rootId) return sample
  return { ...sample, filesystems: sample.filesystems.filter((fs) => fs.filesystemId !== rootId) }
}

/** The one preparation both editions apply before a sample is stored. */
export function prepareSampleForStorage(
  sample: MetricsSample,
  switches: MetricsFeatureSwitches,
  slotMapping?: SlotMappingForPreparation
): MetricsSample {
  const filtered = applyIngestAllowlist(sample, slotMapping)
  return applyMetricsFeatureSwitches(
    withoutRootFilesystem(filtered, slotMapping),
    switches,
    slotMapping
  )
}
