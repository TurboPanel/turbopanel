import { assertEquals } from 'jsr:@std/assert'
import type { Context } from 'hono'
import type { Db } from '../../db.ts'
import { ip, network, peer, server } from '../../lib/db/schema.ts'
import {
  COLOCATED_SERVER_DELETE_BLOCKED_REASON,
  SERVER_HAS_BLOCKERS_CODE,
  SERVER_HAS_BLOCKERS_ERROR,
  colocatedServerDeleteBlockedReason,
  listServerDeleteBlockers,
  serverDeleteBlockersResponse,
  type ServerDeleteBlocker,
} from './delete-guards.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function mockContext(): Context {
  return {
    json(body: unknown, status?: number) {
      return Response.json(body, { status })
    },
  } as unknown as Context
}

function thenableRows(rows: unknown[]) {
  const promise = Promise.resolve(rows)
  return {
    limit: () => promise,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  }
}

function deleteBlockersDb(opts: {
  serverMissing?: boolean
  networkCount?: number
  containerCount?: number | string
  peerCount?: number
  ipCount?: number
}): Db {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === server) {
            return {
              limit: () =>
                Promise.resolve(
                  opts.serverMissing ? [] : [{ id: 'server-1' }],
                ),
            }
          }
          if (table === network) {
            return thenableRows([{ value: opts.networkCount ?? 0 }])
          }
          if (table === peer) {
            return thenableRows([{ value: opts.peerCount ?? 0 }])
          }
          if (table === ip) {
            return thenableRows([{ value: opts.ipCount ?? 0 }])
          }
          return thenableRows([{ value: 0 }])
        },
      }),
    }),
    execute: () =>
      Promise.resolve([{ value: opts.containerCount ?? 0 }]),
  } as unknown as Db
}

test('colocatedServerDeleteBlockedReason returns the stable operator copy', () => {
  assertEquals(
    colocatedServerDeleteBlockedReason(),
    COLOCATED_SERVER_DELETE_BLOCKED_REASON,
  )
})

test('serverDeleteBlockersResponse returns 409 with code and blockers', async () => {
  const blockers: ServerDeleteBlocker[] = [
    { kind: 'network', count: 2 },
    { kind: 'container', count: 1 },
  ]
  const response = serverDeleteBlockersResponse(mockContext(), blockers)
  assertEquals(response.status, 409)
  assertEquals(await response.json(), {
    error: SERVER_HAS_BLOCKERS_ERROR,
    code: SERVER_HAS_BLOCKERS_CODE,
    blockers,
  })
})

test('listServerDeleteBlockers returns empty when the server is not in the org', async () => {
  const blockers = await listServerDeleteBlockers(
    deleteBlockersDb({ serverMissing: true }),
    'server-1',
    'org-1',
  )
  assertEquals(blockers, [])
})

test('listServerDeleteBlockers omits zero-count dependency kinds', async () => {
  const blockers = await listServerDeleteBlockers(
    deleteBlockersDb({
      networkCount: 0,
      containerCount: 0,
      peerCount: 0,
      ipCount: 0,
    }),
    'server-1',
    'org-1',
  )
  assertEquals(blockers, [])
})

test('listServerDeleteBlockers reports each positive dependency count', async () => {
  const blockers = await listServerDeleteBlockers(
    deleteBlockersDb({
      networkCount: 2,
      containerCount: '3',
      peerCount: 1,
      ipCount: 4,
    }),
    'server-1',
    'org-1',
  )
  assertEquals(blockers, [
    { kind: 'network', count: 2 },
    { kind: 'container', count: 3 },
    { kind: 'peer', count: 1 },
    { kind: 'ip', count: 4 },
  ])
})
