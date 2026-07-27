import { assertEquals } from 'jsr:@std/assert'
import { applyResourcesToComposeService } from '../compose/apply-service-options.ts'
import {
  ManagedSecretPlaceholder,
  type ManagedSettings,
} from './index.ts'
import { postgresEngineSpec } from './postgres.ts'
import type { PostgresManagedSettings } from './postgres.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function defaultSettings(
  overrides: Partial<PostgresManagedSettings> = {},
): PostgresManagedSettings {
  const parsed = postgresEngineSpec.parseSettings({
    initialDatabase: 'appdb',
    ...overrides,
  })
  if (!parsed) throw new TypeError('expected postgres settings')
  return parsed as PostgresManagedSettings
}

test('default image is docker.io/library/postgres:18-alpine', () => {
  assertEquals(
    postgresEngineSpec.defaultImage,
    'docker.io/library/postgres:18-alpine',
  )
  const spec = postgresEngineSpec.buildRuntimeSpec({
    managedId: '11111111-1111-1111-1111-111111111111',
    settings: defaultSettings(),
    rootUsername: 'postgres',
  })
  assertEquals(spec.service.image, 'docker.io/library/postgres:18-alpine')
})

test('runtime spec has no ports key and container port stays 5432', () => {
  const spec = postgresEngineSpec.buildRuntimeSpec({
    managedId: '11111111-1111-1111-1111-111111111111',
    settings: defaultSettings({
      exposure: { enabled: true, publishedPort: 15432 },
    }),
    rootUsername: 'postgres',
  })
  assertEquals('ports' in spec.service, false)
  assertEquals(spec.exposure.containerPort, 5432)
  assertEquals(spec.exposure.publishedPort, 15432)
})

test('volume target is /var/lib/postgresql parent', () => {
  const spec = postgresEngineSpec.buildRuntimeSpec({
    managedId: '11111111-1111-1111-1111-111111111111',
    settings: defaultSettings(),
    rootUsername: 'postgres',
  })
  assertEquals(spec.volumes.length, 1)
  assertEquals(spec.volumes[0]?.target, '/var/lib/postgresql')
  assertEquals(
    spec.volumes[0]?.name,
    'managed_11111111_1111_1111_1111_111111111111_data',
  )
})

test('volume name is hyphen-free for SAFE_IDENTIFIER_RE', () => {
  const managedId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const spec = postgresEngineSpec.buildRuntimeSpec({
    managedId,
    settings: defaultSettings(),
    rootUsername: 'postgres',
  })
  const name = spec.volumes[0]?.name ?? ''
  assertEquals(name.includes('-'), false)
  assertEquals(name, 'managed_aaaaaaaa_bbbb_cccc_dddd_eeeeeeeeeeee_data')
})

test('pg_isready healthcheck', () => {
  const spec = postgresEngineSpec.buildRuntimeSpec({
    managedId: '11111111-1111-1111-1111-111111111111',
    settings: defaultSettings({ initialDatabase: 'appdb' }),
    rootUsername: 'postgres',
  })
  assertEquals(spec.healthcheck.test, [
    'CMD-SHELL',
    'pg_isready -U postgres -d appdb',
  ])
})

test('POSTGRES_PASSWORD is placeholder and serialized spec has no plaintext', () => {
  const plaintext = 'super-secret-password-never-in-spec'
  const settings = defaultSettings()
  const spec = postgresEngineSpec.buildRuntimeSpec({
    managedId: '11111111-1111-1111-1111-111111111111',
    settings,
    rootUsername: 'postgres',
  })
  assertEquals(spec.env.POSTGRES_PASSWORD, ManagedSecretPlaceholder)
  const serialized = JSON.stringify(spec)
  assertEquals(serialized.includes(plaintext), false)
  assertEquals(serialized.includes(ManagedSecretPlaceholder), true)
  assertEquals(
    (spec.service.environment as Record<string, string>).POSTGRES_PASSWORD,
    ManagedSecretPlaceholder,
  )
})

test('postgresql.conf is base plus appended operator snippet', () => {
  const settings = defaultSettings({
    engineConfig: 'log_min_duration_statement = 250\n',
  })
  const spec = postgresEngineSpec.buildRuntimeSpec({
    managedId: '11111111-1111-1111-1111-111111111111',
    settings,
    rootUsername: 'postgres',
  })
  const conf = spec.configFiles.find((f) => f.path === 'postgresql.conf')
  if (!conf) throw new TypeError('missing postgresql.conf')
  assertEquals(conf.mode, '0640')
  assertEquals(conf.contents.includes("listen_addresses = '*'"), true)
  assertEquals(conf.contents.includes('port = 5432'), true)
  assertEquals(conf.contents.includes('# --- operator config ---'), true)
  assertEquals(
    conf.contents.includes('log_min_duration_statement = 250'),
    true,
  )
  assertEquals(conf.contents.includes('ssl = on'), false)
})

test('ssl = on and tlsMaterial only when enabled', () => {
  const off = postgresEngineSpec.buildRuntimeSpec({
    managedId: '11111111-1111-1111-1111-111111111111',
    settings: defaultSettings({ ssl: { enabled: false } }),
    rootUsername: 'postgres',
  })
  assertEquals(off.tlsMaterial, undefined)

  const on = postgresEngineSpec.buildRuntimeSpec({
    managedId: '11111111-1111-1111-1111-111111111111',
    settings: defaultSettings({ ssl: { enabled: true } }),
    rootUsername: 'postgres',
  })
  const conf = on.configFiles.find((f) => f.path === 'postgresql.conf')
  if (!conf) throw new TypeError('missing postgresql.conf')
  assertEquals(conf.contents.includes('ssl = on'), true)
  assertEquals(on.tlsMaterial?.selfSigned, true)
  assertEquals(on.tlsMaterial?.certPath, 'tls/server.crt')
  assertEquals(on.tlsMaterial?.keyPath, 'tls/server.key')
})

