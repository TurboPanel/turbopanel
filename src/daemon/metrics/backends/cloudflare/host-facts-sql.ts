/**
 * Hosted read of the latest host facts: the content text blobs the v7 layout
 * writes beside the numbers (`V8-LAYOUT.md`). One statement fetches the newest
 * rows of the host families plus the drive and GPU pages in the window; the
 * newest sample's rows are then read blob by blob using the same layout tables
 * the writer packs with (`v8-layout.ts`), so reader and writer cannot drift.
 */
import {
  presentBlockDeviceFacts,
  presentFilesystemFacts,
  presentGpuFacts,
  presentHostText,
  presentNetworkFacts,
  emptyHostFacts,
} from '../../query/host-facts.ts'
import type { HostFacts, HostFactsQuery, HostFactsResult } from '../../types.ts'
import {
  AE_DATASET_NAME,
  AE_TIMESTAMP_COLUMN,
  blobColumn,
  AE_BLOB_ENTITY_IDS_INDEX,
  AE_BLOB_FAMILY_INDEX,
  AE_BLOB_SAMPLED_AT_INDEX,
} from './field-map.ts'
import {
  AE_DEFAULT_MAX_RANGE_SECONDS,
  assertIsoTimestamp,
  assertRange,
  assertSafeDatasetName,
  assertSafeServerId,
  CloudflareAnalyticsSqlClient,
  hostMetricsDiscriminatorPredicates,
  quoteSqlString,
  serverFamiliesPredicate,
  timeRangePredicate,
  type CloudflareAnalyticsSqlConfig,
} from './sql-api.ts'
import {
  V8_CONTENT_BLOB_CAPACITY,
  V8_ENTITY_TEXT_FIELDS,
  V8_FIRST_CONTENT_BLOB_INDEX,
  V8_HOST_FAMILIES,
  v8HostRowTextKeys,
} from './v8-layout.ts'

/**
 * Families that carry text: every v7 host row (those with text blobs) plus the pages of devices that
 * have their own row (drives, GPUs, NICs beyond the two embedded ones, extra filesystems).
 */
const FACT_ENTITY_FAMILIES = ['block', 'gpu', 'network', 'filesystem'] as const
const FACT_FAMILIES = [
  ...V8_HOST_FAMILIES.filter((family) => v8HostRowTextKeys(family).length > 0),
  ...FACT_ENTITY_FAMILIES,
] as const

/**
 * Newest rows read per statement. One sample is at most a handful of host rows
 * plus the device pages (24 drives, GPUs and NICs and 24 filesystems are 8 + 8 + 8 + 3
 * pages at most), so the newest sample always fits; older ones are ignored by sample time.
 */
const FACT_ROW_LIMIT = 96

const CONTENT_BLOB_COLUMNS = Array.from({ length: V8_CONTENT_BLOB_CAPACITY }, (_, index) =>
  blobColumn(V8_FIRST_CONTENT_BLOB_INDEX + index)
)

export function buildHostFactsSql(
  input: HostFactsQuery,
  opts: { dataset: string; maxRangeSeconds: number }
): string {
  const serverId = assertSafeServerId(input.serverId)
  const from = assertIsoTimestamp('from', input.from)
  const to = assertIsoTimestamp('to', input.to)
  assertRange(from, to, opts.maxRangeSeconds)
  assertSafeDatasetName(opts.dataset)

  const fromUnix = Math.floor(from.getTime() / 1000)
  const toUnix = Math.floor(to.getTime() / 1000)
  const discriminators = hostMetricsDiscriminatorPredicates()
  const familyColumn = blobColumn(AE_BLOB_FAMILY_INDEX)
  const familyList = FACT_FAMILIES.map(quoteSqlString).join(', ')

  return [
    'SELECT',
    `  ${familyColumn} AS family,`,
    `  ${blobColumn(AE_BLOB_SAMPLED_AT_INDEX)} AS sampled,`,
    `  ${blobColumn(AE_BLOB_ENTITY_IDS_INDEX)} AS ids,`,
    ...CONTENT_BLOB_COLUMNS.map(
      (column, index) => `  ${column}${index === CONTENT_BLOB_COLUMNS.length - 1 ? '' : ','}`
    ),
    `FROM ${opts.dataset}`,
    `WHERE ${serverFamiliesPredicate(serverId, FACT_FAMILIES)}`,
    `  AND ${discriminators[0]}`,
    `  AND ${discriminators[1]}`,
    `  AND ${familyColumn} IN (${familyList})`,
    `  AND ${timeRangePredicate(fromUnix, toUnix)}`,
    `ORDER BY ${AE_TIMESTAMP_COLUMN} DESC`,
    `LIMIT ${FACT_ROW_LIMIT}`,
  ].join('\n')
}

type FactRow = Record<string, unknown>

function text(raw: unknown): string {
  return typeof raw === 'string' ? raw : ''
}

/** Content blob `index` (0 = blob7) of a result row. */
function contentBlob(row: FactRow, index: number): string {
  return text(row[CONTENT_BLOB_COLUMNS[index]!])
}

function rowSampleKey(row: FactRow): string {
  return text(row.sampled)
}

/** Rows of `family` within `rows` (already narrowed to the newest sample). */
function rowsOfFamily(rows: readonly FactRow[], family: string): FactRow[] {
  return rows.filter((row) => text(row.family) === family)
}

