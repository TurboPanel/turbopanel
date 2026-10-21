/**
 * The field registry against both stores. These checks need no database: the
 * hosted layout is read from `backends/cloudflare/v8-layout.ts` and the
 * self-hosted columns from the DDL in `backends/duckdb/schema.ts`.
 *
 * Run alone with `pnpm check:metrics-parity`.
 */
import { assert, assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import { METRICS_TEXT_FIELD_NAMES, type MetricsSample } from '../../contracts/metrics-contract.ts'
import {
  V8_ENTITY_FIELD_ORDER,
  V8_HOST_ROW_SPECS,
  v8EntityPages,
  v8HostRowValues,
  v8HostSlotFor,
  type V8EntityFamily,
  type V8HostFamily,
} from './backends/cloudflare/v8-layout.ts'
import { buildSchemaStatements } from './backends/duckdb/schema.ts'
import {
  ENVELOPE_FIELDS,
  KNOWN_GAPS,
  NOT_STORED_FIELDS,
  REGISTRY_TABLES,
  ROW_CADENCE,
  STORED_FIELDS,
  STRUCTURAL_COLUMNS,
  type RegistryHostedHome,
  type StoredField,
} from './field-registry.ts'
import { HOST_METRICS_METRIC_DESCRIPTORS } from './metric-descriptors.ts'

const HOST_ROWS = Object.keys(V8_HOST_ROW_SPECS) as V8HostFamily[]
const ENTITY_ROWS = Object.keys(V8_ENTITY_FIELD_ORDER) as V8EntityFamily[]

const ENTITY_SCOPE_ROW: Readonly<Record<string, V8EntityFamily>> = {
  network: 'network',
  filesystem: 'filesystem',
  block: 'block',
  gpu: 'gpu',
  hardwareSignal: 'hardware.physical',
}

/** Stored values that are not contract descriptors (sizes, link speed, the NIC sum, device and host facts). */
const NON_DESCRIPTOR_NUMBERS = [
  'network.problemsPerSecond',
  'network.linkSpeedMbps',
  'filesystem.totalBytes',
  'filesystem.totalInodes',
  'gpu.memoryTotalBytes',
]

function homesOf(field: StoredField): RegistryHostedHome[] {
  return [field.hosted, ...(field.hostedAlso ?? [])]
}

function duckdbColumns(): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>()
  for (const statement of buildSchemaStatements()) {
    const match = /^CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*)\)$/.exec(statement)
    if (!match) continue
    const columns = match[2].split(',\n').map((line) => line.trim().split(' ')[0])
    tables.set(match[1], new Set(columns))
  }
  return tables
}

const sorted = (values: Iterable<string>): string[] => [...values].sort()

describe('field registry: coverage', () => {
  it('lists every contract value exactly once, stored or not stored', () => {
    const stored = new Set(STORED_FIELDS.map((f) => f.id))
    const notStored = new Set(NOT_STORED_FIELDS.map((f) => f.id))
    assertEquals(stored.size, STORED_FIELDS.length, 'duplicate stored id')
    assertEquals(notStored.size, NOT_STORED_FIELDS.length, 'duplicate not-stored id')
    for (const id of Object.keys(HOST_METRICS_METRIC_DESCRIPTORS)) {
      assert(
        stored.has(id) !== notStored.has(id),
        `${id} must be in exactly one of stored and not stored`
      )
    }
    const unknownNotStored = [...notStored].filter((id) => !(id in HOST_METRICS_METRIC_DESCRIPTORS))
    assertEquals(unknownNotStored, [], 'not-stored ids must be contract descriptors')
  })

  it('knows every stored value that is not a descriptor', () => {
    const extra = STORED_FIELDS.filter(
      (f) => f.kind === 'number' && !(f.id in HOST_METRICS_METRIC_DESCRIPTORS)
    ).map((f) => f.id)
    assertEquals(sorted(extra), sorted(NON_DESCRIPTOR_NUMBERS))
  })

  it('stores every host fact the contract names', () => {
    const textIds = STORED_FIELDS.filter((f) => f.id.startsWith('text.')).map((f) => f.id)
    assertEquals(sorted(textIds), sorted(METRICS_TEXT_FIELD_NAMES.map((key) => `text.${key}`)))
  })

  it('writes every stored value every sample', () => {
    for (const field of STORED_FIELDS) assertEquals(field.cadence, 'every-sample', field.id)
    for (const field of STORED_FIELDS) {
      for (const home of homesOf(field)) {
        assert(home.row in ROW_CADENCE, `${field.id}: no cadence for row ${home.row}`)
        assertEquals(ROW_CADENCE[home.row], 'every-sample', `${field.id} lives on ${home.row}`)
      }
    }
  })

  it('gives every value one self-hosted home and one hosted home', () => {
    const duckdb = STORED_FIELDS.map((f) => `${f.duckdb.table}.${f.duckdb.column}`)
    assertEquals(new Set(duckdb).size, duckdb.length, 'two values share a self-hosted column')
    const hosted = STORED_FIELDS.filter((f) => f.encoding === 'same').flatMap((f) =>
      homesOf(f).map((home) => JSON.stringify(home))
    )
    assertEquals(new Set(hosted).size, hosted.length, 'two values share a hosted slot')
  })
})

