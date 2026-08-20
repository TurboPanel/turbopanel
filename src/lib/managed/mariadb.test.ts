import { assertEquals } from '@std/assert'
import { ManagedSecretPlaceholder } from './index.ts'
import { mariadbEngineSpec } from './mariadb.ts'
import type { MariadbManagedSettings } from './mariadb.ts'
import { mysqlEngineSpec } from './mysql.ts'
import { MARIADB_ALLOWED_IMAGES } from './settings.ts'
import { MANAGED_SSL_MODES } from './ssl.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function defaultSettings(
  overrides: Partial<MariadbManagedSettings> = {},
): MariadbManagedSettings {
  const parsed = mariadbEngineSpec.parseSettings({
    initialDatabase: 'appdb',
    ...overrides,
  })
  if (!parsed) throw new TypeError('expected mariadb settings')
  return parsed as MariadbManagedSettings
}

test('default image is the approved MariaDB 12.3 LTS reference', () => {
  assertEquals(
    mariadbEngineSpec.defaultImage,
    'docker.io/library/mariadb:12.3',
  )
  assertEquals(
    MARIADB_ALLOWED_IMAGES.includes(mariadbEngineSpec.defaultImage),
    true,
  )
  assertEquals(mariadbEngineSpec.displayName, 'MariaDB')
  assertEquals(mariadbEngineSpec.principalProvider, 'mysql')
})

test('parseSettings accepts every approved image and rejects everything else', () => {
  for (const image of MARIADB_ALLOWED_IMAGES) {
    const parsed = mariadbEngineSpec.parseSettings({ image })
    if (!parsed) throw new TypeError(`expected ${image} to be accepted`)
    assertEquals(parsed.image, image)
  }
  assertEquals(
    mariadbEngineSpec.parseSettings({ image: 'docker.io/library/mariadb:11' }),
    null,
  )
  assertEquals(
    mariadbEngineSpec.parseSettings({
      image: 'docker.io/library/mariadb:latest',
    }),
    null,
  )
  assertEquals(
    mariadbEngineSpec.parseSettings({ image: 'docker.io/library/mysql:9.7' }),
    null,
  )
})

test('no ports for single-member; private listener for multi-member', () => {
  const single = mariadbEngineSpec.buildRuntimeSpec({
    managedId: '11111111-1111-1111-1111-111111111111',
    settings: defaultSettings(),
    rootUsername: 'root',
  })
  assertEquals('ports' in single.service, false)

  const multi = mariadbEngineSpec.buildRuntimeSpec({
    managedId: '11111111-1111-1111-1111-111111111111',
    settings: defaultSettings(),
    rootUsername: 'root',
    member: {
      role: 'primary',
      ordinal: 1,
      privateListener: { address: '203.0.113.10', port: 13306 },
    },
  })
  assertEquals(multi.service.ports, ['203.0.113.10:13306:3306'])
})

test('MARIADB_ROOT_PASSWORD placeholder and my.cnf MariaDB GTID vocabulary', () => {
  const spec = mariadbEngineSpec.buildRuntimeSpec({
    managedId: '11111111-1111-1111-1111-111111111111',
    settings: defaultSettings({ engineConfig: 'max_connections = 100\n' }),
    rootUsername: 'root',
  })
  assertEquals(spec.env.MARIADB_ROOT_PASSWORD, ManagedSecretPlaceholder)
  assertEquals(spec.env.MARIADB_DATABASE, 'appdb')
  const conf = spec.configFiles.find((f) => f.path === 'my.cnf')?.contents ??
    ''
  assertEquals(conf.includes('gtid_strict_mode=ON'), true)
  assertEquals(conf.includes('log_slave_updates=ON'), true)
  assertEquals(conf.includes('gtid_mode'), false)
  assertEquals(conf.includes('max_connections = 100'), true)
})

test('standby sets read_only; initdb uses unix_socket without INSTALL PLUGIN', () => {
  const spec = mariadbEngineSpec.buildRuntimeSpec({
    managedId: '11111111-1111-1111-1111-111111111111',
    settings: defaultSettings(),
    rootUsername: 'root',
    member: { role: 'standby', ordinal: 2 },
  })
  const conf = spec.configFiles.find((f) => f.path === 'my.cnf')?.contents ??
    ''
  assertEquals(conf.includes('read_only=ON'), true)
  const initdb = spec.configFiles.find((f) => f.path === 'initdb/00-turbopanel.sql')
    ?.contents ?? ''
  assertEquals(initdb.includes('unix_socket'), true)
  assertEquals(initdb.includes("ALTER USER 'root'@'localhost' IDENTIFIED VIA unix_socket"), true)
  assertEquals(initdb.includes('INSTALL PLUGIN'), false)
})

test('engine TLS material is unconditional and the DSN is masked', () => {
  const spec = mariadbEngineSpec.buildRuntimeSpec({
    managedId: '11111111-1111-1111-1111-111111111111',
    settings: defaultSettings(),
    rootUsername: 'root',
  })
  assertEquals(spec.tlsMaterial?.commonName, 'managed-mariadb')
  const info = mariadbEngineSpec.buildConnectionInfo({
    host: 'db.example',
    port: 3306,
    database: 'appdb',
    username: 'root',
    sslMode: 'verify-full',
  })
  assertEquals(info.dsn.includes('***'), true)
  assertEquals(info.dsn.includes('ssl-mode=VERIFY_IDENTITY'), true)
})

test('mariadb formatSslMode matches the MySQL family spellings', () => {
  assertEquals(
    MANAGED_SSL_MODES.map((mode) => mariadbEngineSpec.formatSslMode(mode)),
    MANAGED_SSL_MODES.map((mode) => mysqlEngineSpec.formatSslMode(mode)),
  )
  assertEquals(mariadbEngineSpec.defaultSettings.ssl.mode, undefined)
})

test('backup uses mariadb-dump / mariadb clients', () => {
  const backup = mariadbEngineSpec.backup
  if (!backup) throw new TypeError('expected backup')
  assertEquals(backup.executor.dumpClient, 'mariadb-dump')
  assertEquals(backup.executor.restoreClient, 'mariadb')
  assertEquals(mariadbEngineSpec.userOperations.executor.client, 'mariadb')
})

test('parseSettings rejects reserved keys and MYSQL_/MARIADB_ extraEnv', () => {
  assertEquals(
    mariadbEngineSpec.parseSettings({ engineConfig: 'server_id = 99\n' }),
    null,
  )
  assertEquals(
    mariadbEngineSpec.parseSettings({
      dockerOptions: { extraEnv: { MARIADB_ROOT_PASSWORD: 'x' } },
    }),
    null,
  )
  assertEquals(
    mariadbEngineSpec.parseSettings({
      dockerOptions: { extraEnv: { MYSQL_ROOT_PASSWORD: 'x' } },
    }),
    null,
  )
})

test('parseSettings defaults initialDatabase to appdb and rejects system schemas', () => {
  const defaults = mariadbEngineSpec.parseSettings(
    {},
  ) as MariadbManagedSettings
  assertEquals(defaults.initialDatabase, 'appdb')
  assertEquals(
    mariadbEngineSpec.parseSettings({ initialDatabase: 'mysql' }),
    null,
  )
})
