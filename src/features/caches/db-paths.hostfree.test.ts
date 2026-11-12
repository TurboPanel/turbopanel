import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import { createNoopCommandQueue } from '../commands/noop-command-queue.ts'
import { buildCacheApplyPayload, enqueueCacheApply } from './apply-command.ts'
import { findCacheKeyConflicts } from './conflicts.ts'
import {
  deleteCacheRow,
  getEnvironmentCache,
  insertCache,
  listCachesByIds,
  listEnvironmentCaches,
  listServerCachePorts,
  setCacheStatus,
  updateCache,
} from './store.ts'
import {
  CACHE_A,
  cacheRowFixture,
  deriveTestSecrets,
  ENV_1,
  SERVER_1,
} from './fixtures.test.support.ts'

const test = Deno.test.bind(Deno)

/** A select chain that answers each query, in order, with the next canned rows. */
function selectDb(answers: unknown[][], writes: string[] = []): Db {
  let call = 0
  const chain = (): unknown => {
    const rows = answers[call] ?? []
    call += 1
    const node: Record<string, unknown> = {}
    const done = Promise.resolve(rows)
    for (const name of ['from', 'innerJoin', 'where', 'orderBy']) node[name] = () => node
    node.limit = () => done
    node.then = done.then.bind(done)
    return node
  }
  return {
    select: chain,
    insert: () => ({
      values: () => ({ returning: () => Promise.resolve(answers[call++] ?? []) }),
    }),
    update: () => ({
      set: (set: unknown) => ({
        where: () => {
          writes.push(`update ${JSON.stringify(set)}`)
          return Promise.resolve()
        },
      }),
    }),
    delete: () => ({
      where: () => {
        writes.push('delete')
        return Promise.resolve()
      },
    }),
  } as unknown as Db
}

test('conflicts: a service or hostname variable with a cache name is reported once, sorted', async () => {
  const db = selectDb([
    [{ id: 's1' }],
    [{ id: 'h1' }],
    [{ key: 'REDIS_PORT' }, { key: 'REDIS_HOST' }, { key: 'REDIS_PORT' }],
  ])
  assertEquals(await findCacheKeyConflicts(db, ENV_1, ['REDIS_HOST', 'REDIS_PORT']), [
    'REDIS_HOST',
    'REDIS_PORT',
  ])
})

test('conflicts: nothing to check, no services, and no hostings all answer without a clash', async () => {
  assertEquals(await findCacheKeyConflicts(selectDb([]), ENV_1, []), [])
  assertEquals(await findCacheKeyConflicts(selectDb([[]]), ENV_1, ['REDIS_HOST']), [])
  assertEquals(
    await findCacheKeyConflicts(selectDb([[{ id: 's1' }], [], []]), ENV_1, ['REDIS_HOST']),
    []
  )
})

test('store reads join the account name onto each row', async () => {
  const secrets = await deriveTestSecrets()
  const row = await cacheRowFixture(secrets)
  const { username, ...bare } = row
  const entry = { row: bare, username }
  assertEquals((await listEnvironmentCaches(selectDb([[entry]]), ENV_1))[0]?.username, 'siteowner')
  assertEquals((await getEnvironmentCache(selectDb([[entry]]), ENV_1, CACHE_A))?.id, CACHE_A)
  assertEquals(await getEnvironmentCache(selectDb([[]]), ENV_1, CACHE_A), null)
  assertEquals((await listCachesByIds(selectDb([[entry]]), [CACHE_A])).length, 1)
  assertEquals(await listCachesByIds(selectDb([]), []), [])
})

test('cache ports are grouped by server and null ports are skipped', async () => {
  const db = selectDb([
    [
      { serverId: SERVER_1, port: 18200 },
      { serverId: SERVER_1, port: 18201 },
      { serverId: SERVER_1, port: null },
    ],
  ])
  const ports = await listServerCachePorts(db, [SERVER_1])
  assertEquals([...(ports.get(SERVER_1) ?? [])], [18200, 18201])
  assertEquals((await listServerCachePorts(selectDb([]), [])).size, 0)
})

test('store writes: insert returns the row, update and delete reach the table, status skips an empty list', async () => {
  const secrets = await deriveTestSecrets()
  const row = await cacheRowFixture(secrets)
  const writes: string[] = []
  const db = selectDb([[row]], writes)
  const inserted = await insertCache(db, {
    environmentId: ENV_1,
    serverId: SERVER_1,
    principalId: row.principalId,
    name: 'app-cache',
    version: '8.1',
    access: 'socket',
    port: null,
    maxMemoryMb: 64,
    keyPrefix: 'REDIS',
    password: row.password,
  })
  assertEquals(inserted.ok, true)
  assertEquals(await updateCache(db, CACHE_A, { maxMemoryMb: 128 }), { ok: true })
  await deleteCacheRow(db, CACHE_A)
  await setCacheStatus(db, [], 'failed')
  await setCacheStatus(db, [CACHE_A], 'failed')
  assertEquals(writes.length, 3)
})

test('the apply payload is the complete set for the server, with removals', async () => {
  const secrets = await deriveTestSecrets()
  const { username, ...bare } = await cacheRowFixture(secrets)
  const db = selectDb([[{ row: bare, username }]])
  const payload = await buildCacheApplyPayload(
    db,
    {
      environmentId: ENV_1,
      serverId: SERVER_1,
      removed: [
        { id: '00000000-0000-4000-8000-00000000ca09', username: 'siteowner', deleteData: true },
      ],
    },
    { secrets, accountLimits: undefined }
  )
  assertEquals(
    payload.caches.map((entry) => entry.id),
    [CACHE_A]
  )
  assertEquals(payload.removed?.length, 1)
})

test('with no command queue nothing is queued and the reason says so', async () => {
  const deps = { queue: undefined, secrets: undefined, accountLimits: undefined }
  const params = { environmentId: ENV_1, serverId: SERVER_1, removed: [] }
  const actor = { actorType: 'user' as const, actorId: 'u1' }
  assertEquals(await enqueueCacheApply(selectDb([]), actor, params, deps), {
    queued: false,
    reason: 'Command queue unavailable',
  })
  assertEquals(
    (
      await enqueueCacheApply(selectDb([]), actor, params, {
        ...deps,
        queue: createNoopCommandQueue(),
      })
    ).queued,
    false
  )
})
