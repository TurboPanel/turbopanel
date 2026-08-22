import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import {
  buildContainerLogIcebergRow,
  buildContainerLogR2Sql,
  ContainerLogStoreUnavailableError,
  decodeContainerLogCursor,
  encodeContainerLogCursor,
  parseContainerLogIcebergRow,
  parseR2SqlResponse,
  PipelinesIcebergContainerLogStore,
  quoteR2SqlString,
} from './pipeline-store.ts'
import type { PipelineLike } from './pipeline-store.ts'
import type { ContainerLogsCloudflareConfig } from './config.ts'
import {
  MAX_CONTAINER_LOG_QUERY_LIMIT,
  type ContainerLogEvent,
  type ContainerLogQuery,
} from '../types.ts'

const ORG = '11111111-1111-4111-8111-111111111111'
const OTHER_ORG = '99999999-9999-4999-8999-999999999999'
const SERVER = '22222222-2222-4222-8222-222222222222'
const SERVICE = '33333333-3333-4333-8333-333333333333'
const ENVIRONMENT = '44444444-4444-4444-8444-444444444444'
const ROW = '55555555-5555-4555-8555-555555555555'

const event: ContainerLogEvent = {
  timestamp: '2026-01-01T00:00:00.000Z',
  organizationId: ORG,
  serverId: SERVER,
  environmentId: null,
  serviceId: SERVICE,
  containerId: 'abc123',
  stream: 'stderr',
  message: 'boom',
}

const baseQuery: ContainerLogQuery = {
  organizationId: ORG,
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-01-01T01:00:00.000Z',
}

const config: ContainerLogsCloudflareConfig = {
  accountId: 'acct',
  apiToken: 'token',
  bucket: 'bucket',
  table: 'default.container_logs',
  maxRangeSeconds: 3600,
}

type Sent = { records: unknown[] }
type Requested = { url: string; init: RequestInit | undefined }

function fakePipeline() {
  const sends: Sent[] = []
  const pipeline: PipelineLike = {
    send(records) {
      sends.push({ records })
      return Promise.resolve()
    },
  }
  return { pipeline, sends }
}

function fakeFetch(body: unknown, status = 200) {
  const requests: Requested[] = []
  const fetchStub: typeof fetch = (input, init) => {
    requests.push({ url: String(input), init })
    return Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
    )
  }
  return { fetchStub, requests }
}

function requestSql(requests: Requested[]): string {
  const raw = requests.at(-1)?.init?.body
  return (JSON.parse(String(raw)) as { query: string }).query
}

describe('buildContainerLogIcebergRow', () => {
  it('maps the contract onto flat, one-per-predicate Iceberg columns', () => {
    assertEquals(
      buildContainerLogIcebergRow(event, () => ROW),
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        organization_id: ORG,
        server_id: SERVER,
        environment_id: null,
        service_id: SERVICE,
        container_id: 'abc123',
        stream: 'stderr',
        message: 'boom',
        row_id: ROW,
      }
    )
  })

  it('rejects identities that are not UUIDs', () => {
    assertThrows(
      () => buildContainerLogIcebergRow({ ...event, organizationId: "x' OR 1=1--" }, () => ROW),
      TypeError
    )
  })

  it('round-trips through the row parser', () => {
    const row = buildContainerLogIcebergRow(event, () => ROW)
    assertEquals(parseContainerLogIcebergRow(row), event)
  })
})

describe('ingest', () => {
  it('sends the whole batch in exactly one call, never one per event', async () => {
    const { pipeline, sends } = fakePipeline()
    const store = new PipelinesIcebergContainerLogStore(pipeline, config, {
      newRowId: () => ROW,
    })
    await store.ingest([event, { ...event, message: 'second' }, { ...event, message: 'third' }])
    assertEquals(sends.length, 1)
    assertEquals(sends[0]!.records.length, 3)
  })

  it('is a no-op for an empty batch', async () => {
    const { pipeline, sends } = fakePipeline()
    const store = new PipelinesIcebergContainerLogStore(pipeline, config)
    await store.ingest([])
    assertEquals(sends.length, 0)
  })

  it('wraps a transport failure so callers can answer 503', async () => {
    const pipeline: PipelineLike = { send: () => Promise.reject(new Error('down')) }
    const store = new PipelinesIcebergContainerLogStore(pipeline, config)
    await assertRejects(() => store.ingest([event]), ContainerLogStoreUnavailableError)
  })
})

