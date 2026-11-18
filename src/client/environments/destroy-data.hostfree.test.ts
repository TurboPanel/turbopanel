/** Host-free coverage for the request and daemon checks of a Destroy that deletes data. */
import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import { parseDestroyRequest, sameVolumeList } from './destroy-data.ts'

/** Sonar typescript:S2187 only recognizes `test()`; alias Deno.test so analysis sees it. */
const test = Deno.test.bind(Deno)

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

test('parseDestroyRequest keeps an empty body a plain Destroy', () => {
  assertEquals(parseDestroyRequest({}), { deleteVolumes: false })
  assertEquals(parseDestroyRequest({ deleteVolumes: false, confirmName: 'x' }), {
    deleteVolumes: false,
    confirmName: 'x',
  })
  assertEquals(
    parseDestroyRequest({ deleteVolumes: true, confirmName: 'staging', volumeIds: ['a'] }),
    { deleteVolumes: true, confirmName: 'staging', volumeIds: ['a'] }
  )
  assertEquals(parseDestroyRequest({ deleteVolumes: 'yes' }), 'invalid')
  assertEquals(
    parseDestroyRequest({ deleteVolumes: true, confirmName: 3, volumeIds: [] }),
    'invalid'
  )
  // Deleting data names the list that was shown.
  assertEquals(parseDestroyRequest({ deleteVolumes: true, confirmName: 'staging' }), 'invalid')
  assertEquals(
    parseDestroyRequest({ deleteVolumes: true, confirmName: 'staging', volumeIds: [1] }),
    'invalid'
  )
})

test('sameVolumeList compares the shown ids as a set', () => {
  const volumes = [{ storageId: 'a' }, { storageId: 'b' }]
  assertEquals(sameVolumeList(['b', 'a'], volumes), true)
  assertEquals(sameVolumeList(['a', 'a', 'b'], volumes), true)
  assertEquals(sameVolumeList(['a'], volumes), false)
  assertEquals(sameVolumeList(['a', 'b', 'c'], volumes), false)
  assertEquals(sameVolumeList(undefined, []), true)
  assertEquals(sameVolumeList([], []), true)
})
