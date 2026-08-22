/**
 * Shared behavioural conformance suite for every `ContainerLogStore` driver.
 *
 * Parameterized over `ClickHouseContainerLogStore` (Deno) and
 * `PipelinesIcebergContainerLogStore` (Workers) behind fake transports, so
 * driver **parity** is asserted once here instead of being re-assumed in each
 * driver's own test file. Those per-driver files still cover what is genuinely
 * backend-specific (SQL dialect, schema DDL, envelope parsing); this file
 * covers only what `types.ts` promises callers.
 *
 * The fakes echo rows rather than executing SQL: the round-trip case proves a
 * driver maps the contract onto its storage columns and back without loss, not
 * that the backend filters correctly.
 */

import { assert, assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import { ClickHouseContainerLogStore } from './clickhouse/store.ts'
import { PipelinesIcebergContainerLogStore } from './cloudflare/pipeline-store.ts'
import type { PipelineLike } from './cloudflare/pipeline-store.ts'
import {
  MAX_CONTAINER_LOG_QUERY_LIMIT,
  type ContainerLogEvent,
  type ContainerLogStore,
} from './types.ts'

const ORG = '11111111-1111-4111-8111-111111111111'
const SERVER = '22222222-2222-4222-8222-222222222222'
const SERVICE = '33333333-3333-4333-8333-333333333333'

const FROM = '2026-01-01T00:00:00.000Z'
const TO = '2026-01-01T01:00:00.000Z'

function makeEvent(message: string): ContainerLogEvent {
  return {
    timestamp: '2026-01-01T00:00:00.000Z',
    organizationId: ORG,
    serverId: SERVER,
    environmentId: null,
    serviceId: SERVICE,
    containerId: 'abc123',
    stream: 'stdout',
    message,
  }
}

/** What each driver's fake transport must expose to the shared cases. */
type Harness = {
  store: ContainerLogStore
  /** Number of write requests the driver issued (schema/DDL excluded). */
  writeCount(): number
  /** Rows handed to the write path, flattened across batches. */
  writtenRows(): Array<Record<string, unknown>>
  /** Everything the driver put on the wire for the last read, as one string. */
  lastReadText(): string
}

function clickHouseHarness(): Harness {
  const written: Array<Record<string, unknown>> = []
  let writes = 0
  let lastRead = ''
  const fetchStub: typeof fetch = (input, init) => {
    const url = new URL(String(input))
    const sql = url.searchParams.get('query') ?? ''
    if (sql.startsWith('INSERT INTO')) {
      writes += 1
      for (const line of String(init?.body ?? '').split('\n')) {
        if (line.trim()) written.push(JSON.parse(line) as Record<string, unknown>)
      }
      return Promise.resolve(new Response('', { status: 200 }))
    }
    if (sql.startsWith('SELECT')) {
      lastRead = url.toString()
      // Echo what was written — the fake does not execute predicates.
      return Promise.resolve(
        new Response(written.map((row) => JSON.stringify(row)).join('\n'), { status: 200 })
      )
    }
    // CREATE TABLE / ALTER … MODIFY TTL.
    return Promise.resolve(new Response('', { status: 200 }))
  }
  const store = new ClickHouseContainerLogStore(
    {
      url: 'http://clickhouse.test',
      database: 'turbopanel_metrics',
      user: 'turbopanel_app',
      password: 'secret',
    },
    { fetch: fetchStub }
  )
  return {
    store,
    writeCount: () => writes,
    writtenRows: () => written,
    lastReadText: () => lastRead,
  }
}

function pipelinesHarness(): Harness {
  const written: Array<Record<string, unknown>> = []
  let writes = 0
  let lastRead = ''
  const pipeline: PipelineLike = {
    send(records) {
      writes += 1
      for (const record of records) written.push(record as Record<string, unknown>)
      return Promise.resolve()
    },
  }
  const fetchStub: typeof fetch = (_input, init) => {
    lastRead = String(init?.body ?? '')
    return Promise.resolve(
      new Response(JSON.stringify({ success: true, result: { rows: written } }), {
        status: 200,
      })
    )
  }
  const store = new PipelinesIcebergContainerLogStore(pipeline, {
    accountId: 'acct',
    apiToken: 'token',
    bucket: 'bucket',
    table: 'default.container_logs',
    maxRangeSeconds: 3600,
    fetch: fetchStub,
  })
  return {
    store,
    writeCount: () => writes,
    writtenRows: () => written,
    lastReadText: () => lastRead,
  }
}

const drivers: Array<[string, () => Harness]> = [
  ['ClickHouseContainerLogStore', clickHouseHarness],
  ['PipelinesIcebergContainerLogStore', pipelinesHarness],
]

for (const [name, makeHarness] of drivers) {
  describe(`ContainerLogStore conformance: ${name}`, () => {
    it('treats an empty batch as a no-op', async () => {
      const harness = makeHarness()
      await harness.store.ingest([])
      assertEquals(harness.writeCount(), 0)
      assertEquals(harness.writtenRows().length, 0)
    })

    it('writes an already-batched array in exactly one request', async () => {
      const harness = makeHarness()
      await harness.store.ingest([makeEvent('one'), makeEvent('two'), makeEvent('three')])
      assertEquals(harness.writeCount(), 1)
      assertEquals(harness.writtenRows().length, 3)
    })

    it('round-trips ingested events back out of query', async () => {
      const harness = makeHarness()
      const events = [makeEvent('one'), makeEvent('two')]
      await harness.store.ingest(events)
      const page = await harness.store.query({ organizationId: ORG, from: FROM, to: TO })
      assertEquals(page.events, events)
      assertEquals(page.nextCursor, null)
    })

    it('scopes every read to the caller-supplied organization', async () => {
      const harness = makeHarness()
      await harness.store.query({ organizationId: ORG, from: FROM, to: TO })
      assert(harness.lastReadText().includes(ORG))
    })

    it('clamps an over-large limit to the documented ceiling', async () => {
      const harness = makeHarness()
      await harness.store.query({
        organizationId: ORG,
        from: FROM,
        to: TO,
        limit: 10 * MAX_CONTAINER_LOG_QUERY_LIMIT,
      })
      assert(harness.lastReadText().includes(String(MAX_CONTAINER_LOG_QUERY_LIMIT)))
    })
  })
}
