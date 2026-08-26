/**
 * Host-free coverage for deployment history reads (mock Db).
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db.ts'
import {
  DEPLOYMENT_HISTORY_DEFAULT_LIMIT,
  DEPLOYMENT_HISTORY_MAX_LIMIT,
  getEnvironmentDeploymentDetail,
  listEnvironmentDeploymentHistory,
} from './deployment-history.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const envId = '00000000-0000-4000-8000-000000000001'
const serverId = '00000000-0000-4000-8000-00000000000a'

function thenableRows(rows: unknown[]) {
  const promise = Promise.resolve(rows)
  return {
    leftJoin: () => thenableRows(rows),
    where: () => thenableRows(rows),
    orderBy: () => thenableRows(rows),
    limit: () => promise,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  }
}

type HistoryDb = Db & {
  commandRows: unknown[]
  deploymentRows: unknown[]
}

function createHistoryDb(opts?: {
  commandRows?: unknown[]
  deploymentRows?: unknown[]
}): HistoryDb {
  const commandRows = opts?.commandRows ?? []
  const deploymentRows = opts?.deploymentRows ?? []
  const db = {
    commandRows,
    deploymentRows,
    select: () => ({
      from: () => ({
        leftJoin: () => thenableRows(commandRows),
        where: () => thenableRows(deploymentRows),
      }),
    }),
  }
  return db as unknown as HistoryDb
}

const deployRow = {
  id: '00000000-0000-4000-8000-000000000100',
  serverId,
  status: 'succeeded',
  context: {
    environmentId: envId,
    generation: 2,
    desiredHash: 'deadbeef',
    replicaCounts: { web: 1 },
  },
  actorType: 'user',
  actorId: '00000000-0000-4000-8000-000000000020',
  errorCode: null,
  errorMessage: null,
  createdAt: '2030-01-01T00:00:00.000Z',
  queuedAt: '2030-01-01T00:00:01.000Z',
  startedAt: '2030-01-01T00:00:02.000Z',
  finishedAt: '2030-01-01T00:00:05.000Z',
  serverName: 'edge-1',
}

test('listEnvironmentDeploymentHistory serializes context and paginates', async () => {
  const olderId = '00000000-0000-4000-8000-000000000099'
  const db = createHistoryDb({
    commandRows: [
      deployRow,
      { ...deployRow, id: olderId, finishedAt: '2030-01-01T00:00:04.000Z' },
      { ...deployRow, id: '00000000-0000-4000-8000-000000000098' },
    ],
  })

  const page = await listEnvironmentDeploymentHistory(db, envId, { limit: 2 })
  assertEquals(page.deployments.length, 2)
  assertEquals(page.deployments[0]?.generation, 2)
  assertEquals(page.deployments[0]?.desiredHash, 'deadbeef')
  assertEquals(page.deployments[0]?.replicaCounts, { web: 1 })
  assertEquals(page.deployments[0]?.durationMs, 3000)
  assertEquals(page.deployments[0]?.hasLog, false)
  assertEquals(page.nextCursor, olderId)
})

test('listEnvironmentDeploymentHistory clamps limit bounds', async () => {
  const db = createHistoryDb({ commandRows: [] })
  await listEnvironmentDeploymentHistory(db, envId, { limit: 0 })
  await listEnvironmentDeploymentHistory(db, envId, {
    limit: DEPLOYMENT_HISTORY_MAX_LIMIT + 50,
  })
  assertEquals(DEPLOYMENT_HISTORY_DEFAULT_LIMIT, 20)
  assertEquals(DEPLOYMENT_HISTORY_MAX_LIMIT, 100)
})

test('getEnvironmentDeploymentDetail returns null for a missing anchor', async () => {
  const db = createHistoryDb({ commandRows: [] })
  const detail = await getEnvironmentDeploymentDetail(
    db,
    envId,
    '00000000-0000-4000-8000-0000000000ff',
  )
  assertEquals(detail, null)
})

test('getEnvironmentDeploymentDetail fans out same-generation siblings', async () => {
  const siblingServer = '00000000-0000-4000-8000-00000000000b'
  const db = createHistoryDb({
    commandRows: [
      deployRow,
      {
        ...deployRow,
        id: '00000000-0000-4000-8000-000000000101',
        serverId: siblingServer,
        serverName: 'edge-2',
        context: {
          ...deployRow.context,
          replicaCounts: { web: 2 },
        },
      },
    ],
    deploymentRows: [
      {
        serverId,
        desiredGeneration: 2,
        appliedGeneration: 2,
        status: 'applied',
      },
      {
        serverId: siblingServer,
        desiredGeneration: 2,
        appliedGeneration: 2,
        status: 'applied',
      },
    ],
  })

  const detail = await getEnvironmentDeploymentDetail(
    db,
    envId,
    deployRow.id,
    {
      logStore: {
        exists: async (id) => id === deployRow.id,
      },
    },
  )

  assertEquals(detail?.generation, 2)
  assertEquals(detail?.commands.length, 2)
  assertEquals(detail?.replicaCounts, { web: 3 })
  assertEquals(detail?.totalReplicas, 3)
  assertEquals(detail?.commands[0]?.hasLog, true)
  assertEquals(detail?.servers[1]?.totalReplicas, 2)
})
