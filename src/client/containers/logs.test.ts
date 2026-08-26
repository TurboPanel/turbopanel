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