describe('field registry: hosted layout', () => {
  const pending = new Set(KNOWN_GAPS.hostedMissing)
  const fields = STORED_FIELDS.filter((f) => !pending.has(f.id))

  it('uses exactly the number slots the host rows use', () => {
    for (const row of HOST_ROWS) {
      const used = V8_HOST_ROW_SPECS[row].doubles.flatMap((id, i) => (id === null ? [] : [i + 1]))
      const registered = fields.flatMap((f) =>
        homesOf(f).flatMap((home) => (home.row === row && 'double' in home ? [home.double] : []))
      )
      assertEquals(sorted(registered.map(String)), sorted(used.map(String)), row)
    }
  })

  it('uses exactly the device fields the device rows use', () => {
    for (const row of ENTITY_ROWS) {
      const used = V8_ENTITY_FIELD_ORDER[row].flatMap((f, i) => (f === null ? [] : [i + 1]))
      const registered = fields.flatMap((f) =>
        homesOf(f).flatMap((home) =>
          home.row === row && 'entityDouble' in home ? [home.entityDouble] : []
        )
      )
      assertEquals(sorted(registered.map(String)), sorted(used.map(String)), row)
    }
  })

  it('puts each reading where the hosted reader looks for it', () => {
    for (const field of fields) {
      const descriptor = HOST_METRICS_METRIC_DESCRIPTORS[field.id]
      if (!descriptor || field.kind !== 'number') continue
      const home = field.hosted
      if ('double' in home) {
        const slot = v8HostSlotFor(descriptor.entityScope, descriptor.fieldName)
        assertEquals(slot, { family: home.row, doubleIndex: home.double - 1 }, field.id)
      } else if ('entityDouble' in home) {
        const row = ENTITY_SCOPE_ROW[descriptor.entityScope]
        assertEquals(row, home.row, field.id)
        assertEquals(V8_ENTITY_FIELD_ORDER[row][home.entityDouble - 1], descriptor.fieldName)
      } else {
        throw new Error(`${field.id}: a reading must live in a number slot`)
      }
    }
  })

  it('stores nothing for a value marked not stored', () => {
    for (const { id } of NOT_STORED_FIELDS) {
      const descriptor = HOST_METRICS_METRIC_DESCRIPTORS[id]
      assertEquals(v8HostSlotFor(descriptor.entityScope, descriptor.fieldName), undefined, id)
      const row = ENTITY_SCOPE_ROW[descriptor.entityScope]
      if (row) assert(!V8_ENTITY_FIELD_ORDER[row].includes(descriptor.fieldName), id)
    }
  })

  it('writes each host fact into the text slot the registry names', () => {
    const text = Object.fromEntries(METRICS_TEXT_FIELD_NAMES.map((key) => [key, `v-${key}`]))
    const sample = { host: {}, extended: { text } } as unknown as MetricsSample
    const ctx = {
      sample,
      nics: [undefined, undefined] as const,
      foldedFilesystem: undefined,
      ingress: undefined,
      proxy: undefined,
    }
    let checked = 0
    for (const row of HOST_ROWS) {
      const blobs = v8HostRowValues(row, ctx).blobs
      for (const field of fields) {
        const home = field.hosted
        if (!field.id.startsWith('text.') || home.row !== row || !('blob' in home)) continue
        assertEquals(blobs[home.blob - 7], `v-${field.id.slice('text.'.length)}`, field.id)
        checked++
      }
      assertEquals(
        blobs.length,
        fields.filter((f) => f.id.startsWith('text.') && f.hosted.row === row).length,
        row
      )
    }
    assertEquals(checked, METRICS_TEXT_FIELD_NAMES.length)
  })

  it('writes each device fact into the text slot the registry names', () => {
    const sample = {
      host: {},
      extended: {
        blockDeviceText: [{ deviceId: 'b1', model: 'block-model', smart: 'block-smart' }],
        gpuText: [{ gpuId: 'g1', driver: 'gpu-driver', model: 'gpu-model' }],
        gpuSizes: [{ gpuId: 'g1', memoryTotalBytes: 77 }],
        networkSizes: [{ deviceId: 'n1', linkSpeedMbps: 1000 }],
        filesystemSizes: [{ filesystemId: 'f1', totalBytes: 5, totalInodes: 6 }],
      },
    } as unknown as MetricsSample
    const pages = {
      block: v8EntityPages.block([{ deviceId: 'b1' }] as never, sample)[0].blobs,
      gpu: v8EntityPages.gpu([{ gpuId: 'g1' }] as never, sample)[0].blobs,
      network: v8EntityPages.network([{ deviceId: 'n1' }] as never, sample)[0].blobs,
      filesystem: v8EntityPages.filesystem([{ filesystemId: 'f1' }] as never, sample)[0].blobs,
    }
    const expected: Record<string, string> = {
      'block.model': 'block-model',
      'block.smart': 'block-smart',
      'gpu.driver': 'gpu-driver',
      'gpu.model': 'gpu-model',
      'gpu.memoryTotalBytes': '77',
      'network.linkSpeedMbps': '1000',
      'filesystem.totalBytes': '5/6',
      'filesystem.totalInodes': '5/6',
    }
    for (const [id, value] of Object.entries(expected)) {
      const field = STORED_FIELDS.find((f) => f.id === id)!
      const home = field.hosted
      assert('entityBlob' in home, id)
      const blobs = pages[home.row as keyof typeof pages]
      assertEquals(blobs[home.entityBlob - 1], value, id)
    }
    for (const row of Object.keys(pages) as (keyof typeof pages)[]) {
      const positions = new Set(
        STORED_FIELDS.flatMap((f) =>
          'entityBlob' in f.hosted && f.hosted.row === row ? [f.hosted.entityBlob] : []
        )
      )
      assertEquals(positions.size, pages[row].length, row)
    }
  })
})

