/** Host-free coverage for the request and daemon checks of a Destroy that deletes data. */
import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import {
  outdatedServersMessage,
  parseDestroyRequest,
  serversWithoutVolumeRemoval,
} from './destroy-data.ts'

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
  assertEquals(parseDestroyRequest({ deleteVolumes: true, confirmName: 'staging' }), {
    deleteVolumes: true,
    confirmName: 'staging',
  })
  assertEquals(parseDestroyRequest({ deleteVolumes: 'yes' }), 'invalid')
  assertEquals(parseDestroyRequest({ deleteVolumes: true, confirmName: 3 }), 'invalid')
})

test('serversWithoutVolumeRemoval names each server whose daemon is too old', async () => {
  const features: Record<string, string[]> = {
    s1: ['environment-stop-remove-volumes-v1'],
    s2: ['deploy-cancel-v1'],
    s3: [],
  }
  const db = fakeDb([
    [
      { id: 's2', name: 'web-2', hostname: 'web-2.example.com' },
      { id: 's3', name: null, hostname: 'db.example.com' },
    ],
  ])
  const outdated = await serversWithoutVolumeRemoval(db, ['s1', 's2', 's3'], (_db, id) =>
    Promise.resolve(features[id] ?? [])
  )
  assertEquals(outdated, [
    { serverId: 's2', name: 'web-2' },
    { serverId: 's3', name: 'db.example.com' },
  ])
  assertEquals(
    outdatedServersMessage(outdated),
    'Update the daemon on web-2, db.example.com before deleting data volumes. Nothing was destroyed.'
  )
})

test('serversWithoutVolumeRemoval is empty when every daemon lists the feature', async () => {
  const outdated = await serversWithoutVolumeRemoval(fakeDb([]), ['s1'], () =>
    Promise.resolve(['environment-stop-remove-volumes-v1'])
  )
  assertEquals(outdated, [])
})
