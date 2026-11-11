import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import {
  applyCacheFailureSideEffect,
  applyCacheResultSideEffect,
  cacheResultPatch,
  writeCacheResults,
} from './results.ts'
import { CACHE_A, CACHE_B, ENV_1 } from './fixtures.test.support.ts'

const test = Deno.test.bind(Deno)

type Write = { set: Record<string, unknown> }

function recordingDb(writes: Write[]): Db {
  return {
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: () => {
          writes.push({ set })
          return Promise.resolve()
        },
      }),
    }),
  } as unknown as Db
}

const cacheEntry = (id: string) => ({
  id,
  name: 'c',
  username: 'u',
  engine: 'valkey' as const,
  version: '8.1',
  access: 'socket' as const,
  maxMemoryMb: 64,
  passwordSha256: 'a'.repeat(64),
})

test('a ready result records the runtime version, a failed one the error', () => {
  assertEquals(cacheResultPatch({ id: CACHE_A, state: 'ready', runtimeVersion: '8.1.11' }, 'T'), {
    status: 'ready',
    metadata: { appliedAt: 'T', runtimeVersion: '8.1.11' },
  })
  assertEquals(cacheResultPatch({ id: CACHE_A, state: 'failed', error: 'no space' }, 'T'), {
    status: 'failed',
    metadata: { appliedAt: 'T', lastError: 'no space' },
  })
  assertEquals(cacheResultPatch({ id: CACHE_A, state: 'pending' }, 'T').status, 'pending')
})

test('only ids the command carried are written', async () => {
  const writes: Write[] = []
  const written = await writeCacheResults(
    recordingDb(writes),
    [
      { id: CACHE_A, state: 'ready' },
      { id: CACHE_B, state: 'ready' },
    ],
    new Set([CACHE_A]),
    'T'
  )
  assertEquals(written, 1)
  assertEquals(writes.length, 1)
})

test('a succeeded cache.apply writes its results; other command types write nothing', async () => {
  const writes: Write[] = []
  const db = recordingDb(writes)
  await applyCacheResultSideEffect(
    db,
    {
      id: 'c1',
      type: 'cache.apply',
      payload: { environmentId: ENV_1, caches: [cacheEntry(CACHE_A)] },
    },
    { caches: [{ id: CACHE_A, state: 'ready', runtimeVersion: '8.1.11' }] }
  )
  assertEquals(writes.length, 1)
  await applyCacheResultSideEffect(db, { id: 'c2', type: 'daemon.ping', payload: {} }, {})
  assertEquals(writes.length, 1)
})

test('a deploy result writes the caches the deploy carried, and none when it carried none', async () => {
  const writes: Write[] = []
  const db = recordingDb(writes)
  const payload = (caches?: unknown[]) => ({
    environmentId: ENV_1,
    projectId: 'proj-1',
    organizationId: 'org-1',
    projectName: 'tp-demo',
    composeFiles: [{ filename: 'compose.yaml', role: 'runtime', content: 'services: {}\n' }],
    hostings: [],
    ...(caches === undefined ? {} : { caches }),
  })
  await applyCacheResultSideEffect(
    db,
    { id: 'd1', type: 'environment.deploy', payload: payload([cacheEntry(CACHE_A)]) },
    { projectName: 'n', caches: [{ id: CACHE_A, state: 'failed', error: 'boom' }] }
  )
  assertEquals(writes.length, 1)
  await applyCacheResultSideEffect(
    db,
    { id: 'd2', type: 'environment.deploy', payload: payload([]) },
    { projectName: 'n' }
  )
  assertEquals(writes.length, 1)
})

test('a stopped environment marks its caches stopped', async () => {
  const writes: Write[] = []
  await applyCacheResultSideEffect(
    recordingDb(writes),
    {
      id: 's1',
      type: 'environment.stop',
      payload: { environmentId: ENV_1, projectId: 'p', projectName: 'n' },
    },
    {}
  )
  assertEquals(writes[0]?.set, { status: 'stopped' })
})

test('a failed cache.apply moves its applying caches to failed; a bad payload is swallowed', async () => {
  const writes: Write[] = []
  const db = recordingDb(writes)
  await applyCacheFailureSideEffect(
    db,
    {
      id: 'f1',
      type: 'cache.apply',
      payload: { environmentId: ENV_1, caches: [cacheEntry(CACHE_A)] },
    },
    'host unreachable'
  )
  assertEquals(writes[0]?.set.status, 'failed')
  await applyCacheFailureSideEffect(db, { id: 'f2', type: 'cache.apply', payload: 'bad' }, 'x')
  await applyCacheFailureSideEffect(db, { id: 'f3', type: 'daemon.ping', payload: {} }, 'x')
  await applyCacheFailureSideEffect(
    db,
    { id: 'f4', type: 'cache.apply', payload: { environmentId: ENV_1, caches: [] } },
    'x'
  )
  assertEquals(writes.length, 1)
})
