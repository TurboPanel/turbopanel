/**
 * Host-free coverage for the list a Destroy that deletes data acts on: which
 * registered Docker volumes go, which stay, and why.
 */
import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import {
  classifyDataVolumes,
  type DataVolumeCandidate,
  listEnvironmentDataVolumes,
} from './data-volumes.ts'

/** Sonar typescript:S2187 only recognizes `test()`; alias Deno.test so analysis sees it. */
const test = Deno.test.bind(Deno)

const A = '0195a5a0-0000-7000-8000-00000000000a'
const B = '0195a5a0-0000-7000-8000-00000000000b'
const C = '0195a5a0-0000-7000-8000-00000000000c'
const D = '0195a5a0-0000-7000-8000-00000000000d'
const E = '0195a5a0-0000-7000-8000-00000000000e'

function candidate(overrides: Partial<DataVolumeCandidate>): DataVolumeCandidate {
  return {
    storageId: A,
    name: 'data',
    isCommon: false,
    metadata: { dockerVolumeName: overrides.storageId ?? A },
    copyOptions: { managed: true },
    usedElsewhere: false,
    ...overrides,
  }
}

/** Drizzle-shaped double: each `await` consumes the next queued result set. */
function fakeDb(resultSets: unknown[][]): Db {
  const queue = [...resultSets]
  const chain: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          const promise = Promise.resolve(queue.shift() ?? [])
          return promise.then.bind(promise)
        }
        if (prop === 'catch' || prop === 'finally') return undefined
        return () => chain
      },
    }
  )
  return chain as Db
}

test('classifyDataVolumes keeps common, shared, external and renamed volumes', () => {
  const result = classifyDataVolumes([
    candidate({ storageId: B, name: 'uploads', metadata: null }),
    candidate({ storageId: A, name: 'db' }),
    candidate({ storageId: C, name: 'common', isCommon: true }),
    candidate({ storageId: D, name: 'shared', usedElsewhere: true }),
    candidate({ storageId: E, name: 'outside', copyOptions: { managed: false } }),
    candidate({ storageId: 'not-a-uuid', name: 'odd', metadata: null }),
    candidate({
      storageId: '0195a5a0-0000-7000-8000-0000000000ff',
      name: 'pinned',
      metadata: { dockerVolumeName: 'someone_elses_volume' },
    }),
  ])
  assertEquals(result.volumes, [
    { storageId: A, name: 'db' },
    { storageId: B, name: 'uploads' },
  ])
  assertEquals(
    result.kept.map(({ name, reason }) => [name, reason]),
    [
      ['common', 'common'],
      ['odd', 'renamed'],
      ['outside', 'external'],
      ['pinned', 'renamed'],
      ['shared', 'shared'],
    ]
  )
  for (const entry of result.kept) assertEquals(entry.message.length > 0, true)
})

test('classifyDataVolumes keeps a volume when any of its copies says so', () => {
  const result = classifyDataVolumes([
    candidate({ storageId: A, name: 'db' }),
    candidate({ storageId: A, name: 'db', copyOptions: { managed: false } }),
  ])
  assertEquals(result.volumes, [])
  assertEquals(result.kept.length, 1)
  assertEquals(result.kept[0]?.reason, 'external')
})

test('listEnvironmentDataVolumes marks volumes another environment uses', async () => {
  const db = fakeDb([
    [{ id: 'svc-1' }],
    [
      { storageId: A, name: 'db', isCommon: false, metadata: null, copyOptions: null },
      { storageId: B, name: 'files', isCommon: false, metadata: null, copyOptions: null },
      { storageId: C, name: 'cache', isCommon: false, metadata: null, copyOptions: null },
    ],
    [{ storageId: B }],
    [{ storageId: C }],
  ])
  const result = await listEnvironmentDataVolumes(db, 'env-1')
  assertEquals(result.volumes, [{ storageId: A, name: 'db' }])
  assertEquals(
    result.kept.map(({ name, reason }) => [name, reason]),
    [
      ['cache', 'shared'],
      ['files', 'shared'],
    ]
  )
})

test('listEnvironmentDataVolumes returns nothing for an environment without Docker volumes', async () => {
  const result = await listEnvironmentDataVolumes(fakeDb([[], []]), 'env-1')
  assertEquals(result, { volumes: [], kept: [] })
})
