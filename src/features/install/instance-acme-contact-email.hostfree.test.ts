/**
 * The instance ACME contact email reaches a root-run playbook as a key=value
 * extra-var on the daemon, so the control plane refuses anything but a plain
 * address before it is stored (Road to 0.2.x row r2-acme-email-validation).
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import { updateInstanceAcmeSettings } from './instance-acme-settings.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

type Written = { key: string; value: unknown }

function createSettingsDb(written: Written[]): Db {
  const db = {
    select() {
      return { from: () => ({ where: () => Promise.resolve([]) }) }
    },
    insert() {
      return {
        values(value: Written) {
          written.push(value)
          const promise = Promise.resolve()
          return Object.assign(promise, { onConflictDoUpdate: () => promise })
        },
      }
    },
  }
  return db as unknown as Db
}

const MALFORMED = [
  'not-an-email',
  'ops @example.com',
  'ops@example.com\nturbopanel_x=1',
  'ops@example.com -e x=1',
  'ops@example.com;id',
  '.ops@example.com',
  'ops@localhost',
]

const PLAIN = ['ops@example.com', 'first.last+acme@mail.example.co.uk', '']

test('a malformed contact email is refused and nothing is stored', async () => {
  const outcomes = await Promise.all(
    MALFORMED.map(async (contactEmail) => {
      const written: Written[] = []
      const result = await updateInstanceAcmeSettings(
        createSettingsDb(written),
        {},
        { contactEmail }
      )
      return { contactEmail, ok: result.ok, stored: written.length }
    })
  )
  for (const { contactEmail, ok, stored } of outcomes) {
    assertEquals(ok, false, JSON.stringify(contactEmail))
    assertEquals(stored, 0, JSON.stringify(contactEmail))
  }
})

test('a plain contact email is accepted', async () => {
  const outcomes = await Promise.all(
    PLAIN.map(async (contactEmail) => {
      const result = await updateInstanceAcmeSettings(createSettingsDb([]), {}, { contactEmail })
      return { contactEmail, ok: result.ok }
    })
  )
  for (const { contactEmail, ok } of outcomes) assertEquals(ok, true, JSON.stringify(contactEmail))
})
