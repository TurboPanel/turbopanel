import { assertEquals } from '@std/assert'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
import type { DaemonCellRegistry } from '../../daemon/cell/contracts.ts'
import { fetchContainerLogTail, parseLogsTailQuery } from './logs.ts'
import { createServerPresenceDb } from '../managed/server-status-test-db.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parseLogsTailQuery defaults and clamps to 1..2000', () => {
  assertEquals(parseLogsTailQuery(undefined), 200)
  assertEquals(parseLogsTailQuery(''), 200)
  assertEquals(parseLogsTailQuery('nope'), 200)
  assertEquals(parseLogsTailQuery('0'), 1)
  assertEquals(parseLogsTailQuery('50'), 50)
  assertEquals(parseLogsTailQuery('2000'), 2000)
  assertEquals(parseLogsTailQuery('9999'), 2000)
})

function mockContext(registry?: DaemonCellRegistry): Context<AppEnv> {
  return {
    get(key: string) {
      if (key === 'daemonCellRegistry') return registry
      return undefined
    },
    json(body: unknown, status?: number) {
      return Response.json(body, { status })
    },
  } as unknown as Context<AppEnv>
}

test('fetchContainerLogTail returns 503 when the cell registry is unavailable', async () => {
  const response = await fetchContainerLogTail(mockContext(undefined), {} as Db, {
    serverId: 'server-1',
    containerId: 'aabbccddeeff',
    tail: 100,
  })
  if (!(response instanceof Response)) {
    throw new TypeError('expected Response')
  }
  assertEquals(response.status, 503)
  assertEquals(await response.json(), {
    error: 'Daemon cell registry unavailable',
  })
})

test('fetchContainerLogTail returns 409 when the target server is offline', async () => {
  const registry = {
    getCell: () => ({
      createRequestAndWait: () =>
        Promise.resolve({
          status: 'done',
          result: { logs: 'unused' },
        }),
    }),
  } as unknown as DaemonCellRegistry
  const response = await fetchContainerLogTail(
    mockContext(registry),
    createServerPresenceDb('server-1', false),
    {
      serverId: 'server-1',
      containerId: 'aabbccddeeff',
      tail: 50,
    },
  )
  if (!(response instanceof Response)) {
    throw new TypeError('expected Response')
  }
  assertEquals(response.status, 409)
  assertEquals(await response.json(), { error: 'server_offline' })
})

test('fetchContainerLogTail returns 503 when the cell wait expires', async () => {
  const registry = {
    getCell: () => ({
      createRequestAndWait: () => Promise.resolve({ status: 'expired' }),
    }),
  } as unknown as DaemonCellRegistry
  const response = await fetchContainerLogTail(
    mockContext(registry),
    createServerPresenceDb('server-1', true),
    { serverId: 'server-1', containerId: 'aabbccddeeff', tail: 20 },
  )
  if (!(response instanceof Response)) {
    throw new TypeError('expected Response')
  }
  assertEquals(response.status, 503)
  assertEquals(await response.json(), { error: 'timeout waiting for container logs' })
})

test('fetchContainerLogTail returns 500 when the cell wait fails', async () => {
  const withError = await fetchContainerLogTail(
    mockContext({
      getCell: () => ({
        createRequestAndWait: () =>
          Promise.resolve({ status: 'failed', error: 'docker gone' }),
      }),
    } as unknown as DaemonCellRegistry),
    createServerPresenceDb('server-1', true),
    { serverId: 'server-1', containerId: 'aabbccddeeff', tail: 20 },
  )
  if (!(withError instanceof Response)) throw new TypeError('expected Response')
  assertEquals(withError.status, 500)
  assertEquals(await withError.json(), { error: 'docker gone' })

  const withoutError = await fetchContainerLogTail(
    mockContext({
      getCell: () => ({
        createRequestAndWait: () => Promise.resolve({ status: 'failed' }),
      }),
    } as unknown as DaemonCellRegistry),
    createServerPresenceDb('server-1', true),
    { serverId: 'server-1', containerId: 'aabbccddeeff', tail: 20 },
  )
  if (!(withoutError instanceof Response)) throw new TypeError('expected Response')
  assertEquals(withoutError.status, 500)
  assertEquals(await withoutError.json(), { error: 'failed to fetch container logs' })
})

test('fetchContainerLogTail returns 500 when the result has no logs string', async () => {
  for (const result of [null, 'plain', { logs: 12 }, { logs: null }, []]) {
    const response = await fetchContainerLogTail(
      mockContext({
        getCell: () => ({
          createRequestAndWait: () => Promise.resolve({ status: 'done', result }),
        }),
      } as unknown as DaemonCellRegistry),
      createServerPresenceDb('server-1', true),
      { serverId: 'server-1', containerId: 'aabbccddeeff', tail: 20 },
    )
    if (!(response instanceof Response)) throw new TypeError('expected Response')
    assertEquals(response.status, 500)
    assertEquals(await response.json(), { error: 'invalid container logs result' })
  }
})

test('fetchContainerLogTail returns 503 when the cell wait throws', async () => {
  const asError = await fetchContainerLogTail(
    mockContext({
      getCell: () => ({
        createRequestAndWait: () => Promise.reject(new TypeError('socket closed')),
      }),
    } as unknown as DaemonCellRegistry),
    createServerPresenceDb('server-1', true),
    { serverId: 'server-1', containerId: 'aabbccddeeff', tail: 20 },
  )
  if (!(asError instanceof Response)) throw new TypeError('expected Response')
  assertEquals(asError.status, 503)
  assertEquals(await asError.json(), { error: 'socket closed' })

  const asString = await fetchContainerLogTail(
    mockContext({
      getCell: () => ({
        createRequestAndWait: () => Promise.reject('cell down'),
      }),
    } as unknown as DaemonCellRegistry),
    createServerPresenceDb('server-1', true),
    { serverId: 'server-1', containerId: 'aabbccddeeff', tail: 20 },
  )
  if (!(asString instanceof Response)) throw new TypeError('expected Response')
  assertEquals(asString.status, 503)
  assertEquals(await asString.json(), { error: 'cell down' })
})

test('fetchContainerLogTail returns docker logs on success', async () => {
  const registry = {
    getCell: () => ({
      createRequestAndWait: () =>
        Promise.resolve({
          status: 'done',
          result: { logs: 'line-one\nline-two\n' },
        }),
    }),
  } as unknown as DaemonCellRegistry
  const result = await fetchContainerLogTail(
    mockContext(registry),
    createServerPresenceDb('server-1', true),
    {
      serverId: 'server-1',
      containerId: 'aabbccddeeff',
      tail: 200,
    },
  )
  if (result instanceof Response) {
    throw new TypeError('expected logs payload')
  }
  assertEquals(result.logs, 'line-one\nline-two\n')
})