describe('buildContainerLogR2Sql', () => {
  it('always injects the caller-supplied organization predicate first', () => {
    const sql = buildContainerLogR2Sql(baseQuery, {
      table: config.table,
      limit: 10,
      maxRangeSeconds: 3600,
    })
    assert(sql.includes(`WHERE organization_id = '${ORG}'`))
    assert(!sql.includes(OTHER_ORG))
  })

  it('orders sort-key predicates ahead of the off-key ones', () => {
    const sql = buildContainerLogR2Sql(
      {
        ...baseQuery,
        serverId: SERVER,
        serviceId: SERVICE,
        environmentId: ENVIRONMENT,
        containerId: 'abc123',
        stream: 'stdout',
        search: '50%_off',
      },
      { table: config.table, limit: 10, maxRangeSeconds: 3600 }
    )
    const order = [
      'organization_id =',
      'server_id =',
      'service_id =',
      'timestamp >=',
      'timestamp <',
      'environment_id =',
      'container_id =',
      'stream =',
      'message ILIKE',
    ].map((needle) => sql.indexOf(needle))
    assertEquals(
      order,
      [...order].sort((a, b) => a - b)
    )
    assert(order.every((index) => index >= 0))
    // LIKE wildcards in user input match literally.
    assert(sql.includes("message ILIKE '%50\\%\\_off%'"))
  })

  it('bounds scanned work with a clamped LIMIT and a bounded window', () => {
    const sql = buildContainerLogR2Sql(baseQuery, {
      table: config.table,
      limit: MAX_CONTAINER_LOG_QUERY_LIMIT,
      maxRangeSeconds: 3600,
    })
    assert(sql.endsWith(`LIMIT ${MAX_CONTAINER_LOG_QUERY_LIMIT}`))
    assertThrows(
      () =>
        buildContainerLogR2Sql(
          { ...baseQuery, to: '2026-01-02T00:00:00.000Z' },
          { table: config.table, limit: 10, maxRangeSeconds: 3600 }
        ),
      TypeError,
      'exceeds maxRangeSeconds'
    )
  })

  it('always emits a LIMIT and a closed [from, to) window', () => {
    // The two enforceable budget axes must be present on *every* query — a
    // missing LIMIT or an open-ended window would be an unbounded scan.
    const sql = buildContainerLogR2Sql(baseQuery, {
      table: config.table,
      limit: 10,
      maxRangeSeconds: 3600,
    })
    assert(sql.includes("timestamp >= '2026-01-01T00:00:00.000Z'"))
    assert(sql.includes("timestamp < '2026-01-01T01:00:00.000Z'"))
    assert(/\nLIMIT \d+$/.test(sql))
  })

  it('honors a maxRangeSeconds tighter than the retention window', () => {
    // `maxRangeSeconds` is the strongest cost control R2 SQL leaves us, so an
    // operator lowering it below the retention default must actually bite.
    assertThrows(
      () =>
        buildContainerLogR2Sql(baseQuery, {
          table: config.table,
          limit: 10,
          maxRangeSeconds: 60,
        }),
      TypeError,
      'query range 3600s exceeds maxRangeSeconds 60'
    )
  })

  it('refuses a wide unfiltered read, because no scanned-bytes ceiling exists', () => {
    // R2 SQL accepts no cost cap, and `organization_id` alone prunes no data
    // files inside the window. Fail closed rather than issue the scan.
    const error = assertThrows(
      () =>
        buildContainerLogR2Sql(
          { ...baseQuery, to: '2026-01-01T06:00:00.000Z' },
          {
            table: config.table,
            limit: 10,
            maxRangeSeconds: 86_400,
            maxUnselectiveRangeSeconds: 3600,
          }
        ),
      ContainerLogStoreUnavailableError,
      'container_logs_unavailable'
    )
    assert(error.message.includes('serverId/serviceId/containerId'))
  })

  it('allows the same wide window once a selective predicate prunes it', () => {
    for (
      const selective of [
        { serverId: SERVER },
        { serviceId: SERVICE },
        { containerId: 'abc123' },
      ]
    ) {
      const sql = buildContainerLogR2Sql(
        { ...baseQuery, ...selective, to: '2026-01-01T06:00:00.000Z' },
        {
          table: config.table,
          limit: 10,
          maxRangeSeconds: 86_400,
          maxUnselectiveRangeSeconds: 3600,
        }
      )
      assert(/\nLIMIT \d+$/.test(sql))
    }
  })

  it('still allows an unfiltered read inside the unselective window', () => {
    const sql = buildContainerLogR2Sql(baseQuery, {
      table: config.table,
      limit: 10,
      maxRangeSeconds: 86_400,
      maxUnselectiveRangeSeconds: 3600,
    })
    assert(sql.includes(`WHERE organization_id = '${ORG}'`))
  })

  it('rejects a non-positive limit rather than emitting an unbounded scan', () => {
    for (const limit of [0, -1, 1.5]) {
      assertThrows(
        () =>
          buildContainerLogR2Sql(baseQuery, {
            table: config.table,
            limit,
            maxRangeSeconds: 3600,
          }),
        TypeError,
        'limit must be a positive integer'
      )
    }
  })

  it('paginates on the total order (timestamp, row_id)', () => {
    const sql = buildContainerLogR2Sql(
      { ...baseQuery, cursor: encodeContainerLogCursor('2026-01-01T00:30:00.000Z', ROW) },
      { table: config.table, limit: 10, maxRangeSeconds: 3600 }
    )
    assert(sql.includes('ORDER BY timestamp DESC, row_id DESC'))
    assert(
      sql.includes(
        "(timestamp < '2026-01-01T00:30:00.000Z' OR " +
          `(timestamp = '2026-01-01T00:30:00.000Z' AND row_id < '${ROW}'))`
      )
    )
  })

  it('rejects a table identifier that is not a plain namespace.table', () => {
    assertThrows(
      () =>
        buildContainerLogR2Sql(baseQuery, {
          table: 'default.container_logs; DROP TABLE x',
          limit: 10,
          maxRangeSeconds: 3600,
        }),
      TypeError
    )
  })
})

