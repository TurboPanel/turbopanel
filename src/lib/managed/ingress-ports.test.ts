import { assertEquals } from '@std/assert'
import {
  DEFAULT_MANAGED_INGRESS_PORTS,
  isManagedIngressProtocolPort,
  MANAGED_INGRESS_MYSQL_PORT,
  MANAGED_INGRESS_PGSQL_PORT,
  MANAGED_PRIVATE_PORT_MIN,
  managedIngressFamilyForEngine,
  managedIngressPortForEngine,
  rejectManagedIngressPort,
  resolveManagedIngressPorts,
  validateManagedIngressPorts,
} from './ingress-ports.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('platform defaults are the documented high listener ports', () => {
  assertEquals(MANAGED_INGRESS_PGSQL_PORT, 15432)
  assertEquals(MANAGED_INGRESS_MYSQL_PORT, 13306)
  assertEquals(DEFAULT_MANAGED_INGRESS_PORTS, {
    postgres: 15432,
    mysqlFamily: 13306,
  })
})

test('rejectManagedIngressPort refuses privileged, admin, and private-range ports', () => {
  assertEquals(rejectManagedIngressPort(15432), null)
  assertEquals(rejectManagedIngressPort(18306), null)
  assertEquals(rejectManagedIngressPort(1024), null)
  assertEquals(rejectManagedIngressPort(65_535), null)

  assertEquals(rejectManagedIngressPort(1023), 'out_of_range')
  assertEquals(rejectManagedIngressPort(443), 'out_of_range')
  assertEquals(rejectManagedIngressPort(0), 'out_of_range')
  assertEquals(rejectManagedIngressPort(65_536), 'out_of_range')
  assertEquals(rejectManagedIngressPort(15432.5), 'out_of_range')
  assertEquals(rejectManagedIngressPort('15432'), 'out_of_range')
  assertEquals(rejectManagedIngressPort(null), 'out_of_range')
  assertEquals(rejectManagedIngressPort(undefined), 'out_of_range')

  assertEquals(rejectManagedIngressPort(6032), 'reserved_admin')
  assertEquals(rejectManagedIngressPort(6132), 'reserved_admin')

  assertEquals(
    rejectManagedIngressPort(MANAGED_PRIVATE_PORT_MIN),
    'reserved_private_range',
  )
  assertEquals(rejectManagedIngressPort(45_500), 'reserved_private_range')

  assertEquals(isManagedIngressProtocolPort(18432), true)
  assertEquals(isManagedIngressProtocolPort(6032), false)
})

test('legacy engine-native ports are not selectable as client listeners', () => {
  // 5432 / 3306 stay engine-native backend ports; an operator asking for them
  // would collide with a host-run database, which is the exact conflict the high
  // listener ports exist to avoid. They are in range, so they are allowed —
  // the daemon host preflight is what refuses an actual collision.
  assertEquals(rejectManagedIngressPort(5432), null)
  assertEquals(rejectManagedIngressPort(3306), null)
})

test('validateManagedIngressPorts names the offending family', () => {
  assertEquals(
    validateManagedIngressPorts({ postgres: 15432, mysqlFamily: 13306 }),
    { ok: true },
  )
  assertEquals(
    validateManagedIngressPorts({ postgres: 80, mysqlFamily: 13306 }),
    { ok: false, field: 'postgres', reason: 'out_of_range' },
  )
  assertEquals(
    validateManagedIngressPorts({ postgres: 15432, mysqlFamily: 6032 }),
    { ok: false, field: 'mysqlFamily', reason: 'reserved_admin' },
  )
  assertEquals(
    validateManagedIngressPorts({ postgres: 18432, mysqlFamily: 18432 }),
    { ok: false, field: 'mysqlFamily', reason: 'collision' },
  )
})

test('resolveManagedIngressPorts merges over defaults and ignores bad stored values', () => {
  assertEquals(resolveManagedIngressPorts(null), DEFAULT_MANAGED_INGRESS_PORTS)
  assertEquals(
    resolveManagedIngressPorts(undefined),
    DEFAULT_MANAGED_INGRESS_PORTS,
  )
  assertEquals(resolveManagedIngressPorts({}), DEFAULT_MANAGED_INGRESS_PORTS)

  assertEquals(resolveManagedIngressPorts({ postgres: 18432 }), {
    postgres: 18432,
    mysqlFamily: 13306,
  })
  assertEquals(resolveManagedIngressPorts({ mysqlFamily: 18306 }), {
    postgres: 15432,
    mysqlFamily: 18306,
  })
  assertEquals(
    resolveManagedIngressPorts({ postgres: 18432, mysqlFamily: 18306 }),
    { postgres: 18432, mysqlFamily: 18306 },
  )

  // Unreadable jsonb must not make the managed surface unreadable: a bad value
  // falls back to that family's platform default.
  assertEquals(resolveManagedIngressPorts({ postgres: 80 }), {
    postgres: 15432,
    mysqlFamily: 13306,
  })
  assertEquals(
    resolveManagedIngressPorts({ postgres: 6032, mysqlFamily: 18306 }),
    { postgres: 15432, mysqlFamily: 18306 },
  )
})

test('a stored pair that would collide falls back wholesale', () => {
  // Only Postgres is overridden, but onto the *inherited* MySQL default: taking
  // the override would leave both families on 13306.
  assertEquals(
    resolveManagedIngressPorts({ postgres: 13306 }),
    DEFAULT_MANAGED_INGRESS_PORTS,
  )
  assertEquals(
    resolveManagedIngressPorts({ mysqlFamily: 15432 }),
    DEFAULT_MANAGED_INGRESS_PORTS,
  )
  assertEquals(
    resolveManagedIngressPorts({ postgres: 18432, mysqlFamily: 18432 }),
    DEFAULT_MANAGED_INGRESS_PORTS,
  )
})

test('family follows the engine, never the port number', () => {
  assertEquals(managedIngressFamilyForEngine('postgres', 5432), 'pgsql')
  assertEquals(managedIngressFamilyForEngine('mysql', 3306), 'mysql')
  assertEquals(managedIngressFamilyForEngine('mariadb', 3306), 'mysql')
  // Version skew: an engine code this control plane predates falls back to the
  // engine-native backend port.
  assertEquals(managedIngressFamilyForEngine('percona', 3306), 'mysql')
  assertEquals(managedIngressFamilyForEngine('cockroach', 5432), 'pgsql')
})

test('managedIngressPortForEngine maps engines onto configured listeners', () => {
  assertEquals(managedIngressPortForEngine('postgres', 5432), 15432)
  assertEquals(managedIngressPortForEngine('mysql', 3306), 13306)
  assertEquals(managedIngressPortForEngine('mariadb', 3306), 13306)

  const ports = { postgres: 18432, mysqlFamily: 18306 }
  assertEquals(managedIngressPortForEngine('postgres', 5432, ports), 18432)
  assertEquals(managedIngressPortForEngine('mysql', 3306, ports), 18306)
  assertEquals(managedIngressPortForEngine('mariadb', 3306, ports), 18306)

  // Swapped ports: MariaDB still resolves to the MySQL-family listener even
  // though that number is the Postgres default.
  const swapped = { postgres: 16306, mysqlFamily: 15432 }
  assertEquals(managedIngressPortForEngine('mariadb', 3306, swapped), 15432)
  assertEquals(managedIngressPortForEngine('postgres', 5432, swapped), 16306)
})
