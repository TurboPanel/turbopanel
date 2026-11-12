/**
 * Telling topologies apart without the daemon's topology generation number.
 *
 * Older daemons number every topology they report (`topology-report.generation`)
 * and stamp that number on every metrics sample (`metadata.topologyGeneration`).
 * Newer daemons leave both out once the control plane lists the
 * `topology-generation-optional-v1` wire feature, so the control plane works
 * out the same two answers from content it already receives:
 *
 * - **Is this report a new topology or a resend?** Two snapshots are the same
 *   topology when {@link topologyIdentityKey} matches: the entity ids and the
 *   few attributes `computeSlotMapping` reads. Anything else in a snapshot
 *   (sizes, labels, readings) is a refresh, never a change, so it never spends
 *   the hourly and daily change limits.
 * - **Can a sample be packed against the stored topology?** Yes when every
 *   network device, filesystem, block device and GPU the sample names is in
 *   the stored snapshot ({@link sampleFitsTopology}). Every stored row names
 *   its own devices, so the slot mapping only decides which NICs are embedded
 *   and the page order; a sample naming a device the snapshot does not know
 *   is packed without a mapping until the daemon reports the new topology.
 *   Hardware signals are left out of the check: a signal the snapshot does not
 *   list only moves to the end of its page.
 *
 * While both sides still carry a generation number (an older daemon), the
 * number decides, exactly as before. Pure functions, no I/O.
 */
import type { MetricsSample } from '../../contracts/metrics-contract.ts'

function entries(snapshot: unknown, key: string): Record<string, unknown>[] {
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) return []
  const value = (snapshot as Record<string, unknown>)[key]
  if (!Array.isArray(value)) return []
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && !Array.isArray(entry)
  )
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b))
}

function ids(snapshot: unknown, key: string, idField: string): Set<string> {
  const out = new Set<string>()
  for (const entry of entries(snapshot, key)) {
    const id = entry[idField]
    if (typeof id === 'string') out.add(id)
  }
  return out
}

/**
 * A deterministic key for the slot-affecting part of a topology snapshot:
 * network devices with their kind and default-route flag, filesystems with
 * their roles, block devices with their type, GPUs and hardware signals.
 * Order in the snapshot does not matter. A missing or malformed array counts
 * as empty, so any value gives a key.
 */
export function topologyIdentityKey(snapshot: unknown): string {
  return JSON.stringify({
    networks: sortedUnique(
      entries(snapshot, 'networks').map(
        (n) => `${text(n.deviceId)}|${text(n.kind)}|${n.defaultRoute === true ? 'default' : ''}`
      )
    ),
    filesystems: sortedUnique(
      entries(snapshot, 'filesystems').map((fs) => {
        const roles = Array.isArray(fs.roles) ? fs.roles.map(text) : []
        return `${text(fs.filesystemId)}|${sortedUnique(roles).join(',')}`
      })
    ),
    blockDevices: sortedUnique(
      entries(snapshot, 'blockDevices').map((d) => `${text(d.deviceId)}|${text(d.deviceType)}`)
    ),
    gpus: sortedUnique(entries(snapshot, 'gpus').map((g) => text(g.gpuId))),
    hardwareSignals: sortedUnique(
      entries(snapshot, 'hardwareSignals').map((s) => text(s.signalId))
    ),
  })
}

/** `true` when every item's id is in `known`. */
function allKnown<T>(items: readonly T[], idOf: (item: T) => string, known: Set<string>): boolean {
  return items.every((item) => known.has(idOf(item)))
}

/**
 * `true` when every network device, filesystem, block device and GPU the
 * sample names is in `snapshot`, so the snapshot's slot mapping applies to it.
 */
export function sampleFitsTopology(
  sample: Pick<MetricsSample, 'networks' | 'filesystems' | 'blockDevices' | 'gpus'>,
  snapshot: unknown
): boolean {
  return (
    allKnown(sample.networks, (n) => n.deviceId, ids(snapshot, 'networks', 'deviceId')) &&
    allKnown(
      sample.filesystems,
      (fs) => fs.filesystemId,
      ids(snapshot, 'filesystems', 'filesystemId')
    ) &&
    allKnown(sample.blockDevices, (d) => d.deviceId, ids(snapshot, 'blockDevices', 'deviceId')) &&
    allKnown(sample.gpus, (g) => g.gpuId, ids(snapshot, 'gpus', 'gpuId'))
  )
}

/** The part of a stored topology record the checks below read. */
export type RecordedTopology = { generation?: number; snapshot: unknown }

/**
 * Whether a sample was collected under the stored topology. An older daemon's
 * generation number decides when both the sample and the record carry one;
 * otherwise the sample's entity ids decide ({@link sampleFitsTopology}).
 */
export function sampleMatchesRecordedTopology(
  record: RecordedTopology | undefined,
  sample: Pick<MetricsSample, 'metadata' | 'networks' | 'filesystems' | 'blockDevices' | 'gpus'>
): boolean {
  if (!record) return false
  const generation = sample.metadata.topologyGeneration
  if (generation !== undefined && record.generation !== undefined) {
    return record.generation === generation
  }
  return sampleFitsTopology(sample, record.snapshot)
}

/** The stored record when the sample matches it ({@link sampleMatchesRecordedTopology}), else `undefined`. */
export function recordedTopologyForSample<T extends RecordedTopology>(
  record: T | undefined,
  sample: Pick<MetricsSample, 'metadata' | 'networks' | 'filesystems' | 'blockDevices' | 'gpus'>
): T | undefined {
  return sampleMatchesRecordedTopology(record, sample) ? record : undefined
}

/**
 * Whether a topology report describes the stored topology (a resend or a
 * refresh) rather than a new one. Generation numbers decide when both sides
 * carry one; otherwise {@link topologyIdentityKey} does.
 */
export function reportIsSameTopology(
  record: RecordedTopology,
  report: { generation?: number; snapshot: unknown }
): boolean {
  if (report.generation !== undefined && record.generation !== undefined) {
    return record.generation === report.generation
  }
  return topologyIdentityKey(record.snapshot) === topologyIdentityKey(report.snapshot)
}
