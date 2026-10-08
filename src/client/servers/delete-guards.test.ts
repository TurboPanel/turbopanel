import { assertEquals } from '@std/assert'
import type { Context } from 'hono'
import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import type { Db } from '../../db/connection.ts'
import {
  deployment,
  environment,
  ip,
  managed,
  network,
  replica,
  server,
  slot,
  storageCopy,
} from '../../db/schema.ts'
import { isServerConnectedStoredOrLive } from '../../daemon/cell/server-status.ts'
import {
  COLOCATED_SERVER_DELETE_BLOCKED_REASON,
  SERVER_DELETE_BLOCKER_LABELS,
  SERVER_HAS_BLOCKERS_CODE,
  SERVER_HAS_BLOCKERS_ERROR,
  SERVER_ONLINE_CODE,
  SERVER_ONLINE_ERROR,
  assertServerOfflineForForget,
  blockersThatPreventForget,
  canForgetServerResources,
  colocatedServerDeleteBlockedReason,
  isServerOnlineDuringForgetError,
  listServerDeleteBlockers,
  loadServerDeletePreview,
  parseForgetResourcesFlag,
  planServerForget,
  serverBlockerItemName,
  ServerOnlineDuringForgetError,
  serverDeleteBlockersResponse,
  serverOnlineForgetBlockedResponse,
  type ServerBlockerEnvironmentItem,
  type ServerDeleteBlocker,
  type ServerDeleteBlockerKind,
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
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    limit: () => promise,
    orderBy: () => chain,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  }
  return chain
}

function joinedCount(value: number) {
  const chain = {
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: () => thenableRows([{ value }]),
  }
  return chain
}

function deleteBlockersDb(opts: {
  serverMissing?: boolean
  networkCount?: number
  containerCount?: number | string
  ipCount?: number
  environmentCount?: number
  managedCount?: number
  replicaCount?: number
  deploymentCount?: number
  slotCount?: number
  copyCount?: number
  networkRows?: Array<{ id: string; name: string | null }>
  ipRows?: Array<{ id: string; address: string }>
  containerRows?: Array<{
    id: string
    name: string
    status: string
    serviceName: string | null
  }>
  placedEnvironmentRows?: Array<{
    id: string
    name: string | null
    projectId: string
    projectName: string | null
    managedId: string | null
  }>
  managedTouchRows?: Array<{
    id: string
    name: string | null
    engine: string
    managedServerId: string | null
    environmentServerId: string | null
  }>
  replicaTouchRows?: Array<{
    id: string
    managedId: string
    serverId: string
    role: string
    databaseName: string | null
    engine: string
  }>
  otherReplicaRows?: Array<{
    id: string
    managedId: string
    serverId: string
    role: string
  }>
}): Db {
  let executeCalls = 0
  return {
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) => {
        if (table === environment) {
          if (fields && 'projectName' in fields) {
            return thenableRows(opts.placedEnvironmentRows ?? [])
          }
          return joinedCount(opts.environmentCount ?? 0)
        }
        if (table === managed) {
          if (fields && 'engine' in fields) return thenableRows(opts.managedTouchRows ?? [])
          return joinedCount(opts.managedCount ?? 0)
        }
        if (table === replica) {
          if (fields && 'databaseName' in fields) {
            return thenableRows(opts.replicaTouchRows ?? [])
          }
          if (fields && 'managedId' in fields) return thenableRows(opts.otherReplicaRows ?? [])
          return joinedCount(opts.replicaCount ?? 0)
        }
        if (table === deployment) return joinedCount(opts.deploymentCount ?? 0)
        if (table === slot) return joinedCount(opts.slotCount ?? 0)
        return {
          where: () => {
            if (table === server) {
              return {
                limit: () => Promise.resolve(opts.serverMissing ? [] : [{ id: 'server-1' }]),
                for: () => ({
                  limit: () => Promise.resolve([{ isConnected: true }]),
                }),
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
            if (table === storageCopy) {
              return thenableRows([{ value: opts.copyCount ?? 0 }])
            }
            return thenableRows([{ value: 0 }])
          },
        }
      },
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
    { kind: 'network', count: 2, label: SERVER_DELETE_BLOCKER_LABELS.network },
    { kind: 'container', count: 1, label: SERVER_DELETE_BLOCKER_LABELS.container },
  ]
  const response = serverDeleteBlockersResponse(mockContext(), blockers)
  assertEquals(response.status, 409)
  assertEquals(await response.json(), {
    error: SERVER_HAS_BLOCKERS_ERROR,
    code: SERVER_HAS_BLOCKERS_CODE,
    blockers,
  })
})

