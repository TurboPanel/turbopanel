import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import type { Alert } from './alert-sender.ts'
import { haPrimaryNamesOnServer, resolveAlertSender } from './resolve-alert-sender.ts'

/** Jest/Mocha-shaped alias so Sonar typescript:S2187 sees real tests. */
const test = Deno.test.bind(Deno)

/** A Db double that records how many times anything touched it. */
function countingDb(): { db: Db; touches: () => number } {
  let touched = 0
  const db = new Proxy(
    {},
    {
      get() {
        touched += 1
        throw new Error('db must not be touched')
      },
    }
  ) as unknown as Db
  return { db, touches: () => touched }
}

const NO_SERVER: Alert = { kind: 'server.offline', text: 'x', detail: {} }

test('idle tick: no legacy-webhook DB op and the mail setup is never resolved', async () => {
  const { db, touches } = countingDb()
  let emailResolutions = 0
  const sender = await resolveAlertSender(
    db,
    undefined,
    undefined,
    undefined,
    () => {
      emailResolutions += 1
      return Promise.resolve(undefined)
    },
    { adoptLegacy: false }
  )
  assertEquals(touches(), 0)
  assertEquals(emailResolutions, 0)
  // An alert that maps to no event still never needs the mail setup.
  await sender(NO_SERVER)
  assertEquals(emailResolutions, 0)
})

test('adoptLegacy defaults to on: the DB is consulted once', async () => {
  const { db, touches } = countingDb()
  await resolveAlertSender(db, undefined)
  assertEquals(touches() > 0, true)
})

/** Drizzle-shaped double: each query (one `select`) consumes the next queued result set. */
function queuedDb(resultSets: unknown[][]): Db {
  const queue = [...resultSets]
  return {
    select: () => {
      const rows = Promise.resolve(queue.shift() ?? [])
      const chain: unknown = new Proxy(
        {},
        {
          get(_target, prop) {
            if (prop === 'then' || prop === 'catch' || prop === 'finally') {
              return (rows[prop] as (...args: unknown[]) => unknown).bind(rows)
            }
            return () => chain
          },
        }
      )
      return chain
    },
  } as unknown as Db
}

test('the offline alert names the high availability databases whose primary the server hosts', async () => {
  const db = queuedDb([
    [
      { managedId: 'm1', name: 'orders' },
      { managedId: 'm2', name: null },
      { managedId: 'm3', name: 'solo' },
    ],
    // m1 has two members, m2 two, m3 only one (not HA): the lone one is left out.
    [
      { managedId: 'm1' },
      { managedId: 'm1' },
      { managedId: 'm2' },
      { managedId: 'm2' },
      { managedId: 'm3' },
    ],
  ])
  assertEquals(await haPrimaryNamesOnServer(db, 'srv'), 'orders, m2')
})

test('no primary, only single-member databases, or a failed lookup add nothing to the alert', async () => {
  assertEquals(await haPrimaryNamesOnServer(queuedDb([[]]), 'srv'), null)
  assertEquals(
    await haPrimaryNamesOnServer(
      queuedDb([[{ managedId: 'm1', name: 'solo' }], [{ managedId: 'm1' }]]),
      'srv'
    ),
    null
  )
  const broken = {
    select: () => {
      throw new Error('database down')
    },
  } as unknown as Db
  assertEquals(await haPrimaryNamesOnServer(broken, 'srv'), null)
})

test('the names are capped so one alert stays short', async () => {
  const primaries = Array.from({ length: 8 }, (_, i) => ({ managedId: `m${i}`, name: `db${i}` }))
  const members = primaries.flatMap((p) => [{ managedId: p.managedId }, { managedId: p.managedId }])
  assertEquals(
    await haPrimaryNamesOnServer(queuedDb([primaries, members]), 'srv'),
    'db0, db1, db2, db3, db4 and 3 more'
  )
})
