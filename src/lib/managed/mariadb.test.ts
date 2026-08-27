import { assertEquals } from '@std/assert'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'
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

test('binding DSN matches MySQL-family scheme and encodes the fixture password', () => {
  const binding = mariadbEngineSpec.binding
  if (!binding) throw new TypeError('expected mariadb binding descriptor')
  assertEquals(binding.scheme, 'mysql')
  const dsn = binding.buildBindingDsn({
    host: '203.0.113.42',
    port: 13306,
    database: 'appdb',
    username: 'app_user',
    password: TEST_ONLY_TURBOPANEL_SECRET,
    sslMode: 'prefer',
  })
  assertEquals(dsn.includes(encodeURIComponent(TEST_ONLY_TURBOPANEL_SECRET)), true)
  assertEquals(dsn.includes('ssl-mode=PREFERRED'), true)
  assertEquals(dsn.includes('***'), false)
})

test('useOrgTls omits self-signed tlsMaterial', () => {
  const withOrg = mariadbEngineSpec.buildRuntimeSpec({
    managedId: '11111111-1111-1111-1111-111111111111',
    settings: defaultSettings(),
    rootUsername: 'root',
    useOrgTls: true,
  })
  assertEquals(withOrg.tlsMaterial, undefined)
})

test('buildRuntimeSpec applies dockerOptions and exposure scope', () => {
  const settings = defaultSettings({
    dockerOptions: {
      restart: 'unless-stopped',
      stopGracePeriodSeconds: 20,
      shmSizeBytes: 16 * 1024 * 1024,
      ulimits: { nofile: { soft: 256, hard: 512 } },
      labels: { 'app.tier': 'mariadb' },
      extraEnv: { MY_FLAG: '1' },
    },
    exposure: { enabled: true, scope: 'turbofabric' },
    resources: { memoryBytes: 512 * 1024 * 1024 },
  })
  const spec = mariadbEngineSpec.buildRuntimeSpec({
    managedId: '11111111-1111-1111-1111-111111111111',
    settings,
    rootUsername: 'root',
  })
  assertEquals(spec.service.stop_grace_period, '20s')
  assertEquals(spec.service.shm_size, 16 * 1024 * 1024)
  assertEquals(spec.service.ulimits, {
    nofile: { soft: 256, hard: 512 },
  })
  assertEquals(spec.service.labels, { 'app.tier': 'mariadb' })
  assertEquals(spec.env.MY_FLAG, '1')
  assertEquals(spec.exposure.scope, 'turbofabric')
  const conf = spec.configFiles.find((f) => f.path === 'my.cnf')?.contents ?? ''
  assertEquals(conf.includes('innodb_buffer_pool_size='), true)
})

test('parseSettings rejects non-objects, includes, and reserved MariaDB GTID keys', () => {
  assertEquals(mariadbEngineSpec.parseSettings([]), null)
  assertEquals(mariadbEngineSpec.parseSettings('mariadb'), null)
  assertEquals(
    mariadbEngineSpec.parseSettings({ engineConfig: '!include /tmp/x.cnf\n' }),
    null,
  )
  assertEquals(
    mariadbEngineSpec.parseSettings({
      engineConfig: 'gtid_strict_mode = OFF\n',
    }),
    null,
  )
  assertEquals(
    mariadbEngineSpec.parseSettings({ initialDatabase: 'sys' }),
    null,
  )
  assertEquals(
    mariadbEngineSpec.parseSettings({ initialDatabase: 12 }),
    null,
  )
  assertEquals(
    mariadbEngineSpec.parseSettings({ initialDatabase: 'bad-name' }),
    null,
  )
  const fromNull = mariadbEngineSpec.parseSettings(null)
  if (!fromNull) throw new TypeError('expected defaults for null settings')
  assertEquals((fromNull as MariadbManagedSettings).initialDatabase, 'appdb')
  const fromUndefined = mariadbEngineSpec.parseSettings(undefined)
  if (!fromUndefined) {
    throw new TypeError('expected defaults for undefined settings')
  }
  assertEquals(
    (fromUndefined as MariadbManagedSettings).initialDatabase,
    'appdb',
  )
})

test('buildRuntimeSpec falls back when settings omit image and initialDatabase', () => {
  const settings = {
    ssl: {},
    exposure: { enabled: false },
  } as MariadbManagedSettings
  const spec = mariadbEngineSpec.buildRuntimeSpec({
    managedId: '11111111-1111-1111-1111-111111111111',
    settings,
    rootUsername: 'root',
  })
  assertEquals(spec.service.image, mariadbEngineSpec.defaultImage)
  assertEquals(spec.env.MARIADB_DATABASE, 'appdb')
})

test('socket healthcheck and backup descriptor stay credential-free', () => {
  const spec = mariadbEngineSpec.buildRuntimeSpec({
    managedId: '11111111-1111-1111-1111-111111111111',
    settings: defaultSettings(),
    rootUsername: 'root',
  })
  const cmd = spec.healthcheck.test[1] ?? ''
  assertEquals(cmd.includes('mariadb-admin ping --protocol=socket'), true)
  assertEquals(/\s-p(?:\s|=|$)/.test(cmd), false)
  assertEquals(mariadbEngineSpec.backup?.supportsInstanceScope, false)
  assertEquals(mariadbEngineSpec.backup?.defaultRetentionKeep, 7)
})
