/**
 * Cloudflare Analytics Engine positional field map for the current metrics
 * contract: the single source of truth for the double1..double20 /
 * blob1..blob20 layout on the `turbopanel_server_metrics_v7` dataset.
 *
 * The slot layout itself lives in `v7-layout.ts` (a static table pinned to
 * `../../testing/v7-layout.fixture.json`, spec in `../../V7-LAYOUT.md`); this
 * module owns the envelope (blob positions, sentinel, sample-time text), the
 * per-sample row selection and the read-side lookups `sql-api.ts` resolves
 * slots through.
 *
 * Rows per sample: four host rows (`host.system`, `host.io`, `host.network`,
 * `host.web`, always written), `managed.database` (only with managed
 * databases), then paged entity rows (`block` for more than one drive,
 * `network` for NIC 3 and up, `filesystem` unless exactly one extra
 * filesystem exists and is folded into `host.network`, `gpu`,
 * `hardware.physical`) and one `event` row per event.
 *
 * Slot assignment is identity-addressed when a `SlotMapping` is available
 * (`client/servers/topology-slot-mapping.ts`, resolved by the ingest route
 * from the server's latest hardware facts):
 *
 *  - `host.network` embeds the first two `slotMapping.normalNicSlots` entries
 *    (looked up by `deviceId`), so the common 1-NIC/2-NIC host never writes a
 *    `network` row, and names them (plus the folded extra filesystem) in its
 *    blob6 so every stored row says which device it holds — readers never
 *    need the layout that was active when it was written. Devices in
 *    `slotMapping.fabricDeviceIds` never page.
 *  - `block` / `network` / `filesystem` / `gpu` / `hardware.physical` pages
 *    order their entities by the matching `*PageOrder` list and stamp blob6
 *    with that page's entity ids, comma-joined in the same order as the
 *    page's double values.
 *
 * `slotMapping` is optional: without one every family falls back to positional
 * packing in arrival order, so an unresolved generation degrades gracefully.
 *
 * A sample stamped v6 (a daemon that has not moved to v7 yet) is written as a
 * v7 row like any other: blob3 is always the storage constant, and every slot
 * the older sample cannot fill is the sentinel (doubles) or empty (text).
 *
 * External storage contract: never inline positional literals elsewhere;
 * always derive columns and write payloads through this module.
 */

import {
  type MetricEvent,
  METRICS_SCHEMA_VERSION,
  type MetricsSample,
  type NetworkDeviceSample,
} from '../../../../contracts/metrics-contract.ts'
import type { HostedFamily, MetricEntityScope } from '../../metric-descriptors.ts'
import type { AuthenticatedMetricsSample, ServerStatusEvent, SlotMapping } from '../../types.ts'
import {
  hasManagedDatabase,
  V7_CONTENT_BLOB_CAPACITY,
  V7_ENTITY_FIELD_ORDER,
  V7_ENTITIES_PER_PAGE,
  V7_FIRST_CONTENT_BLOB_INDEX,
  V7_HOST_FAMILIES,
  type V7Context,
  type V7EntityPage,
  type V7HostFamily,
  v7EmbeddedNicDoubleIndex,
  v7EntityPages,
  v7HostRowEntityIds,
  v7HostRowValues,
  v7HostSlotFor,
  type V7RowValues,
} from './v7-layout.ts'

/** Analytics Engine dataset for the current metrics contract. */
/**
 * The layout revision stamped in `blob3` on every hosted row (stringified).
 * It is the storage layout's own number, not the wire version: the sizes
 * amendment (2026-10-07) reused hosted slots under the same wire version 7, so
 * rows written before it must never be read with the new slot meanings. Rows
 * stamped with any other value are invisible to the readers (history before
 * the cut is dropped; only testing and canary had any). Bump it again whenever
 * a slot changes meaning.
 */
export const AE_STORAGE_VERSION = 8 as const

export const AE_DATASET_NAME = `turbopanel_server_metrics_v${METRICS_SCHEMA_VERSION}`

export const AE_DOUBLE_COUNT = 20
export const AE_BLOB_COUNT = 20

/**
 * Physical AE row budget for metric-value double slots (double1..double19) —
 * one reserved interval slot on double20.
 */