test('serverDeleteBlockersResponse includes capped blocked databases', async () => {
  const blockers: ServerDeleteBlocker[] = [
    { kind: 'managed', count: 1, label: SERVER_DELETE_BLOCKER_LABELS.managed },
  ]
  const response = serverDeleteBlockersResponse(mockContext(), blockers, [
    { id: 'db-1', name: 'orders', reason: 'only_member' },
  ])
  assertEquals(response.status, 409)
  assertEquals(await response.json(), {
    error: SERVER_HAS_BLOCKERS_ERROR,
    code: SERVER_HAS_BLOCKERS_CODE,
    blockers,
    blockedDatabases: [{ id: 'db-1', name: 'orders', reason: 'only_member' }],
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
    { kind: 'network', count: 2, label: SERVER_DELETE_BLOCKER_LABELS.network },
    { kind: 'container', count: 3, label: SERVER_DELETE_BLOCKER_LABELS.container },
    { kind: 'ip', count: 4, label: SERVER_DELETE_BLOCKER_LABELS.ip },
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
    { kind: 'network', count: 1, label: SERVER_DELETE_BLOCKER_LABELS.network },
    { kind: 'container', count: 1, label: SERVER_DELETE_BLOCKER_LABELS.container },
    { kind: 'ip', count: 1, label: SERVER_DELETE_BLOCKER_LABELS.ip },
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
  assertEquals(preview.environments, { items: [], more: 0 })
  assertEquals(preview.members, { items: [], more: 0 })
  assertEquals(preview.blockedDatabases, { items: [], more: 0 })
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

const RESTRICT_BLOCKER_KINDS = [
  'environment',
  'managed',
  'replica',
  'deployment',
  'slot',
  'copy',
] as const satisfies readonly ServerDeleteBlockerKind[]

const RESTRICT_COUNT_KEYS = {
  environment: 'environmentCount',
  managed: 'managedCount',
  replica: 'replicaCount',
  deployment: 'deploymentCount',
  slot: 'slotCount',
  copy: 'copyCount',
} as const

for (const kind of RESTRICT_BLOCKER_KINDS) {
  test(`listServerDeleteBlockers reports ${kind} leftovers with a UI label`, async () => {
    const blockers = await listServerDeleteBlockers(
      deleteBlockersDb({ [RESTRICT_COUNT_KEYS[kind]]: 2 }),
      'server-1',
      'org-1'
    )
    assertEquals(blockers, [{ kind, count: 2, label: SERVER_DELETE_BLOCKER_LABELS[kind] }])
  })

  test(`loadServerDeletePreview still lists a ${kind} leftover`, async () => {
    const preview = await loadServerDeletePreview(
      deleteBlockersDb({ [RESTRICT_COUNT_KEYS[kind]]: 1 }),
      'server-1',
      'org-1',
      { online: false, colocated: false }
    )
    assertEquals(preview.blockers[0]?.kind, kind)
    assertEquals(preview.canForget, true)
  })
}

function environmentItems(
  blocker: ServerDeleteBlocker | undefined
): ServerBlockerEnvironmentItem[] {
  return (blocker?.items ?? []).filter(
    (item): item is ServerBlockerEnvironmentItem => 'hasDatabase' in item
  )
}

function placedEnvironmentsDb() {
  return deleteBlockersDb({
    environmentCount: 3,
    placedEnvironmentRows: [
      { id: 'env-3', name: 'edge', projectId: 'proj-2', projectName: 'Beta', managedId: null },
      {
        id: 'env-2',
        name: 'staging',
        projectId: 'proj-1',
        projectName: 'Acme',
        managedId: 'db-1',
      },
      {
        id: 'env-1',
        name: 'production',
        projectId: 'proj-1',
        projectName: 'Acme',
        managedId: null,
      },
    ],
    managedTouchRows: [
      {
        id: 'db-1',
        name: 'orders',
        engine: 'postgres',
        managedServerId: null,
        environmentServerId: 'server-1',
      },
    ],
  })
}

test('planServerForget names every placed environment behind the environment blocker', async () => {
  const plan = await planServerForget(placedEnvironmentsDb(), 'server-1', 'org-1')
  assertEquals(
    plan.blockers.find((row) => row.kind === 'environment'),
    {
      kind: 'environment',
      count: 3,
      label: SERVER_DELETE_BLOCKER_LABELS.environment,
      items: [
        {
          id: 'env-1',
          name: 'production',
          projectId: 'proj-1',
          projectName: 'Acme',
          hasDatabase: false,
        },
        {
          id: 'env-2',
          name: 'staging',
          projectId: 'proj-1',
          projectName: 'Acme',
          hasDatabase: true,
        },
        { id: 'env-3', name: 'edge', projectId: 'proj-2', projectName: 'Beta', hasDatabase: false },
      ],
      more: 0,
    }
  )
})

test('forget covers every environment the blocker counts except the ones carrying a database', async () => {
  const plan = await planServerForget(placedEnvironmentsDb(), 'server-1', 'org-1')
  const blocker = plan.blockers.find((row) => row.kind === 'environment')
  const items = environmentItems(blocker)
  assertEquals(items.length, blocker?.count)
  const forgotten = new Set(plan.environmentIds)
  for (const item of items) {
    assertEquals(forgotten.has(item.id), !item.hasDatabase)
  }
  assertEquals(plan.environmentIds, ['env-1', 'env-3'])
  assertEquals(
    items.filter((item) => item.hasDatabase).map((item) => item.id),
    ['env-2']
  )
})

test('planServerForget names the blocked database behind the blocking blocker', async () => {
  const plan = await planServerForget(placedEnvironmentsDb(), 'server-1', 'org-1')
  assertEquals(plan.blockedDatabases, [{ id: 'db-1', name: 'orders', reason: 'only_member' }])
  assertEquals(plan.blockingBlockers, [
    {
      kind: 'managed',
      count: 1,
      label: SERVER_DELETE_BLOCKER_LABELS.managed,
      items: [{ id: 'db-1', name: 'orders' }],
      more: 0,
    },
  ])
})

test('planServerForget names the database behind a forgettable member blocker', async () => {
  const plan = await planServerForget(
    deleteBlockersDb({
      replicaCount: 1,
      replicaTouchRows: [
        {
          id: 'rep-1',
          managedId: 'db-3',
          serverId: 'server-1',
          role: 'replica',
          databaseName: 'carts',
          engine: 'mysql',
        },
      ],
      otherReplicaRows: [{ id: 'rep-0', managedId: 'db-3', serverId: 'server-2', role: 'primary' }],
    }),
    'server-1',
    'org-1'
  )
  assertEquals(plan.blockedDatabases, [])
  assertEquals(plan.blockers, [
    {
      kind: 'replica',
      count: 1,
      label: SERVER_DELETE_BLOCKER_LABELS.replica,
      items: [{ id: 'db-3', name: 'carts' }],
      more: 0,
    },
  ])
  assertEquals(plan.members, [{ id: 'rep-1', databaseName: 'carts' }])
})

test('environment blocker items stop at 50 and report the rest', async () => {
  const plan = await planServerForget(
    deleteBlockersDb({
      environmentCount: 52,
      placedEnvironmentRows: Array.from({ length: 52 }, (_, i) => ({
        id: `env-${String(i).padStart(2, '0')}`,
        name: `e${String(i).padStart(2, '0')}`,
        projectId: 'proj-1',
        projectName: 'Acme',
        managedId: null,
      })),
    }),
    'server-1',
    'org-1'
  )
  const blocker = plan.blockers.find((row) => row.kind === 'environment')
  assertEquals(blocker?.items?.length, 50)
  assertEquals(blocker?.more, 2)
  assertEquals(plan.environmentIds.length, 52)
})

test('serverBlockerItemName reads as Project / Environment for environments', () => {
  assertEquals(
    serverBlockerItemName({
      id: 'env-1',
      name: 'production',
      projectId: 'proj-1',
      projectName: 'Acme',
      hasDatabase: false,
    }),
    'Acme / production'
  )
  assertEquals(serverBlockerItemName({ id: 'db-1', name: 'orders' }), 'orders')
})

test('blockersThatPreventForget keeps managed leftovers that still block forget', () => {
  const blockers: ServerDeleteBlocker[] = [
    { kind: 'network', count: 1, label: SERVER_DELETE_BLOCKER_LABELS.network },
    { kind: 'environment', count: 1, label: SERVER_DELETE_BLOCKER_LABELS.environment },
    { kind: 'managed', count: 1, label: SERVER_DELETE_BLOCKER_LABELS.managed },
  ]
  assertEquals(blockersThatPreventForget(blockers), [blockers[2]])
})

test('canForgetServerResources is true only when offline, not colocated, and no blocked database', () => {
  assertEquals(
    canForgetServerResources({ online: false, colocated: false, blockedDatabaseCount: 0 }),
    true
  )
  assertEquals(
    canForgetServerResources({ online: false, colocated: false, blockedDatabaseCount: 1 }),
    false
  )
})

test('isServerConnectedStoredOrLive is true when the stored column is connected', async () => {
  assertEquals(await isServerConnectedStoredOrLive({} as Db, undefined, 'server-1', true), true)
})

test('isServerConnectedStoredOrLive is true when the column is false but the live snapshot is connected', async () => {
  const now = new Date().toISOString()
  const db = {
    select: () => ({
      from: () => ({
        where: () =>
          Promise.resolve([
            {
              id: 'server-1',
              daemon: {},
              metadata: {},
              hostname: null,
              machineKey: null,
              osId: null,
              osFamily: null,
              osVersion: null,
              osCodename: null,
              osPrettyName: null,
              osArchitecture: null,
              timezone: null,
              isTimeSyncEnabled: null,
              ntpServers: null,
              ntpLastSyncedAt: null,
              connected: false,
              statusChangedAt: '2020-01-01T00:00:00.000Z',
            },
          ]),
      }),
    }),
  } as unknown as Db
  const registry = {
    getSnapshots: () =>
      Promise.resolve(
        new Map([
          [
            'server-1',
            {
              serverId: 'server-1',
              version: 1,
              updatedAt: now,
              connected: true,
              lastInboundAt: now,
            },
          ],
        ])
      ),
  } as unknown as DaemonCellRegistry
  assertEquals(await isServerConnectedStoredOrLive(db, registry, 'server-1', false), true)
})

test('assertServerOfflineForForget refuses when the locked row is connected', async () => {
  try {
    await assertServerOfflineForForget(deleteBlockersDb({}), 'server-1')
    throw new Error('expected ServerOnlineDuringForgetError')
  } catch (err) {
    assertEquals(err instanceof ServerOnlineDuringForgetError, true)
    assertEquals(isServerOnlineDuringForgetError(err), true)
  }
})