/** `YYYY-MM-DD hh:mm:ss` (UTC, the stored sample time) as an ISO timestamp, or `null` if malformed. */
function sampleTimeToIso(sampled: string): string | null {
  const ms = Date.parse(`${sampled.replace(' ', 'T')}Z`)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function parseHostText(rows: readonly FactRow[]): HostFacts['text'] {
  const merged: Record<string, string> = {}
  for (const family of V8_HOST_FAMILIES) {
    const keys = v8HostRowTextKeys(family)
    const row = rowsOfFamily(rows, family)[0]
    if (!row) continue
    keys.forEach((key, index) => {
      merged[key] = contentBlob(row, index)
    })
  }
  return presentHostText(merged)
}

/** Entity text of one paged family: entity `i` of a page owns the `i`-th group of blobs, in id order. */
function parseEntityText<K extends string>(
  rows: readonly FactRow[],
  fields: readonly K[]
): { id: string; text: Record<K, string> }[] {
  const entities: { id: string; text: Record<K, string> }[] = []
  for (const row of rows) {
    const ids = text(row.ids)
    if (ids.length === 0) continue
    ids.split(',').forEach((id, entityIndex) => {
      const values = {} as Record<K, string>
      fields.forEach((field, fieldIndex) => {
        values[field] = contentBlob(row, entityIndex * fields.length + fieldIndex)
      })
      entities.push({ id, text: values })
    })
  }
  return entities
}

/** `<bytes>/<inodes>` (either side may be empty) as the two sizes. */
function parseFilesystemSizeText(raw: string): { totalBytes?: string; totalInodes?: string } {
  const [bytes = '', inodes = ''] = raw.split('/')
  return { totalBytes: bytes, totalInodes: inodes }
}

/**
 * The two NICs embedded in `host.network` are named in its blob6
 * (`nic1=<id>@<Mb/s>;nic2=<id>@<Mb/s>;fs=<id>`), with the link speed after the `@`.
 */
function parseEmbeddedNicSpeeds(
  rows: readonly FactRow[]
): { deviceId: string; linkSpeedMbps: string }[] {
  const nics: { deviceId: string; linkSpeedMbps: string }[] = []
  for (const row of rows) {
    for (const part of text(row.ids).split(';')) {
      const match = /^nic[12]=(.+)@(\d*)$/.exec(part)
      if (match) nics.push({ deviceId: match[1]!, linkSpeedMbps: match[2]! })
    }
  }
  return nics
}

/**
 * Facts from the newest sample in the result. Only that sample's rows count, so
 * a drive or GPU that has since gone away is not listed from an older sample.
 */
export function parseHostFactsRows(allRows: readonly FactRow[]): {
  sampledAt: string | null
  facts: HostFacts
} {
  const newestKey = allRows.map(rowSampleKey).reduce((a, b) => (b > a ? b : a), '')
  if (newestKey === '') return { sampledAt: null, facts: emptyHostFacts() }
  const rows = allRows.filter((row) => rowSampleKey(row) === newestKey)

  const blockFields = V8_ENTITY_TEXT_FIELDS.block
  const gpuFields = V8_ENTITY_TEXT_FIELDS.gpu
  const filesystemFields = V8_ENTITY_TEXT_FIELDS.filesystem
  const networkFields = V8_ENTITY_TEXT_FIELDS.network
  return {
    sampledAt: sampleTimeToIso(newestKey),
    facts: {
      text: parseHostText(rows),
      blockDevices: presentBlockDeviceFacts(
        parseEntityText(rowsOfFamily(rows, 'block'), blockFields).map(({ id, text }) => ({
          deviceId: id,
          ...text,
        }))
      ),
      gpus: presentGpuFacts(
        parseEntityText(rowsOfFamily(rows, 'gpu'), gpuFields).map(({ id, text }) => ({
          gpuId: id,
          driver: text.driver,
          model: text.model,
          memoryTotalBytes: text.memoryTotal,
        }))
      ),
      filesystems: presentFilesystemFacts(
        parseEntityText(rowsOfFamily(rows, 'filesystem'), filesystemFields).map(({ id, text }) => ({
          filesystemId: id,
          ...parseFilesystemSizeText(text.size),
        }))
      ),
      networks: presentNetworkFacts([
        ...parseEmbeddedNicSpeeds(rowsOfFamily(rows, 'host.network')),
        ...parseEntityText(rowsOfFamily(rows, 'network'), networkFields).map(({ id, text }) => ({
          deviceId: id,
          linkSpeedMbps: text.linkSpeed,
        })),
      ]),
    },
  }
}

export async function queryHostFactsViaSqlApi(
  config: CloudflareAnalyticsSqlConfig,
  input: HostFactsQuery
): Promise<HostFactsResult> {
  const dataset = config.dataset ?? AE_DATASET_NAME
  const maxRangeSeconds = config.maxRangeSeconds ?? AE_DEFAULT_MAX_RANGE_SECONDS
  const sql = buildHostFactsSql(input, { dataset, maxRangeSeconds })
  const client = new CloudflareAnalyticsSqlClient(config)
  const result = await client.executeSql(sql, 'hostFacts')
  const { sampledAt, facts } = parseHostFactsRows(result.data)
  return {
    kind: 'analytics-engine',
    available: true,
    serverId: input.serverId,
    sampledAt,
    facts,
  }
}