export const AE_METRIC_DOUBLE_SLOT_COUNT = 19

/** double20 on every `"metrics"`-kind row — the sample's `intervalSeconds`. */
export const AE_DOUBLE_INTERVAL_INDEX = 19

/** double1 on `"status"`-kind rows — connected (1) / disconnected (0). */
export const AE_DOUBLE_STATUS_CONNECTED_INDEX = 0

/**
 * Missing-metric sentinel (AE doubles have no null; 0 would silently skew
 * averages; all host metrics are >= 0).
 */
export const AE_MISSING_METRIC_SENTINEL = -1e308

// ---------------------------------------------------------------------------
// Envelope blob indexes (0-based; `blobColumn` maps to `blob<index+1>`).
//
// "metrics" rows: blob1 kind, blob2 family, blob3 schema version, blob4
// topology generation, blob5 sample time, blob6 entity ids, blob7.. content
// text. "event" and "status" rows keep their v6 positions (below) apart from
// blob3 and the blob5 text format.
// ---------------------------------------------------------------------------

/** blob1 — row-kind discriminator: `"metrics"` / `"event"` / `"status"`. */
export const AE_BLOB_KIND_INDEX = 0
/**
 * blob2 — on `"metrics"` rows, the row family (`V7_HOST_FAMILIES` or an
 * entity family); on `"event"` rows, the event's `kind` (`MetricEventKind`);
 * empty on `"status"` rows.
 */
export const AE_BLOB_FAMILY_INDEX = 1
/** blob3 — schema version (stringified integer, every row kind): always {@link AE_STORAGE_VERSION}. */
export const AE_BLOB_SCHEMA_VERSION_INDEX = 2
/* blob4 — reserved, written empty on every row (it held the topology generation before rows named their own devices). */
/**
 * blob5 — sample time as UTC text `YYYY-MM-DD hh:mm:ss` (the one format AE's
 * `toDateTime` parses). On `"metrics"` rows `metadata.sampledAt`; on
 * `"event"` rows the event's own `at`; empty on `"status"` rows.
 */
export const AE_BLOB_SAMPLED_AT_INDEX = 4
/**
 * blob6 — `"metrics"` rows: comma-joined entity ids in the same order as the
 * page's double values (entity families); on `host.network` the embedded
 * devices as `nic1=<id>@<Mb/s>;nic2=<id>@<Mb/s>;fs=<id>` (see
 * `v7HostRowEntityIds`); empty on the other host rows. `"event"` rows: the
 * enclosing sample's sequence, as in v6.
 */
export const AE_BLOB_ENTITY_IDS_INDEX = 5
/** blob6 on `"event"` rows — enclosing sample's sequence (stringified integer). */
export const AE_BLOB_SEQUENCE_INDEX = 5
/* blob7 on `"event"` rows — reserved, written empty (it held the topology generation). */
/** blob8 on `"event"` rows — capability-plan generation (empty when unresolved). */
export const AE_BLOB_CAPABILITY_PLAN_GENERATION_INDEX = 7
/** blob9 on `"event"` rows — `"0"`. */
export const AE_BLOB_PAGE_INDEX = 8
/** blob10 on `"event"` rows only — `event.source`. */
export const AE_BLOB_SOURCE_OR_IDENTITY_INDEX = 9
/** blob11 — `"event"` rows only: `event.entityId` (empty when absent). */
export const AE_BLOB_EVENT_ENTITY_ID_INDEX = 10
/** blob12 — `"event"` rows only: `JSON.stringify(event.payload ?? {})`. */
export const AE_BLOB_EVENT_PAYLOAD_INDEX = 11
/** blob13 — `"event"` rows only: `event.eventId`. Empty on every other row kind. */
export const AE_BLOB_EVENT_ID_INDEX = 12
/** blob14..blob16 stay reserved-empty on event and status rows. */
export const AE_RESERVED_MID_BLOB_COUNT = 3
/**
 * blob17 — `"status"` rows: {@link ServerStatusEvent.reason}. `"event"` rows:
 * the event's `severity`. Empty on `"metrics"` rows.
 */
