/**
 * Ingest-side allowlist backstop for the hosted truncation path.
 *
 * The daemon filters entity noise (partitions, pseudo mounts, veth/bridge
 * NICs, virtual display adapters) before it builds a sample; this repeats the
 * same check at ingest, before the capability plan's slot truncation, so a
 * paid slot is never spent on an entity that cannot be a real monitored
 * thing (an older daemon, or one whose filter lags a new kernel naming).
 *
 * Entity ids are opaque to the control plane (`fs:dev:/dev/sda1`, `mac:..`),
 * so each rule matches on the id's recognizable tail (its last path segment
 * or last `:` part) and on the leading path for mounts. Pure: no I/O, the
 * input sample is never mutated.
 */
import type { MetricsSample } from '../../contracts/metrics-contract.ts'
import type { SlotMapping } from '../../contracts/topology-types.ts'

const PSEUDO_FS_TOKENS = [
  'tmpfs',
  'devtmpfs',
  'overlay',
  'squashfs',
  'nsfs',
  'proc',
  'sysfs',
  'cgroup',
  'cgroup2',
  'fuse.lxcfs',
]
const NOISE_MOUNT_PREFIXES = [
  '/var/lib/docker',
  '/var/lib/containerd',
  '/run',
  '/snap',
  '/boot',
  '/sys',
  '/proc',
]
const NON_DISK_BLOCK = /^(loop|ram|zram|sr|nbd|md)\d+$/
// Two linear patterns (letters then digits, and `<disk>p<digits>`): a single
// alternation with an optional `p` backtracks super-linearly.
const LETTER_DISK_PARTITION = /^((?:sd|vd|xvd|hd)[a-z]+)\d+$/
const NUMBERED_DISK_PARTITION = /^(nvme\d+n\d+|mmcblk\d+)p\d+$/
const NOISE_NIC = /^(lo|veth|br-|docker\d*|cni|flannel|virbr|tap|tun)/
const VIRTUAL_GPU_TOKENS = [
  'bochs',
  'virtio-gpu',
  'virtio_gpu',
  'qxl',
  'cirrus',
  'vmwgfx',
  'hyperv_drm',
  'hyperv-drm',
]

/** The recognizable tail of an opaque id: text after the last `/`, then after the last `:`. */
function idTail(id: string): string {
  const afterSlash = id.slice(id.lastIndexOf('/') + 1)
  return afterSlash.slice(afterSlash.lastIndexOf(':') + 1).toLowerCase()
}

/** The mount path embedded in an id, if any (`fs:/var/lib/docker`, `/srv`). */
function idPath(id: string): string | null {
  const start = id.indexOf('/')
  return start === -1 ? null : id.slice(start)
}

function hasPrefixPath(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`)
}

export function isNoiseFilesystemId(id: string): boolean {
  const lower = id.toLowerCase()
  const path = idPath(lower)
  // Only the filesystem-type part of the id (before the mount path) names a
  // pseudo type, so a mount such as /srv/proc is a real data mount.
  const typePart = path === null ? lower : lower.slice(0, lower.length - path.length)
  const words = new Set(typePart.split(/[^a-z0-9.]+/))
  if (PSEUDO_FS_TOKENS.some((token) => words.has(token))) return true
  return path !== null && NOISE_MOUNT_PREFIXES.some((prefix) => hasPrefixPath(path, prefix))
}

export function isNoiseNicId(id: string, fabricDeviceIds: ReadonlySet<string>): boolean {
  if (fabricDeviceIds.has(id)) return false
  return NOISE_NIC.test(idTail(id))
}

function partitionParent(name: string): string | null {
  const match = LETTER_DISK_PARTITION.exec(name) ?? NUMBERED_DISK_PARTITION.exec(name)
  return match ? match[1] : null
}

/** Block ids to keep: whole disks only, with arrays, loop-style devices and partitions of kept disks dropped. */
function keptBlockIds(ids: readonly string[]): Set<string> {
  const tails = new Set(ids.map(idTail))
  const kept = new Set<string>()
  for (const id of ids) {
    const name = idTail(id)
    if (NON_DISK_BLOCK.test(name)) continue
    const parent = partitionParent(name)
    if (parent !== null && tails.has(parent)) continue
    kept.add(id)
  }
  return kept
}

function hasAnyValue(gpu: MetricsSample['gpus'][number]): boolean {
  const { gpuId: _id, ...metrics } = gpu
  return Object.values(metrics).some((value) => value !== null && value !== undefined)
}

function isVirtualDisplay(text: string): boolean {
  const lower = text.toLowerCase()
  return VIRTUAL_GPU_TOKENS.some((token) => lower.includes(token))
}

function keptGpuIds(sample: MetricsSample): Set<string> {
  const text = new Map((sample.extended?.gpuText ?? []).map((entry) => [entry.gpuId, entry]))
  const kept = new Set<string>()
  for (const gpu of sample.gpus) {
    const entry = text.get(gpu.gpuId)
    const label = `${gpu.gpuId} ${entry?.driver ?? ''} ${entry?.model ?? ''}`
    if (!isVirtualDisplay(label) && hasAnyValue(gpu)) kept.add(gpu.gpuId)
  }
  return kept
}

function pruneExtended(
  extended: NonNullable<MetricsSample['extended']>,
  blockIds: ReadonlySet<string>,
  gpuIds: ReadonlySet<string>,
  fabric: ReadonlySet<string>
): NonNullable<MetricsSample['extended']> {
  const out = { ...extended }
  if (extended.filesystemSizes) {
    out.filesystemSizes = extended.filesystemSizes.filter(
      (entry) => !isNoiseFilesystemId(entry.filesystemId)
    )
  }
  if (extended.networkSizes) {
    out.networkSizes = extended.networkSizes.filter(
      (entry) => !isNoiseNicId(entry.deviceId, fabric)
    )
  }
  if (extended.gpuSizes) {
    out.gpuSizes = extended.gpuSizes.filter((entry) => gpuIds.has(entry.gpuId))
  }
  if (extended.blockDeviceText) {
    out.blockDeviceText = extended.blockDeviceText.filter((entry) => blockIds.has(entry.deviceId))
  }
  if (extended.gpuText) {
    out.gpuText = extended.gpuText.filter((entry) => gpuIds.has(entry.gpuId))
  }
  return out
}

/**
 * Drop entities that cannot be real monitored things. GPU-derived hardware
 * signals are left in place: machine-class inference, not this filter, decides
 * what they prove.
 */
export function applyIngestAllowlist(
  sample: MetricsSample,
  slotMapping: Pick<SlotMapping, 'fabricDeviceIds'> | undefined
): MetricsSample {
  const fabric = new Set<string>(slotMapping?.fabricDeviceIds ?? [])
  const blockIds = keptBlockIds(sample.blockDevices.map((device) => device.deviceId))
  const gpuIds = keptGpuIds(sample)
  const filtered: MetricsSample = {
    ...sample,
    networks: sample.networks.filter((device) => !isNoiseNicId(device.deviceId, fabric)),
    filesystems: sample.filesystems.filter((fs) => !isNoiseFilesystemId(fs.filesystemId)),
    blockDevices: sample.blockDevices.filter((device) => blockIds.has(device.deviceId)),
    gpus: sample.gpus.filter((gpu) => gpuIds.has(gpu.gpuId)),
  }
  if (sample.extended) filtered.extended = pruneExtended(sample.extended, blockIds, gpuIds, fabric)
  return filtered
}