describe('field registry: self-hosted columns', () => {
  const tables = duckdbColumns()
  const tableName = (key: keyof typeof REGISTRY_TABLES) => REGISTRY_TABLES[key]

  it('has exactly the registered columns, apart from the known gaps', () => {
    const missing = STORED_FIELDS.filter(
      (f) => !tables.get(tableName(f.duckdb.table))?.has(f.duckdb.column)
    ).map((f) => f.id)
    assertEquals(sorted(missing), sorted(KNOWN_GAPS.duckdbMissing))

    const allowed = new Set<string>()
    for (const f of STORED_FIELDS) allowed.add(`${tableName(f.duckdb.table)}.${f.duckdb.column}`)
    for (const key of Object.keys(REGISTRY_TABLES) as (keyof typeof REGISTRY_TABLES)[]) {
      for (const column of STRUCTURAL_COLUMNS[key]) allowed.add(`${tableName(key)}.${column}`)
      for (const envelope of ENVELOPE_FIELDS) allowed.add(`${tableName(key)}.${envelope.duckdb}`)
    }
    const extra: string[] = []
    for (const [table, columns] of tables) {
      if (!(Object.values(REGISTRY_TABLES) as string[]).includes(table)) continue
      for (const column of columns)
        if (!allowed.has(`${table}.${column}`)) extra.push(`${table}.${column}`)
    }
    assertEquals(sorted(extra), sorted(KNOWN_GAPS.duckdbExtraColumns))
  })

  it('lists no gap column that is already gone', () => {
    for (const entry of KNOWN_GAPS.duckdbExtraColumns) {
      const [table, column] = entry.split('.')
      assert(tables.get(table)?.has(column), `${entry} is listed as a gap but has no column`)
    }
  })

  it('lists no gap that has already closed', () => {
    for (const id of KNOWN_GAPS.duckdbMissing) {
      assert(
        STORED_FIELDS.some((f) => f.id === id),
        `${id} is not a registered value`
      )
    }
    for (const id of KNOWN_GAPS.hostedMissing) {
      assert(
        STORED_FIELDS.some((f) => f.id === id),
        `${id} is not a registered value`
      )
    }
  })
})
