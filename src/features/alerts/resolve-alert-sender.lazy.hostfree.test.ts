import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import type { Alert } from './alert-sender.ts'
import { resolveAlertSender } from './resolve-alert-sender.ts'

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
