import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import { recordInstanceAcmeApplyTimeout } from './instance-hostnames.ts'

const test = Deno.test

test('recordInstanceAcmeApplyTimeout stamps every lets-encrypt row with the message', async () => {
  const updates: Array<Record<string, unknown>> = []
  const db = {
    update() {
      return {
        set(values: Record<string, unknown>) {
          updates.push(values)
          return { where: () => Promise.resolve() }
        },
      }
    },
  }
  const message = 'The server did not answer in time; check its status and try again'
  await recordInstanceAcmeApplyTimeout(db as unknown as Db, message, '2026-10-04T00:00:00.000Z')
  assertEquals(updates, [{ acmeLastAttemptAt: '2026-10-04T00:00:00.000Z', acmeLastError: message }])
})
