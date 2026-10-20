import { assertEquals, assertThrows } from '@std/assert'
import type { SQL } from 'drizzle-orm'
import { loginDatabaseNames } from './logins.ts'
import { managedDatabaseNames } from './options.ts'
import { readNameList } from './sql-name-list.ts'

const test = Deno.test.bind(Deno)

/** The daemon's rule for every `databases` entry of an apply credential (copied, not imported). */
const DAEMON_IDENTIFIER = /^[A-Za-z_]\w*$/
function daemonAcceptsDatabases(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (name) => typeof name === 'string' && name.length <= 63 && DAEMON_IDENTIFIER.test(name)
    )
  )
}

/** Run a driver value through the decoder drizzle applies to the selected field. */
function decode(field: SQL<string[]>, raw: unknown): unknown {
  const decoder = (field as unknown as { decoder: object }).decoder as {
    mapFromDriverValue?: (v: unknown) => unknown
  }
  return decoder.mapFromDriverValue ? decoder.mapFromDriverValue(raw) : raw
}

test('a login database list read from JSON text is a list the daemon accepts', () => {
  // The Workers client returns the subquery as text; before the fix the
  // raw array literal "{defaultdb}" reached the apply payload as a string.
  const value = decode(loginDatabaseNames, '["defaultdb"]')
  assertEquals(value, ['defaultdb'])
  assertEquals(daemonAcceptsDatabases(value), true)
  assertEquals(daemonAcceptsDatabases('{defaultdb}'), false)
})

test('the cluster database list reads the same way', () => {
  assertEquals(decode(managedDatabaseNames(), '["a","b_2"]'), ['a', 'b_2'])
  assertEquals(decode(managedDatabaseNames(), []), [])
})

test('readNameList handles lists, empty and missing values, and refuses anything else', () => {
  assertEquals(readNameList(['x']), ['x'])
  assertEquals(readNameList('[]'), [])
  assertEquals(readNameList(null), [])
  assertThrows(() => readNameList('{x}'))
  assertThrows(() => readNameList('"x"'))
  assertThrows(() => readNameList([1]))
})