describe('quoteR2SqlString', () => {
  it('doubles embedded single quotes', () => {
    assertEquals(quoteR2SqlString("it's"), "'it''s'")
  })
})

describe('cursor codec', () => {
  it('round-trips', () => {
    const cursor = encodeContainerLogCursor('2026-01-01T00:00:00.000Z', ROW)
    assertEquals(decodeContainerLogCursor(cursor), {
      timestamp: '2026-01-01T00:00:00.000Z',
      rowId: ROW,
    })
  })

  it('rejects malformed cursors', () => {
    assertThrows(() => decodeContainerLogCursor(btoa('no-separator')), TypeError)
    assertThrows(() => decodeContainerLogCursor(btoa('2026-01-01T00:00:00.000Z|')), TypeError)
    assertThrows(() => decodeContainerLogCursor(btoa('nonsense|abc')), TypeError)
  })
})

describe('parseR2SqlResponse', () => {
  it('unwraps the client/v4 envelope', () => {
    assertEquals(parseR2SqlResponse({ success: true, result: { rows: [{ a: 1 }] } }), [{ a: 1 }])
  })

  it('accepts bare rows / data bodies', () => {
    assertEquals(parseR2SqlResponse({ rows: [{ a: 1 }] }), [{ a: 1 }])
    assertEquals(parseR2SqlResponse({ data: [{ a: 1 }] }), [{ a: 1 }])
    assertEquals(parseR2SqlResponse({ success: true, result: [{ a: 1 }] }), [{ a: 1 }])
  })

  it('returns an empty page when a successful query matched nothing', () => {
    assertEquals(parseR2SqlResponse({ success: true, result: null }), [])
  })

  it('surfaces the Cloudflare error envelope as unavailable', () => {
    assertThrows(
      () =>
        parseR2SqlResponse({
          success: false,
          errors: [{ code: 10000, message: 'no such table' }],
        }),
      ContainerLogStoreUnavailableError,
      'no such table'
    )
    assertThrows(() => parseR2SqlResponse('nope'), ContainerLogStoreUnavailableError)
  })
})