export const AE_BLOB_STATUS_OR_EVENT_REASON_INDEX = 16
/** blob18..blob20 stay reserved-empty on event and status rows. */
export const AE_RESERVED_TRAILING_BLOB_COUNT = 3

/** blob1 discriminator values. */
export const AE_KIND_METRICS = 'metrics'
export const AE_KIND_EVENT = 'event'
export const AE_KIND_STATUS = 'status'

/** blob2 discriminator values for `"metrics"` rows — mirrors {@link HostedFamily} exactly. */
export const AE_FAMILY_HOST_SYSTEM: HostedFamily = 'host.system'
export const AE_FAMILY_HOST_IO: HostedFamily = 'host.io'
export const AE_FAMILY_HOST_NETWORK: HostedFamily = 'host.network'
export const AE_FAMILY_HOST_WEB: HostedFamily = 'host.web'
export const AE_FAMILY_MANAGED_DATABASE: HostedFamily = 'managed.database'
export const AE_FAMILY_GPU: HostedFamily = 'gpu'
export const AE_FAMILY_NETWORK: HostedFamily = 'network'
export const AE_FAMILY_FILESYSTEM: HostedFamily = 'filesystem'
export const AE_FAMILY_BLOCK: HostedFamily = 'block'
export const AE_FAMILY_HARDWARE_PHYSICAL: HostedFamily = 'hardware.physical'

/**
 * Physical column name for the authenticated serverId identity slot
 * (`indexes[0]` on the write path, `index1` on the SQL read path).
 */
export const AE_INDEX_SERVER_ID_COLUMN = 'index1'

/** Index suffix for `"event"`-kind rows (see {@link aeIndexForFamily}). */
export const AE_EVENT_INDEX_SUFFIX = 'event'

/**
 * The `index1` value a sample row is written under.
 *
 * AE samples at write time per index value when points arrive "too quickly
 * into one index" and equalizes what it stores across index values. One
 * sample writes a burst of rows (host.system, host.io, one per NIC /
 * filesystem / block device / GPU page, …), so a single `serverId` index was
 * sampled about 1-in-2 on testing (2026-09-27: 30 of 60 minutely host
 * buckets, each carrying `_sample_interval = 2`) — the charts' amber gaps.
 *
 * `host.system` — the one-row-per-sample anchor that liveness, sample counts
 * and status rows key on — keeps the bare serverId. Every other family, and
 * event rows, get their own index `<serverId>:<family>`, so no index sees more
 * than one family's pages per sample. Readers match both spellings
 * ({@link aeIndexesForFamilies}) so rows written before the split still count.
 */
export function aeIndexForFamily(
  serverId: string,
  family: HostedFamily | typeof AE_EVENT_INDEX_SUFFIX
): string {
  return family === AE_FAMILY_HOST_SYSTEM ? serverId : `${serverId}:${family}`
}

/**
 * Every `index1` value a read over `families` for one server must match: the
 * bare serverId (host.system, status rows, and every row written before the
 * per-family split) plus each family's own index.
 */
export function aeIndexesForFamilies(
  serverId: string,
  families: readonly (HostedFamily | typeof AE_EVENT_INDEX_SUFFIX)[]
): string[] {
  const indexes = new Set<string>([serverId])
  for (const family of families) {
    indexes.add(aeIndexForFamily(serverId, family))
  }
  return [...indexes]
}

/** Physical column name for the AE ingestion timestamp. */
export const AE_TIMESTAMP_COLUMN = 'timestamp'

/** Narrow AE data-point shape mirroring Workers `AnalyticsEngineDataPoint`. */
export type AnalyticsEngineDataPointLike = {
  indexes: [string]
  doubles: number[]
  blobs: string[]
}

export function blobColumn(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= AE_BLOB_COUNT) {
    throw new TypeError(`invalid AE v5 blob index: ${index}`)
  }
  return `blob${index + 1}`
}

export function doubleColumn(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= AE_DOUBLE_COUNT) {
    throw new TypeError(`invalid AE v5 double index: ${index}`)
  }
  return `double${index + 1}`
}

/** AE column for the interval-seconds weight slot (`double20`). */
export function intervalSecondsColumn(): string {
  return doubleColumn(AE_DOUBLE_INTERVAL_INDEX)
}

