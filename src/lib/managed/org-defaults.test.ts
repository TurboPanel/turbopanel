import { assertEquals } from '@std/assert'
import {
  parseManagedIngressPortsInput,
  parseManagedOrganizationDefaults,
  parseManagedSslModeInput,
  validateManagedOrganizationDefaults,
} from './org-defaults.ts'
import { DEFAULT_MANAGED_INGRESS_PORTS } from './ingress-ports.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parseManagedOrganizationDefaults keeps valid port overrides and drops bad ones', () => {
  assertEquals(
    parseManagedOrganizationDefaults({
      sslMode: 'prefer',
      ports: { postgres: 18432, mysqlFamily: 18306 },
    }),
    {
      sslMode: 'prefer',
      ports: { postgres: 18432, mysqlFamily: 18306 },
    },
  )
  // Privileged / admin / private-range ports are dropped on the read path.
  assertEquals(
    parseManagedOrganizationDefaults({
      ports: { postgres: 80, mysqlFamily: 6032 },
    }),
    {},
  )
  assertEquals(
    parseManagedOrganizationDefaults({
      ports: { postgres: 45_000, mysqlFamily: '13306' },
    }),
    {},
  )
  // One valid family still survives when the other is malformed.
  assertEquals(
    parseManagedOrganizationDefaults({
      ports: { postgres: 18432, mysqlFamily: 22 },
    }),
    { ports: { postgres: 18432 } },
  )
  assertEquals(parseManagedOrganizationDefaults({ ports: null }), {})
  assertEquals(parseManagedOrganizationDefaults({ ports: [] }), {})
})

test('parseManagedSslModeInput clears with null and rejects typos', () => {
  assertEquals(parseManagedSslModeInput(null), { ok: true, value: null })
  assertEquals(parseManagedSslModeInput('require'), {
    ok: true,
    value: 'require',
  })
  assertEquals(parseManagedSslModeInput('requrie'), { ok: false })
  assertEquals(parseManagedSslModeInput(12), { ok: false })
})

test('parseManagedIngressPortsInput patches named families and rejects bad ports', () => {
  assertEquals(parseManagedIngressPortsInput(null), { ok: true, value: null })
  assertEquals(parseManagedIngressPortsInput('nope'), { ok: false })
  assertEquals(parseManagedIngressPortsInput({}), { ok: false })
  assertEquals(
    parseManagedIngressPortsInput({ postgres: null, mysqlFamily: 18306 }),
    { ok: true, value: { postgres: null, mysqlFamily: 18306 } },
  )
  assertEquals(
    parseManagedIngressPortsInput({ postgres: 80 }),
    { ok: false, field: 'postgres', reason: 'out_of_range' },
  )
  assertEquals(
    parseManagedIngressPortsInput({ mysqlFamily: 6132 }),
    { ok: false, field: 'mysqlFamily', reason: 'reserved_admin' },
  )
  assertEquals(
    parseManagedIngressPortsInput({ postgres: 45_500 }),
    { ok: false, field: 'postgres', reason: 'reserved_private_range' },
  )
  // Omitted families are left unchanged — only named keys enter the patch.
  assertEquals(
    parseManagedIngressPortsInput({ postgres: 18432 }),
    { ok: true, value: { postgres: 18432 } },
  )
})

test('validateManagedOrganizationDefaults catches cross-family collisions', () => {
  assertEquals(
    validateManagedOrganizationDefaults({}),
    { ok: true },
  )
  assertEquals(
    validateManagedOrganizationDefaults({
      ports: {
        postgres: DEFAULT_MANAGED_INGRESS_PORTS.postgres,
        mysqlFamily: DEFAULT_MANAGED_INGRESS_PORTS.mysqlFamily,
      },
    }),
    { ok: true },
  )
  // One override landing on the other family's platform default collides.
  assertEquals(
    validateManagedOrganizationDefaults({
      ports: { postgres: DEFAULT_MANAGED_INGRESS_PORTS.mysqlFamily },
    }),
    { ok: false, field: 'ports.mysqlFamily', reason: 'collision' },
  )
  assertEquals(
    validateManagedOrganizationDefaults({
      ports: { postgres: 18432, mysqlFamily: 18432 },
    }),
    { ok: false, field: 'ports.mysqlFamily', reason: 'collision' },
  )
})