describe('query', () => {
  it('POSTs the account/bucket-scoped R2 SQL endpoint with a bearer token', async () => {
    const { fetchStub, requests } = fakeFetch({ success: true, result: { rows: [] } })
    const store = new PipelinesIcebergContainerLogStore(fakePipeline().pipeline, {
      ...config,
      fetch: fetchStub,
    })
    const page = await store.query(baseQuery)
    assertEquals(page, { events: [], nextCursor: null })
    assertEquals(
      requests[0]!.url,
      'https://api.sql.cloudflarestorage.com/api/v1/accounts/acct/r2-sql/query/bucket'
    )
    assertEquals(requests[0]!.init?.method, 'POST')
    const headers = requests[0]!.init?.headers as Record<string, string>
    assertEquals(headers.Authorization, 'Bearer token')
    assertEquals(headers['Content-Type'], 'application/json')
    assert(requestSql(requests).includes(`organization_id = '${ORG}'`))
  })

  it('clamps an over-large caller limit to the documented ceiling', async () => {
    const { fetchStub, requests } = fakeFetch({ success: true, result: { rows: [] } })
    const store = new PipelinesIcebergContainerLogStore(fakePipeline().pipeline, {
      ...config,
      fetch: fetchStub,
    })
    await store.query({ ...baseQuery, limit: 10_000 })
    assert(requestSql(requests).endsWith(`LIMIT ${MAX_CONTAINER_LOG_QUERY_LIMIT}`))
  })

  it('sends `query` and nothing else — R2 SQL exposes no scanned-bytes budget', async () => {
    // Documents a real limitation of the beta API rather than a design choice:
    // the request body has exactly one field, so a per-request byte ceiling
    // cannot be enforced here. If Cloudflare ever adds one, this test is the
    // canary that should be updated alongside `ContainerLogsCloudflareConfig`.
    const { fetchStub, requests } = fakeFetch({ success: true, result: { rows: [] } })
    const store = new PipelinesIcebergContainerLogStore(fakePipeline().pipeline, {
      ...config,
      fetch: fetchStub,
    })
    await store.query(baseQuery)
    const body = JSON.parse(String(requests[0]!.init?.body)) as Record<string, unknown>
    assertEquals(Object.keys(body), ['query'])
  })

  it('applies the configured maxRangeSeconds to a caller-supplied window', async () => {
    const { fetchStub } = fakeFetch({ success: true, result: { rows: [] } })
    const store = new PipelinesIcebergContainerLogStore(fakePipeline().pipeline, {
      ...config,
      maxRangeSeconds: 60,
      fetch: fetchStub,
    })
    await assertRejects(() => store.query(baseQuery), TypeError, 'exceeds maxRangeSeconds')
  })

  it('returns a cursor only when the page is full', async () => {
    const row = buildContainerLogIcebergRow(event, () => ROW)
    const { fetchStub } = fakeFetch({ success: true, result: { rows: [row] } })
    const store = new PipelinesIcebergContainerLogStore(fakePipeline().pipeline, {
      ...config,
      fetch: fetchStub,
    })
    const full = await store.query({ ...baseQuery, limit: 1 })
    assertEquals(full.events, [event])
    assertEquals(full.nextCursor, encodeContainerLogCursor(event.timestamp, ROW))

    const partial = await store.query({ ...baseQuery, limit: 2 })
    assertEquals(partial.nextCursor, null)
  })

  it('raises unavailable on a non-2xx response', async () => {
    const { fetchStub } = fakeFetch('gateway down', 502)
    const store = new PipelinesIcebergContainerLogStore(fakePipeline().pipeline, {
      ...config,
      fetch: fetchStub,
    })
    await assertRejects(
      () => store.query(baseQuery),
      ContainerLogStoreUnavailableError,
      'R2 SQL HTTP 502'
    )
  })

  it('raises unavailable when the transport itself fails', async () => {
    const store = new PipelinesIcebergContainerLogStore(fakePipeline().pipeline, {
      ...config,
      fetch: () => Promise.reject(new Error('socket')),
    })
    await assertRejects(() => store.query(baseQuery), ContainerLogStoreUnavailableError)
  })
})
