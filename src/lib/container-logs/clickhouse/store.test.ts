import { assert, assertEquals, assertThrows } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import { ClickHouseHttpClient } from '../../../daemon/metrics/clickhouse/client.ts'
import {
  buildContainerLogRow,
  ClickHouseContainerLogStore,
  decodeContainerLogCursor,
  encodeContainerLogCursor,
  parseContainerLogRow,
} from './store.ts'
import type { ContainerLogEvent } from '../types.ts'

const ORG = '11111111-1111-4111-8111-111111111111'
const SERVER = '22222222-2222-4222-8222-222222222222'
const SERVICE = '33333333-3333-4333-8333-333333333333'

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

type Captured = { url: URL; body: string | undefined }

function fakeStore(responseBody = '') {
  const captured: Captured[] = []
  const fetchStub: typeof fetch = (input, init) => {
    captured.push({
      url: new URL(String(input)),
      body: typeof init?.body === 'string' ? init.body : undefined,
    })
    return Promise.resolve(new Response(responseBody, { status: 200 }))
  }
  const client = new ClickHouseHttpClient({
    url: 'http://clickhouse.test',
    database: 'turbopanel_metrics',
    user: 'turbopanel_app',
    password: 'secret',
    fetch: fetchStub,
  })
  const store = new ClickHouseContainerLogStore(
    {
      url: 'http://clickhouse.test',
      database: 'turbopanel_metrics',
      user: 'turbopanel_app',
      password: 'secret',
    },
    { client }
  )
  return { store, captured }
}

describe('buildContainerLogRow', () => {
  it('maps the contract onto snake_case ClickHouse columns', () => {
    assertEquals(buildContainerLogRow(event), {
      timestamp: '2026-01-01 00:00:00.000',
      organization_id: ORG,
      server_id: SERVER,
      environment_id: null,
      service_id: SERVICE,
      container_id: 'abc123',
      stream: 'stderr',
      message: 'boom',
    })
  })

  it('rejects non-UUID identity values', () => {
    assertThrows(
      () => buildContainerLogRow({ ...event, organizationId: "1'; DROP TABLE" }),
      TypeError,
      'organizationId'
    )
  })
})

describe('parseContainerLogRow', () => {
  it('round-trips a ClickHouse row back to ISO timestamps', () => {
    const parsed = parseContainerLogRow({
      timestamp: '2026-01-01 00:00:00.000',
      organization_id: ORG,
      server_id: SERVER,
      environment_id: null,
      service_id: SERVICE,
      container_id: 'abc123',
      stream: 'stderr',
      message: 'boom',
    })
    assertEquals(parsed, event)
  })
})

describe('container log cursor', () => {
  it('round-trips an ISO timestamp', () => {
    const cursor = encodeContainerLogCursor('2026-01-01T00:00:00.000Z')
    assertEquals(decodeContainerLogCursor(cursor).toISOString(), '2026-01-01T00:00:00.000Z')
  })

  it('rejects a cursor that does not decode to a timestamp', () => {
    assertThrows(() => decodeContainerLogCursor(btoa('nonsense')), TypeError, 'cursor')
  })
})

describe('ClickHouseContainerLogStore.ingest', () => {
  it('is a no-op for an empty batch (no schema DDL, no insert)', async () => {
    const { store, captured } = fakeStore()
    await store.ingest([])
    assertEquals(captured.length, 0)
  })

  it('inserts the whole batch as one JSONEachRow request', async () => {
    const { store, captured } = fakeStore()
    await store.ingest([event, { ...event, message: 'second' }])
    const insert = captured.at(-1)!
    assertEquals(
      insert.url.searchParams.get('query'),
      'INSERT INTO container_logs FORMAT JSONEachRow'
    )
    assertEquals(insert.body!.split('\n').length, 2)
    // CREATE + ALTER ran once ahead of the single insert.
    assertEquals(captured.length, 3)
  })

  it('ensures schema at most once across calls', async () => {
    const { store, captured } = fakeStore()
    await store.ingest([event])
    await store.ingest([event])
    assertEquals(captured.length, 4)
  })
})

