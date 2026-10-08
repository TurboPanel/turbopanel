import { assertEquals } from '@std/assert'
import { parseServerOptions } from '../servers/server-metadata.ts'
import { parseManagedExternalAccess, readManagedExternalAccess } from './external-access.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('external access reads as no unless the server says yes', () => {
  assertEquals(parseManagedExternalAccess(undefined), { enabled: false })
  assertEquals(parseManagedExternalAccess(null), { enabled: false })
  assertEquals(parseManagedExternalAccess('yes'), { enabled: false })
  assertEquals(parseManagedExternalAccess([true]), { enabled: false })
  assertEquals(parseManagedExternalAccess({}), { enabled: false })
  assertEquals(parseManagedExternalAccess({ enabled: 'true' }), { enabled: false })
  assertEquals(parseManagedExternalAccess({ enabled: true }), { enabled: true })
})

test('external access keeps a valid pendingSince and drops a malformed one', () => {
  const since = '2026-10-08T10:00:00.000Z'
  assertEquals(parseManagedExternalAccess({ enabled: false, pendingSince: since }), {
    enabled: false,
    pendingSince: since,
  })
  assertEquals(parseManagedExternalAccess({ enabled: true, pendingSince: 'not a date' }), {
    enabled: true,
  })
  assertEquals(parseManagedExternalAccess({ enabled: true, pendingSince: 5 }), { enabled: true })
})

test('external access is read from server.options and defaults to no', () => {
  assertEquals(readManagedExternalAccess(null), { enabled: false })
  assertEquals(readManagedExternalAccess({ sshPort: 22 }), { enabled: false })
  assertEquals(readManagedExternalAccess({ managedExternalAccess: { enabled: true } }), {
    enabled: true,
  })
})

test('parseServerOptions keeps the external access setting so a server save does not lose it', () => {
  assertEquals(
    parseServerOptions({ managedExternalAccess: { enabled: true } })?.managedExternalAccess,
    { enabled: true }
  )
  assertEquals(parseServerOptions({ sshPort: 22 })?.managedExternalAccess, undefined)
})
