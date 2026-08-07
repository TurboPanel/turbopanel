import { assertEquals } from 'jsr:@std/assert'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
import type { DaemonCellRegistry } from '../../daemon/cell/contracts.ts'
import { clampManagedLogsTail, fetchManagedLogs, parseLogsTailQuery } from './logs.ts'
import { createServerPresenceDb } from './server-status-test-db.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('clampManagedLogsTail defaults and clamps to 1..2000', () => {
  assertEquals(clampManagedLogsTail(undefined), 200)
  assertEquals(clampManagedLogsTail(''), 200)
  assertEquals(clampManagedLogsTail('nope'), 200)
  assertEquals(clampManagedLogsTail('0'), 1)
  assertEquals(clampManagedLogsTail('-5'), 1)
  assertEquals(clampManagedLogsTail('50'), 50)
  assertEquals(clampManagedLogsTail('2000'), 2000)
  assertEquals(clampManagedLogsTail('9999'), 2000)
})

test('parseLogsTailQuery aliases clampManagedLogsTail', () => {
  assertEquals(parseLogsTailQuery(undefined), 200)
  assertEquals(parseLogsTailQuery('100'), 100)
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

test('fetchManagedLogs returns 503 when the cell registry is unavailable', async () => {
  const c = mockContext(undefined)
  const response = await fetchManagedLogs(c, {} as Db, {
    serverId: 'server-1',
    managedId: 'managed-1',
    tail: 100,
  })
  if (!(response instanceof Response)) {
    throw new TypeError('expected Response')
  }
  assertEquals(response.status, 503)
  assertEquals(await response.json(), { error: 'Daemon cell registry unavailable' })
})

test('fetchManagedLogs returns 409 when the target server is offline', async () => {
  const registry = {
    getCell: () => ({
      createRequestAndWait: async () => ({
        status: 'done',
        result: { logs: 'unused' },
      }),
    }),
  } as unknown as DaemonCellRegistry
  const response = await fetchManagedLogs(
    mockContext(registry),
    createServerPresenceDb('server-1', false),
    {
    serverId: 'server-1',
    managedId: 'managed-1',
      tail: 50,
    },
  )
  if (!(response instanceof Response)) {
    throw new TypeError('expected Response')
  }
  assertEquals(response.status, 409)
  assertEquals(await response.json(), { error: 'server_offline' })
})

test('fetchManagedLogs returns compose logs on success', async () => {
  const registry = {
    getCell: () => ({
      createRequestAndWait: async () => ({
        status: 'done',
        result: { logs: 'line-one\nline-two\n' },
      }),
    }),
  } as unknown as DaemonCellRegistry
  const result = await fetchManagedLogs(
    mockContext(registry),
    createServerPresenceDb('server-1', true),
    {
      serverId: 'server-1',
      managedId: 'managed-1',
      tail: 200,
    },
  )
  if (result instanceof Response) {
    throw new TypeError('expected logs payload')
  }
  assertEquals(result.logs, 'line-one\nline-two\n')
})

test('fetchManagedLogs maps cell failures to HTTP errors', async () => {
  const statusDb = createServerPresenceDb('server-1', true)

  const expiredRegistry = {
    getCell: () => ({
      createRequestAndWait: async () => ({ status: 'expired' }),
    }),
  } as unknown as DaemonCellRegistry
  const expired = await fetchManagedLogs(mockContext(expiredRegistry), statusDb, {
    serverId: 'server-1',
    managedId: 'managed-1',
    tail: 10,
  })
  if (!(expired instanceof Response)) throw new TypeError('expected Response')
  assertEquals(expired.status, 503)

  const failedRegistry = {
    getCell: () => ({
      createRequestAndWait: async () => ({
        status: 'failed',
        error: 'compose unavailable',
      }),
    }),
  } as unknown as DaemonCellRegistry
  const failed = await fetchManagedLogs(mockContext(failedRegistry), statusDb, {
    serverId: 'server-1',
    managedId: 'managed-1',
    tail: 10,
  })
  if (!(failed instanceof Response)) throw new TypeError('expected Response')
  assertEquals(failed.status, 500)
  assertEquals(await failed.json(), { error: 'compose unavailable' })

  const invalidRegistry = {
    getCell: () => ({
      createRequestAndWait: async () => ({
        status: 'done',
        result: { logs: 42 },
      }),
    }),
  } as unknown as DaemonCellRegistry
  const invalid = await fetchManagedLogs(mockContext(invalidRegistry), statusDb, {
    serverId: 'server-1',
    managedId: 'managed-1',
    tail: 10,
  })
  if (!(invalid instanceof Response)) throw new TypeError('expected Response')
  assertEquals(invalid.status, 500)
  assertEquals(await invalid.json(), { error: 'invalid managed logs result' })

  const throwingRegistry = {
    getCell: () => ({
      createRequestAndWait: async () => {
        throw new Error('cell transport down')
      },
    }),
  } as unknown as DaemonCellRegistry
  const transport = await fetchManagedLogs(mockContext(throwingRegistry), statusDb, {
    serverId: 'server-1',
    managedId: 'managed-1',
    tail: 10,
  })
  if (!(transport instanceof Response)) throw new TypeError('expected Response')
  assertEquals(transport.status, 503)
  assertEquals(await transport.json(), { error: 'cell transport down' })
})