describe('ClickHouseContainerLogStore.query', () => {
  it('always scopes to the organization and the time range', async () => {
    const { store, captured } = fakeStore()
    await store.query({
      organizationId: ORG,
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-02T00:00:00.000Z',
    })
    const select = captured.at(-1)!
    const sql = select.url.searchParams.get('query')!
    assert(sql.includes('FROM container_logs'))
    assert(sql.includes('organization_id = {organizationId:UUID}'))
    assert(sql.includes('timestamp >= {from:DateTime64(3)}'))
    assert(sql.includes('timestamp < {to:DateTime64(3)}'))
    assert(sql.includes('ORDER BY timestamp DESC'))
    assertEquals(select.url.searchParams.get('param_organizationId'), ORG)
    assertEquals(select.url.searchParams.get('param_limit'), '200')
  })

  it('adds only the predicates the caller supplied', async () => {
    const { store, captured } = fakeStore()
    await store.query({
      organizationId: ORG,
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-02T00:00:00.000Z',
      serverId: SERVER,
      serviceId: SERVICE,
      containerId: 'abc123',
      stream: 'stderr',
      search: '50%_off',
      limit: 5,
    })
    const select = captured.at(-1)!
    const sql = select.url.searchParams.get('query')!
    assert(sql.includes('server_id = {serverId:UUID}'))
    assert(sql.includes('service_id = {serviceId:UUID}'))
    assert(sql.includes('container_id = {containerId:String}'))
    assert(sql.includes('stream = {stream:String}'))
    assert(sql.includes('message ILIKE {search:String}'))
    assert(!sql.includes('environment_id = {environmentId:UUID}'))
    // LIKE metacharacters in user input are escaped, not interpreted.
    assertEquals(select.url.searchParams.get('param_search'), '%50\\%\\_off%')
    assertEquals(select.url.searchParams.get('param_limit'), '5')
  })

  it('rejects an inverted range', async () => {
    const { store } = fakeStore()
    let threw = false
    try {
      await store.query({
        organizationId: ORG,
        from: '2026-01-02T00:00:00.000Z',
        to: '2026-01-01T00:00:00.000Z',
      })
    } catch (error) {
      threw = error instanceof TypeError
    }
    assertEquals(threw, true)
  })

  it('returns a null cursor for a short page', async () => {
    const row = JSON.stringify({
      timestamp: '2026-01-01 00:00:00.000',
      organization_id: ORG,
      server_id: SERVER,
      environment_id: null,
      service_id: SERVICE,
      container_id: 'abc123',
      stream: 'stderr',
      message: 'boom',
    })
    const { store } = fakeStore(row)
    const page = await store.query({
      organizationId: ORG,
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-02T00:00:00.000Z',
      limit: 10,
    })
    assertEquals(page.events.length, 1)
    assertEquals(page.nextCursor, null)
  })

  it('returns a cursor when the page is full and applies it on the next call', async () => {
    const row = JSON.stringify({
      timestamp: '2026-01-01 00:00:00.000',
      organization_id: ORG,
      server_id: SERVER,
      environment_id: null,
      service_id: SERVICE,
      container_id: 'abc123',
      stream: 'stdout',
      message: 'boom',
    })
    const { store, captured } = fakeStore(row)
    const page = await store.query({
      organizationId: ORG,
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-02T00:00:00.000Z',
      limit: 1,
    })
    assertEquals(page.nextCursor, encodeContainerLogCursor('2026-01-01T00:00:00.000Z'))

    await store.query({
      organizationId: ORG,
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-02T00:00:00.000Z',
      limit: 1,
      cursor: page.nextCursor!,
    })
    const select = captured.at(-1)!
    assert(select.url.searchParams.get('query')!.includes('timestamp < {cursor:DateTime64(3)}'))
    assertEquals(select.url.searchParams.get('param_cursor'), '2026-01-01 00:00:00.000')
  })
})
