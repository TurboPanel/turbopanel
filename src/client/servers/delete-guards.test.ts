import { assertEquals } from '@std/assert'
import type { Context } from 'hono'
import type { Db } from '../../db/connection.ts'
import { ip, network, server } from '../../db/schema.ts'
import {
  COLOCATED_SERVER_DELETE_BLOCKED_REASON,
  SERVER_HAS_BLOCKERS_CODE,
  SERVER_HAS_BLOCKERS_ERROR,
  SERVER_ONLINE_CODE,
  SERVER_ONLINE_ERROR,
  colocatedServerDeleteBlockedReason,
  listServerDeleteBlockers,
  loadServerDeletePreview,
  parseForgetResourcesFlag,
  serverDeleteBlockersResponse,
  serverOnlineForgetBlockedResponse,
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
  const chain = {
    limit: () => promise,
    orderBy: () => chain,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  }
  return chain
}

function deleteBlockersDb(opts: {
  serverMissing?: boolean
  networkCount?: number
  containerCount?: number | string
  ipCount?: number
  networkRows?: Array<{ id: string; name: string | null }>
  ipRows?: Array<{ id: string; address: string }>
  containerRows?: Array<{
    id: string
    name: string
    status: string
    serviceName: string | null
  }>
}): Db {
  let executeCalls = 0
  return {
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === server) {
            return {
              limit: () => Promise.resolve(opts.serverMissing ? [] : [{ id: 'server-1' }]),
            }
          }
          if (table === network) {
            if (fields && 'name' in fields) {
              return thenableRows(opts.networkRows ?? [])
            }
            return thenableRows([{ value: opts.networkCount ?? 0 }])
          }
          if (table === ip) {
            if (fields && 'address' in fields) {
              return thenableRows(opts.ipRows ?? [])
            }
            return thenableRows([{ value: opts.ipCount ?? 0 }])
          }
          return thenableRows([{ value: 0 }])
        },
      }),
    }),
    execute: () => {
      executeCalls += 1
      if (executeCalls === 1) {
        return Promise.resolve([{ value: opts.containerCount ?? 0 }])
      }
      return Promise.resolve(opts.containerRows ?? [])
    },
  } as unknown as Db
}

test('colocatedServerDeleteBlockedReason returns the stable operator copy', () => {
  assertEquals(colocatedServerDeleteBlockedReason(), COLOCATED_SERVER_DELETE_BLOCKED_REASON)
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
    'org-1'
  )
  assertEquals(blockers, [])
})

test('listServerDeleteBlockers omits zero-count dependency kinds', async () => {
  const blockers = await listServerDeleteBlockers(
    deleteBlockersDb({
      networkCount: 0,
      containerCount: 0,
      ipCount: 0,
    }),
    'server-1',
    'org-1'
  )
  assertEquals(blockers, [])
})

test('listServerDeleteBlockers reports each positive dependency count', async () => {
  const blockers = await listServerDeleteBlockers(
    deleteBlockersDb({
      networkCount: 2,
      containerCount: '3',
      ipCount: 4,
    }),
    'server-1',
    'org-1'
  )
  assertEquals(blockers, [
    { kind: 'network', count: 2 },
    { kind: 'container', count: 3 },
    { kind: 'ip', count: 4 },
  ])
})

test('parseForgetResourcesFlag is true only for an explicit true query or body', () => {
  assertEquals(parseForgetResourcesFlag(undefined, {}), false)
  assertEquals(parseForgetResourcesFlag('1', {}), false)
  assertEquals(parseForgetResourcesFlag('false', { forgetResources: 'true' }), false)
  assertEquals(parseForgetResourcesFlag('true', {}), true)
  assertEquals(parseForgetResourcesFlag(undefined, { forgetResources: true }), true)
})

test('serverOnlineForgetBlockedResponse returns 409 server_online', async () => {
  const response = serverOnlineForgetBlockedResponse(mockContext())
  assertEquals(response.status, 409)
  assertEquals(await response.json(), {
    error: SERVER_ONLINE_ERROR,
    code: SERVER_ONLINE_CODE,
  })
})

test('loadServerDeletePreview lists leftovers and sets canForget when offline', async () => {
  const preview = await loadServerDeletePreview(
    deleteBlockersDb({
      networkCount: 1,
      containerCount: 1,
      ipCount: 1,
      networkRows: [{ id: 'net-1', name: 'leftover-net' }],
      ipRows: [{ id: 'ip-1', address: '203.0.113.10' }],
      containerRows: [
        {
          id: 'ctr-1',
          name: 'web-1',
          status: 'exited',
          serviceName: 'web',
        },
      ],
    }),
    'server-1',
    'org-1',
    { online: false, colocated: false }
  )
  assertEquals(preview.online, false)
  assertEquals(preview.canForget, true)
  assertEquals(preview.colocated, false)
  assertEquals(preview.blockers, [
    { kind: 'network', count: 1 },
    { kind: 'container', count: 1 },
    { kind: 'ip', count: 1 },
  ])
  assertEquals(preview.containers, {
    items: [{ id: 'ctr-1', name: 'web-1', status: 'exited', serviceName: 'web' }],
    more: 0,
  })
  assertEquals(preview.networks, {
    items: [{ id: 'net-1', name: 'leftover-net' }],
    more: 0,
  })
  assertEquals(preview.ips, {
    items: [{ id: 'ip-1', address: '203.0.113.10' }],
    more: 0,
  })
})

test('loadServerDeletePreview caps each list at 50 and reports more', async () => {
  const preview = await loadServerDeletePreview(
    deleteBlockersDb({
      networkCount: 51,
      containerCount: 51,
      ipCount: 51,
      networkRows: Array.from({ length: 50 }, (_, i) => ({
        id: `net-${i}`,
        name: `n${i}`,
      })),
      ipRows: Array.from({ length: 50 }, (_, i) => ({
        id: `ip-${i}`,
        address: `203.0.113.${i}`,
      })),
      containerRows: Array.from({ length: 50 }, (_, i) => ({
        id: `ctr-${i}`,
        name: `c${i}`,
        status: 'exited',
        serviceName: null,
      })),
    }),
    'server-1',
    'org-1',
    { online: false, colocated: false }
  )
  assertEquals(preview.containers.items.length, 50)
  assertEquals(preview.containers.more, 1)
  assertEquals(preview.networks.more, 1)
  assertEquals(preview.ips.more, 1)
})

test('loadServerDeletePreview sets canForget false when online or colocated', async () => {
  const online = await loadServerDeletePreview(deleteBlockersDb({}), 'server-1', 'org-1', {
    online: true,
    colocated: false,
  })
  assertEquals(online.canForget, false)
  const colocated = await loadServerDeletePreview(deleteBlockersDb({}), 'server-1', 'org-1', {
    online: false,
    colocated: true,
  })
  assertEquals(colocated.canForget, false)
  assertEquals(colocated.colocated, true)
})