test('resource mapping matches applyResourcesToComposeService', () => {
  const resources = {
    cpus: 1.5,
    memoryBytes: 512 * 1024 * 1024,
    memoryReservationBytes: 256 * 1024 * 1024,
  }
  const settings = defaultSettings({ resources })
  const spec = postgresEngineSpec.buildRuntimeSpec({
    managedId: '11111111-1111-1111-1111-111111111111',
    settings,
    rootUsername: 'postgres',
  })

  const expected: Record<string, unknown> = {}
  applyResourcesToComposeService(expected, resources)
  assertEquals(spec.service.cpus, expected.cpus)
  assertEquals(spec.service.mem_limit, expected.mem_limit)
  assertEquals(spec.service.mem_reservation, expected.mem_reservation)
  assertEquals(spec.service.deploy, expected.deploy)
})

test('buildConnectionInfo masks the password', () => {
  const settings = defaultSettings({ ssl: { enabled: true } }) as ManagedSettings
  const info = postgresEngineSpec.buildConnectionInfo({
    host: 'db.example',
    port: 5432,
    database: 'appdb',
    username: 'postgres',
    settings,
  })
  assertEquals(info.dsn.includes('***'), true)
  assertEquals(info.dsn.includes('sslmode=require'), true)
  assertEquals(info.dsn.includes('super-secret'), false)
  assertEquals(info.host, 'db.example')
  assertEquals(info.port, 5432)
  assertEquals(info.database, 'appdb')
  assertEquals(info.username, 'postgres')
})

test('backup descriptor advertises database scope only', () => {
  const backup = postgresEngineSpec.backup
  if (!backup) throw new TypeError('expected postgres backup descriptor')
  assertEquals(backup.artifactExtension, 'dump')
  assertEquals(backup.supportsDatabaseScope, true)
  assertEquals(backup.supportsInstanceScope, false)
  assertEquals(backup.executor, {
    kind: 'docker-exec',
    dumpClient: 'pg_dump',
    restoreClient: 'pg_restore',
  })
  assertEquals(backup.defaultRetentionKeep, 7)
  assertEquals(backup.maxRetentionKeep, 50)
})

test('parseSettings rejects include directives in engineConfig', () => {
  assertEquals(
    postgresEngineSpec.parseSettings({
      engineConfig: "include = '/etc/passwd'\n",
    }),
    null,
  )
  assertEquals(
    postgresEngineSpec.parseSettings({
      engineConfig: 'include_dir = conf.d\n',
    }),
    null,
  )
})

test('parseSettings rejects engineConfig overriding platform-owned port/network keys', () => {
  assertEquals(
    postgresEngineSpec.parseSettings({ engineConfig: 'port = 5555\n' }),
    null,
  )
  assertEquals(
    postgresEngineSpec.parseSettings({
      engineConfig: "listen_addresses = '127.0.0.1'\n",
    }),
    null,
  )
  // Case-insensitive: Postgres itself treats parameter names case-insensitively.
  assertEquals(
    postgresEngineSpec.parseSettings({ engineConfig: 'PORT = 5555\n' }),
    null,
  )
})

test('parseSettings rejects engineConfig overriding platform-owned TLS keys', () => {
  assertEquals(
    postgresEngineSpec.parseSettings({ engineConfig: 'ssl = off\n' }),
    null,
  )
  assertEquals(
    postgresEngineSpec.parseSettings({
      engineConfig: "ssl_cert_file = '/tmp/evil.crt'\n",
    }),
    null,
  )
  assertEquals(
    postgresEngineSpec.parseSettings({
      engineConfig: "ssl_key_file = '/tmp/evil.key'\n",
    }),
    null,
  )
})

test('parseSettings rejects engineConfig overriding platform-owned path/control keys', () => {
  assertEquals(
    postgresEngineSpec.parseSettings({
      engineConfig: "data_directory = '/tmp/evil'\n",
    }),
    null,
  )
  assertEquals(
    postgresEngineSpec.parseSettings({
      engineConfig: "hba_file = '/tmp/evil_hba.conf'\n",
    }),
    null,
  )
  assertEquals(
    postgresEngineSpec.parseSettings({
      engineConfig: "unix_socket_directories = '/tmp'\n",
    }),
    null,
  )
})

test('parseSettings still accepts harmless operator settings and they survive to the rendered conf', () => {
  const settings = postgresEngineSpec.parseSettings({
    engineConfig:
      "log_min_duration_statement = 250\nmax_connections = 200\nwork_mem = '8MB'\n",
  }) as PostgresManagedSettings | null
  if (!settings) throw new TypeError('expected postgres settings')

  const spec = postgresEngineSpec.buildRuntimeSpec({
    managedId: '11111111-1111-1111-1111-111111111111',
    settings,
    rootUsername: 'postgres',
  })
  const conf = spec.configFiles.find((f) => f.path === 'postgresql.conf')
  if (!conf) throw new TypeError('missing postgresql.conf')
  assertEquals(
    conf.contents.includes('log_min_duration_statement = 250'),
    true,
  )
  assertEquals(conf.contents.includes('max_connections = 200'), true)
  assertEquals(conf.contents.includes("work_mem = '8MB'"), true)
  // Platform invariants still win — appended operator block cannot shadow them.
  assertEquals(conf.contents.includes("listen_addresses = '*'"), true)
  assertEquals(conf.contents.includes('port = 5432'), true)
})
