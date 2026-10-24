/**
 * The figures both stores work out the same way when they write a sample, so
 * the two editions keep identical readings:
 *
 *  - which network devices ride embedded in the `host.network` row and which
 *    page as rows of their own (the self-hosted store keeps an embedded NIC's
 *    four error and drop rates only as their sum, like the hosted row);
 *  - a drive's combined operations per second;
 *  - Docker's reclaimable total.
 */

import type {
  BlockDeviceSample,
  DockerUsageSample,
  MetricsExtended,
  NetworkDeviceSample,
} from '../../contracts/metrics-contract.ts'
import type { SlotMapping } from './types.ts'

/** How many `normalNicSlots` entries `host.network` embeds — slots 1 and 2; every later slot pages. */
export const HOST_IO_EMBEDDED_NIC_SLOT_COUNT = 2

/**
 * Resolve which `networks[]` entries embed in `host.network` (slots 1/2) versus
 * page as standalone `network` rows, given an optional `SlotMapping`.
 *
 * With a mapping: slot 1/slot 2 are looked up by `deviceId` (never by array
 * position — a topology reorder must not silently reinterpret a slot), and
 * any device listed in `fabricDeviceIds` is excluded from paging entirely —
 * this is what keeps a 2-NIC-plus-fabric host at 2 rows instead of 3. Slots
 * 3+ page first, in slot order, then any device that is neither a slot nor a
 * known fabric device (arrival order).
 *
 * Without a mapping (generation not recorded yet): falls back to this
 * module's original positional behavior — `networks[0]`/`networks[1]` embed,
 * everything else pages — since there is no way yet to tell a fabric device
 * apart from an ordinary extra NIC.
 */
export function resolveNetworkSlots(
  networks: readonly NetworkDeviceSample[],
  slotMapping: SlotMapping | undefined
): {
  nic0: NetworkDeviceSample | undefined
  nic1: NetworkDeviceSample | undefined
  paged: NetworkDeviceSample[]
} {
  if (!slotMapping) {
    return { nic0: networks[0], nic1: networks[1], paged: networks.slice(2) }
  }
  const byId = new Map(networks.map((device) => [device.deviceId, device]))
  const [slot1, slot2] = slotMapping.normalNicSlots
  const nic0 = slot1 ? byId.get(slot1) : undefined
  const nic1 = slot2 ? byId.get(slot2) : undefined
  const excluded = new Set<string>([
    ...slotMapping.fabricDeviceIds,
    ...slotMapping.normalNicSlots.slice(0, HOST_IO_EMBEDDED_NIC_SLOT_COUNT),
  ])
  const pagedSlots = slotMapping.normalNicSlots
    .slice(HOST_IO_EMBEDDED_NIC_SLOT_COUNT)
    .map((id) => byId.get(id))
    .filter((device): device is NetworkDeviceSample => device !== undefined)
  const pagedSlotIds = new Set(pagedSlots.map((device) => device.deviceId))
  const paged = [
    ...pagedSlots,
    ...networks.filter(
      (device) => !excluded.has(device.deviceId) && !pagedSlotIds.has(device.deviceId)
    ),
  ]
  return { nic0, nic1, paged }
}

/**
 * Sum of a NIC's four error and drop rates, `null` if any input is missing.
 * The one form the hosted store keeps for an embedded NIC.
 */
export function nicProblemsPerSecond(nic: NetworkDeviceSample | undefined): number | null {
  if (!nic) return null
  const parts = [
    nic.receiveErrorsPerSecond,
    nic.transmitErrorsPerSecond,
    nic.receiveDropsPerSecond,
    nic.transmitDropsPerSecond,
  ]
  if (parts.includes(null)) return null
  return (parts as number[]).reduce((sum, value) => sum + value, 0)
}

/** A drive's read plus write operations per second, `null` when either half is missing. */
export function blockOpsPerSecond(device: BlockDeviceSample): number | null {
  if (device.readOpsPerSecond === null || device.writeOpsPerSecond === null) return null
  return device.readOpsPerSecond + device.writeOpsPerSecond
}

/**
 * Docker's reclaimable bytes: the daemon's own total, else the three
 * reclaimable groups of the disk breakdown added up (`null` only when none was
 * reported).
 */
export function dockerReclaimableBytes(
  docker: MetricsExtended['docker'] | undefined,
  usage: DockerUsageSample | undefined
): number | null {
  const own = docker?.reclaimableBytes
  if (typeof own === 'number' && Number.isFinite(own)) return own
  const parts = [
    usage?.imagesReclaimableBytes,
    usage?.volumesReclaimableBytes,
    usage?.buildCacheReclaimableBytes,
  ].filter((part): part is number => typeof part === 'number' && Number.isFinite(part))
  return parts.length === 0 ? null : parts.reduce((sum, part) => sum + part, 0)
}
