import { assertEquals, assertThrows } from '@std/assert'
import { createMailerDb } from './db.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function withDatabaseUrl(url: string | undefined, fn: () => void): void {
  const previous = Deno.env.get('TURBOPANEL_DATABASE_URL')
  try {
    if (url === undefined) Deno.env.delete('TURBOPANEL_DATABASE_URL')
    else Deno.env.set('TURBOPANEL_DATABASE_URL', url)
    fn()
  } finally {
    if (previous === undefined) Deno.env.delete('TURBOPANEL_DATABASE_URL')
    else Deno.env.set('TURBOPANEL_DATABASE_URL', previous)
  }
}

test('createMailerDb returns undefined when TURBOPANEL_DATABASE_URL is unset', () => {
  withDatabaseUrl(undefined, () => {
    assertEquals(createMailerDb(), undefined)
  })
})

test('createMailerDb returns undefined when TURBOPANEL_DATABASE_URL is blank', () => {
  withDatabaseUrl('   ', () => {
    assertEquals(createMailerDb(), undefined)
  })
})

test('createMailerDb builds a drizzle client from a TCP URL without querying', () => {
  withDatabaseUrl('postgresql://turbopanel:x@203.0.113.10:5432/turbopanel', () => {
    const db = createMailerDb()
    if (db === undefined) throw new TypeError('expected a mailer db client')
    assertEquals(typeof db.select, 'function')
  })
})

test('createMailerDb builds a drizzle client from a Unix-socket URL', () => {
  withDatabaseUrl(
    'postgresql://turbopanel:x@/turbopanel?host=/run/turbopanel/postgres',
    () => {
      const db = createMailerDb()
      if (db === undefined) throw new TypeError('expected a mailer db client')
      assertEquals(typeof db.select, 'function')
    },
  )
})

test('createMailerDb throws when TURBOPANEL_DATABASE_URL is invalid', () => {
  withDatabaseUrl('not-a-postgres-url', () => {
    assertThrows(() => createMailerDb(), Error, 'invalid TURBOPANEL_DATABASE_URL')
  })
})
