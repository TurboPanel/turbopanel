/**
 * Test-only: shrink a sample to the box a layout case describes.
 *
 * The layout fixture (`v8-layout.fixture.json`) and the representative
 * machines are built for a grid of box sizes, each with a number of drives,
 * network cards, GPUs, extra disks and sensors. Production no longer cuts
 * devices to a plan (a server stores what it has); this helper only reproduces
 * the case inputs: it keeps the first N of each kind the way those cases were
 * written, then applies the same on/off switches production applies.
 */
import type { MetricsCapabilityPlan } from '../../../contracts/capability-plan.ts'
import type { MetricsSample } from '../../../contracts/metrics-contract.ts'
import type { SlotMapping } from '../../../contracts/topology-types.ts'
import { applyMetricsFeatureSwitches } from '../ingest-preparation.ts'

function networksWithinPlan(
  networks: MetricsSample['networks'],
  plan: MetricsCapabilityPlan,
  slotMapping: SlotMapping | undefined
): MetricsSample['networks'] {
  if (!slotMapping) return networks.slice(0, plan.normalNicSlots)
  const byId = new Map(networks.map((device) => [device.deviceId, device]))
  const keepIds = [
    ...slotMapping.normalNicSlots.slice(0, plan.normalNicSlots),
    ...(plan.turboFabricEnabled ? slotMapping.fabricDeviceIds : []),
  ]
  const kept: MetricsSample['networks'] = []
  for (const id of keepIds) {
    const device = byId.get(id)
    if (device && !kept.includes(device)) kept.push(device)
  }
  return kept
}

export function limitDevicesToCase(
  sample: MetricsSample,
  plan: MetricsCapabilityPlan,
  slotMapping?: SlotMapping
): MetricsSample {
  const nonRootFilesystems = slotMapping?.rootFilesystemId
    ? sample.filesystems.filter((fs) => fs.filesystemId !== slotMapping.rootFilesystemId)
    : sample.filesystems
  return applyMetricsFeatureSwitches(
    {
      ...sample,
      networks: networksWithinPlan(sample.networks, plan, slotMapping),
      gpus: sample.gpus.slice(0, plan.gpuSlots),
      blockDevices: sample.blockDevices.slice(0, plan.detailedBlockDeviceSlots),
      filesystems: nonRootFilesystems.slice(0, plan.extraFilesystemSlots),
      hardwareSignals: sample.hardwareSignals.slice(0, plan.physicalHardwareSignalSlots),
    },
    plan
  )
}