/** AE column for status-row connected (1/0). */
export function statusConnectedColumn(): string {
  return doubleColumn(AE_DOUBLE_STATUS_CONNECTED_INDEX)
}

/** AE column for status-row transition reason / event-row severity. */
export function statusReasonColumn(): string {
  return blobColumn(AE_BLOB_STATUS_OR_EVENT_REASON_INDEX)
}

/** Test-only: assert doubles/blobs lengths (used by shape-drift tests). */
export function assertAnalyticsEngineDataPointShape(point: {
  doubles: number[]
  blobs: string[]
}): void {
  if (point.doubles.length !== AE_DOUBLE_COUNT) {
    throw new TypeError(`AE v5 doubles length ${point.doubles.length} !== ${AE_DOUBLE_COUNT}`)
  }
  if (point.blobs.length !== AE_BLOB_COUNT) {
    throw new TypeError(`AE v5 blobs length ${point.blobs.length} !== ${AE_BLOB_COUNT}`)
  }
}

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
function resolveNetworkSlots(
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
 * Reorder `entities` by `pageOrder` (a `SlotMapping.*PageOrder` list of
 * stable ids, sorted by id — see `topology-slot-mapping.ts`), looked up via
 * `idOf`. An entity present in the sample but not (yet) known to `pageOrder`
 * — new since the topology generation was recorded — is appended afterward
 * in its original sample order, so a device the daemon just started
 * reporting is never silently dropped while topology catches up. Without a
 * `pageOrder` (no slot mapping resolved), returns `entities` unchanged —
 * the module's original arrival-order packing.
 */
function orderByPageOrder<T>(
  entities: readonly T[],
  idOf: (entity: T) => string,
  pageOrder: readonly string[] | undefined
): T[] {
  if (!pageOrder) return [...entities]
  const byId = new Map(entities.map((entity) => [idOf(entity), entity] as const))
  const ordered: T[] = []
  for (const id of pageOrder) {
    const entity = byId.get(id)
    if (entity !== undefined) {
      ordered.push(entity)
      byId.delete(id)
    }
  }
  for (const entity of entities) {
    if (byId.has(idOf(entity))) ordered.push(entity)
  }
  return ordered
}

// ---------------------------------------------------------------------------
// Sample time
// ---------------------------------------------------------------------------

/**
 * ISO timestamp -> UTC `YYYY-MM-DD hh:mm:ss`, the one text format AE's
 * `toDateTime` documents. An unparseable input (never produced by the
 * validated ingest path) yields empty text rather than a malformed value.
 */
export function formatAeSampleTime(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
}

// ---------------------------------------------------------------------------
// Envelope builders
// ---------------------------------------------------------------------------

function capabilityPlanGenerationBlob(
  sample: MetricsSample & { capabilityPlanGeneration?: number }
): string {
  return sample.capabilityPlanGeneration === undefined
    ? ''
    : String(sample.capabilityPlanGeneration)
}

/**
 * Envelope plus content text for a `"metrics"`-kind row. `entityIds` is blob6
 * (empty on host rows); `content` fills blob7.. in order and must fit
 * {@link V7_CONTENT_BLOB_CAPACITY}.
 */
export function buildMetricsBlobs(
  sample: MetricsSample,
  family: string,
  entityIds: string,
  content: readonly string[]
): string[] {
  if (content.length > V7_CONTENT_BLOB_CAPACITY) {
    throw new TypeError(
      `${family} has ${content.length} content blobs, exceeding the ${V7_CONTENT_BLOB_CAPACITY}-blob budget`
    )
  }
  const blobs: string[] = new Array(AE_BLOB_COUNT).fill('')
  blobs[AE_BLOB_KIND_INDEX] = AE_KIND_METRICS
  blobs[AE_BLOB_FAMILY_INDEX] = family
  blobs[AE_BLOB_SCHEMA_VERSION_INDEX] = String(AE_STORAGE_VERSION)
  blobs[AE_BLOB_SAMPLED_AT_INDEX] = formatAeSampleTime(sample.metadata.sampledAt)
  blobs[AE_BLOB_ENTITY_IDS_INDEX] = entityIds
  content.forEach((text, i) => {
    blobs[V7_FIRST_CONTENT_BLOB_INDEX + i] = text
  })
  return blobs
}

/** Envelope for a `"event"`-kind row (v6 blob positions, blob3 and blob5 text as on every v7 row) — one per `sample.events` entry. */
export function buildEventBlobs(
  sample: MetricsSample & { capabilityPlanGeneration?: number },
  event: MetricEvent
): string[] {
  const blobs: string[] = new Array(AE_BLOB_COUNT).fill('')
  blobs[AE_BLOB_KIND_INDEX] = AE_KIND_EVENT
  blobs[AE_BLOB_FAMILY_INDEX] = event.kind
  blobs[AE_BLOB_SCHEMA_VERSION_INDEX] = String(AE_STORAGE_VERSION)
  blobs[AE_BLOB_SAMPLED_AT_INDEX] = formatAeSampleTime(event.at)
  blobs[AE_BLOB_SEQUENCE_INDEX] = String(sample.metadata.sequence)
  blobs[AE_BLOB_CAPABILITY_PLAN_GENERATION_INDEX] = capabilityPlanGenerationBlob(sample)
  blobs[AE_BLOB_PAGE_INDEX] = '0'
  blobs[AE_BLOB_SOURCE_OR_IDENTITY_INDEX] = event.source ?? ''
  blobs[AE_BLOB_EVENT_ENTITY_ID_INDEX] = event.entityId ?? ''
  blobs[AE_BLOB_EVENT_PAYLOAD_INDEX] = JSON.stringify(event.payload ?? {})
  blobs[AE_BLOB_EVENT_ID_INDEX] = event.eventId
  blobs[AE_BLOB_STATUS_OR_EVENT_REASON_INDEX] = event.severity
  return blobs
}

/** Envelope for a `"status"`-kind row — connection-status transitions. */
export function buildStatusBlobs(event: ServerStatusEvent): string[] {
  const blobs: string[] = new Array(AE_BLOB_COUNT).fill('')
  blobs[AE_BLOB_KIND_INDEX] = AE_KIND_STATUS
  blobs[AE_BLOB_SCHEMA_VERSION_INDEX] = String(AE_STORAGE_VERSION)
  blobs[AE_BLOB_STATUS_OR_EVENT_REASON_INDEX] = event.reason
  return blobs
}

/** Build the AE v5 data point for a connection-status transition. */
export function buildStatusDataPoint(event: ServerStatusEvent): AnalyticsEngineDataPointLike {
  const doubles = new Array<number>(AE_DOUBLE_COUNT).fill(AE_MISSING_METRIC_SENTINEL)
  doubles[AE_DOUBLE_STATUS_CONNECTED_INDEX] = event.connected ? 1 : 0

  const point: AnalyticsEngineDataPointLike = {
    indexes: [event.serverId],
    doubles,
    blobs: buildStatusBlobs(event),
  }
  assertAnalyticsEngineDataPointShape(point)
  return point
}

function buildEventDataPoint(
  sample: AuthenticatedMetricsSample,
  event: MetricEvent
): AnalyticsEngineDataPointLike {
  const doubles = new Array<number>(AE_DOUBLE_COUNT).fill(AE_MISSING_METRIC_SENTINEL)
  // Event rows carry the interval weight like every other `"metrics"`-shaped
  // row. v4 left this slot at the sentinel, contradicting its own documented
  // invariant; the row-count test asserted the invariant but no fixture
  // carried an event, so it never fired.
  doubles[AE_DOUBLE_INTERVAL_INDEX] = sample.metadata.intervalSeconds
  const point: AnalyticsEngineDataPointLike = {
    indexes: [aeIndexForFamily(sample.serverId, AE_EVENT_INDEX_SUFFIX)],
    doubles,
    blobs: buildEventBlobs(sample, event),
  }
  assertAnalyticsEngineDataPointShape(point)
  return point
}

// ---------------------------------------------------------------------------
// Row building
// ---------------------------------------------------------------------------

const NULL_TO_SENTINEL = (value: number | null): number => value ?? AE_MISSING_METRIC_SENTINEL

function v7Point(
  sample: AuthenticatedMetricsSample,
  family: string,
  entityIds: string,
  values: V7RowValues
): AnalyticsEngineDataPointLike {
  const doubles = new Array<number>(AE_DOUBLE_COUNT).fill(AE_MISSING_METRIC_SENTINEL)
  values.doubles.forEach((value, i) => {
    doubles[i] = NULL_TO_SENTINEL(value)
  })
  doubles[AE_DOUBLE_INTERVAL_INDEX] = sample.metadata.intervalSeconds
  const point: AnalyticsEngineDataPointLike = {
    indexes: [aeIndexForFamily(sample.serverId, family as HostedFamily)],
    doubles,
    blobs: buildMetricsBlobs(sample, family, entityIds, values.blobs),
  }
  assertAnalyticsEngineDataPointShape(point)
  return point
}

function buildV7Context(
  sample: AuthenticatedMetricsSample,
  nics: readonly [NetworkDeviceSample | undefined, NetworkDeviceSample | undefined]
): V7Context {
  return {
    sample,
    nics,
    foldedFilesystem: sample.filesystems.length === 1 ? sample.filesystems[0] : undefined,
    ingress:
      sample.ingressSources.find((s) => s.sourceKind === 'caddy') ?? sample.ingressSources[0],
    proxy: sample.databaseProxies[0],
  }
}

function entityPoints(
  sample: AuthenticatedMetricsSample,
  family: string,
  pages: readonly V7EntityPage[]
): AnalyticsEngineDataPointLike[] {
  return pages.map((page) => v7Point(sample, family, page.ids, page))
}

/** Paged entity rows, in fixture order: block, network, filesystem, gpu, hardware.physical. */
function buildEntityPoints(
  sample: AuthenticatedMetricsSample,
  pagedNetworks: readonly NetworkDeviceSample[],
  slotMapping: SlotMapping | undefined
): AnalyticsEngineDataPointLike[] {
  // One drive is already covered by host.io; exactly one extra filesystem is
  // folded into host.network.
  const blocks =
    sample.blockDevices.length > 1
      ? orderByPageOrder(sample.blockDevices, (d) => d.deviceId, slotMapping?.blockPageOrder)
      : []
  const filesystems =
    sample.filesystems.length > 1
      ? orderByPageOrder(
          sample.filesystems,
          (f) => f.filesystemId,
          slotMapping?.filesystemPageOrder
        )
      : []
  const gpus = orderByPageOrder(sample.gpus, (g) => g.gpuId, slotMapping?.gpuPageOrder)
  const signals = orderByPageOrder(
    sample.hardwareSignals,
    (h) => h.signalId,
    slotMapping?.hardwareSignalPageOrder
  )
  return [
    ...entityPoints(sample, AE_FAMILY_BLOCK, v7EntityPages.block(blocks, sample)),
    ...entityPoints(sample, AE_FAMILY_NETWORK, v7EntityPages.network(pagedNetworks, sample)),
    ...entityPoints(sample, AE_FAMILY_FILESYSTEM, v7EntityPages.filesystem(filesystems, sample)),
    ...entityPoints(sample, AE_FAMILY_GPU, v7EntityPages.gpu(gpus, sample)),
    ...entityPoints(
      sample,
      AE_FAMILY_HARDWARE_PHYSICAL,
      v7EntityPages['hardware.physical'](signals, sample)
    ),
  ]
}

/**
 * Build every AE data point for one authenticated sample (v6- or v7-shaped).
 *
 * `host.system`, `host.io`, `host.network` and `host.web` are always emitted
 * (one row each, even if every value is missing); `managed.database` only
 * when the sample carries managed-database data. Entity rows are
 * presence-gated (see the module doc comment), then one `"event"`-kind row
 * per `sample.events` entry. Order is deterministic.
 *
 * `slotMapping` drives identity-addressed packing for the embedded NICs and
 * every paged family's entity order.
 */
export function buildMetricsDataPoints(
  sample: AuthenticatedMetricsSample,
  slotMapping?: SlotMapping
): AnalyticsEngineDataPointLike[] {
  const { nic0, nic1, paged } = resolveNetworkSlots(sample.networks, slotMapping)
  const ctx = buildV7Context(sample, [nic0, nic1])
  const points: AnalyticsEngineDataPointLike[] = []

  for (const family of V7_HOST_FAMILIES) {
    if (family === AE_FAMILY_MANAGED_DATABASE && !hasManagedDatabase(sample)) continue
    points.push(
      v7Point(sample, family, v7HostRowEntityIds(family, ctx), v7HostRowValues(family, ctx))
    )
  }
  points.push(...buildEntityPoints(sample, paged, slotMapping))
  for (const event of sample.events) {
    points.push(buildEventDataPoint(sample, event))
  }
  return capToInvocationLimit(points, sample.serverId)
}

/**
 * Analytics Engine accepts at most this many data points per Worker
 * invocation. A metrics sample is written as one invocation, so this is a
 * hard ceiling on rows per sample, not a soft budget.
 *
 * https://developers.cloudflare.com/analytics/analytics-engine/limits/
 */
export const AE_MAX_DATA_POINTS_PER_INVOCATION = 250

/**
 * Families kept first when a sample would otherwise breach the invocation
 * limit, most important first. Anything not listed is lower priority than
 * everything listed.
 *
 * `host.system`/`host.io` are the mandatory baseline — losing them loses the
 * sample's identity and every universal metric. Event rows come next: they
 * are discrete state transitions (OOM kills, disk faults, link flaps) that
 * nothing else re-reports, so dropping one loses it permanently, whereas a
 * dropped entity row is one missing point in a continuous series.
 */
function invocationPriority(point: AnalyticsEngineDataPointLike): number {
  const kind = point.blobs?.[AE_BLOB_KIND_INDEX]
  if (kind === AE_KIND_METRICS) {
    const family = point.blobs?.[AE_BLOB_FAMILY_INDEX]
    if (
      V7_HOST_FAMILIES.includes(family as V7HostFamily) &&
      family !== AE_FAMILY_MANAGED_DATABASE
    ) {
      return 0
    }
    return 2
  }
  if (kind === AE_KIND_EVENT) return 1
  return 2
}

/**
 * Enforce {@link AE_MAX_DATA_POINTS_PER_INVOCATION}.
 *
 * The capability plan keeps a real machine an order of magnitude below this
 * — the platform default tops out around 8 rows — but the plan does not bound
 * every family: `ingressSources`/`databaseProxies` are gated by a boolean
 * rather than a count, and their cardinality is scrape-derived, so a host
 * running many ingress sources alongside an event burst can reach the limit
 * with no plan override at all. The contract's own 64-entry array cap plus
 * 128 events allows 355 points in the worst case.
 *
 * Exceeding the limit is not a partial failure — the whole invocation is
 * rejected — so silently shedding the lowest-priority rows is strictly better
 * than losing the sample. Truncation is logged because it means a server is
 * reporting more than the plan intended, which is a configuration problem
 * worth seeing rather than absorbing.
 *
 * Stable-sorted by priority so the kept rows stay in emission order within
 * each tier, keeping page indices contiguous for the read path.
 */
function capToInvocationLimit(
  points: AnalyticsEngineDataPointLike[],
  serverId: string
): AnalyticsEngineDataPointLike[] {
  if (points.length <= AE_MAX_DATA_POINTS_PER_INVOCATION) return points
  const ordered = points
    .map((point, index) => ({
      point,
      index,
      priority: invocationPriority(point),
    }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .slice(0, AE_MAX_DATA_POINTS_PER_INVOCATION)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.point)
  console.warn(
    `metrics: sample for ${serverId} produced ${points.length} Analytics Engine data points, ` +
      `over the ${AE_MAX_DATA_POINTS_PER_INVOCATION}-per-invocation limit; ` +
      `dropped ${points.length - ordered.length} lowest-priority rows`
  )
  return ordered
}

// ---------------------------------------------------------------------------
// Module-load invariants
// ---------------------------------------------------------------------------

function assertV7LayoutWithinBudgets(): void {
  if (AE_DOUBLE_INTERVAL_INDEX !== 19) {
    throw new TypeError('AE_DOUBLE_INTERVAL_INDEX must be 19 (double20)')
  }
  if (V7_FIRST_CONTENT_BLOB_INDEX + V7_CONTENT_BLOB_CAPACITY !== AE_BLOB_COUNT) {
    throw new TypeError('v7 content blobs must fill blob7..blob20 exactly')
  }
  for (const [family, width] of Object.entries(V7_ENTITY_FIELD_ORDER)) {
    const perPage = V7_ENTITIES_PER_PAGE[family as keyof typeof V7_ENTITY_FIELD_ORDER]
    if (perPage * width.length > AE_METRIC_DOUBLE_SLOT_COUNT) {
      throw new TypeError(
        `${family} pages overflow the ${AE_METRIC_DOUBLE_SLOT_COUNT}-slot AE page`
      )
    }
  }
}
assertV7LayoutWithinBudgets()

/** Exposed for tests that need to exercise the throw behavior without waiting on module-load side effects. */
export const _internalFieldMap = {
  assertV7LayoutWithinBudgets,
  capToInvocationLimit,
}

// ---------------------------------------------------------------------------
// Query-side lookups: the read path (`sql-api.ts`) resolves a requested
// canonical/field name to its physical AE double slot through these, so the
// layout stays this module's (and v7-layout.ts's) only copy.
// ---------------------------------------------------------------------------

/** Entities per page for an entity family (`floor(19 / width)`, or the family's own page size). */
export function entitiesPerPage(width: number): number {
  return Math.floor(AE_METRIC_DOUBLE_SLOT_COUNT / width)
}

/** Per-entity-family field order (a `null` entry is a slot with no descriptor), keyed by family. */
export { V7_ENTITY_FIELD_ORDER as PER_ENTITY_FIELD_ORDER } from './v7-layout.ts'

/** The queryable (non-null) field names of an entity family, in slot order. */
export function queryableEntityFields(family: keyof typeof V7_ENTITY_FIELD_ORDER): string[] {
  return V7_ENTITY_FIELD_ORDER[family].filter((field): field is string => field !== null)
}

/**
 * The only `network`-family fields individually reconstructable from
 * `host.network`'s embedded NIC slots: rx/tx embed verbatim, but the error and
 * drop rates are only ever embedded pre-summed as one combined problem-packets
 * rate, with no way to recover the components.
 */
export const HOST_IO_EMBEDDED_NIC_FIELDS = [
  'receiveBytesPerSecond',
  'transmitBytesPerSecond',
] as const

/** 0-based `host.network` double index for embedded NIC `slot` (`0` = `normalNicSlots[0]`). */
export function hostIoEmbeddedNicDoubleIndex(
  slot: 0 | 1,
  field: (typeof HOST_IO_EMBEDDED_NIC_FIELDS)[number]
): number {
  return v7EmbeddedNicDoubleIndex(slot, field === 'receiveBytesPerSecond' ? 'rx' : 'tx')
}

/**
 * Single-source families (`managed.ingress`, `managed.database_proxy`): the
 * field names laid out by physical double index on the host row that carries
 * them, so `indexOf(field)` is the slot. They are no longer rows of their own.
 */
export { V7_SINGLE_SOURCE_FIELD_ORDER as SINGLE_ROW_FIELD_ORDER } from './v7-layout.ts'

/**
 * Resolve a host-scoped field to its physical AE slot: which v7 host row
 * carries it and its 0-based double index. `undefined` when v7 does not store
 * the field (dropped from the layout, or no slot yet).
 */
export function findHostFieldSlot(
  scope: MetricEntityScope,
  field: string
): { family: V7HostFamily; doubleIndex: number } | undefined {
  return v7HostSlotFor(scope, field)
}

/** As {@link findHostFieldSlot}, throwing for a field v7 does not store. */
export function doubleIndexForHostField(
  scope: MetricEntityScope,
  field: string
): { family: V7HostFamily; doubleIndex: number } {
  const slot = v7HostSlotFor(scope, field)
  if (!slot) throw new TypeError(`no AE v7 host double slot for field "${scope}.${field}"`)
  return slot
}

/**
 * 0-based double index for entity `slotPosition` (0-based, within a page of
 * `width`-wide entities) and `fieldIndex` (0-based, within that family's
 * field order).
 */
export function slotDoubleIndex(width: number, slotPosition: number, fieldIndex: number): number {
  return slotPosition * width + fieldIndex
}
