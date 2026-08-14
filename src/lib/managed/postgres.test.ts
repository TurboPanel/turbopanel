import { assertEquals } from 'jsr:@std/assert'
import { applyResourcesToComposeService } from '../compose/apply-service-options.ts'
import {
  ManagedSecretPlaceholder,
  type ManagedSettings,
} from './index.ts'
import { postgresEngineSpec } from './postgres.ts'
import type { PostgresManagedSettings } from './postgres.ts'
import { POSTGRES_ALLOWED_IMAGES } from './settings.ts'

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
  assertEquals(
    POSTGRES_ALLOWED_IMAGES.includes(postgresEngineSpec.defaultImage),
    true,
  )
  const spec = postgresEngineSpec.buildRuntimeSpec({
    managedId: '11111111-1111-1111-1111-111111111111',
    settings: defaultSettings(),
    rootUsername: 'postgres',
  })
  assertEquals(spec.service.image, 'docker.io/library/postgres:18-alpine')
})

test('parseSettings accepts every approved image and rejects everything else', () => {
  for (const image of POSTGRES_ALLOWED_IMAGES) {
    const parsed = postgresEngineSpec.parseSettings({ image })
    if (!parsed) throw new TypeError(`expected ${image} to be accepted`)
    assertEquals(parsed.image, image)
  }
  assertEquals(
    postgresEngineSpec.parseSettings({ image: 'docker.io/library/postgres:17' }),
    null,
  )
  assertEquals(
    postgresEngineSpec.parseSettings({ image: 'docker.io/library/postgres:latest' }),
    null,
  )
  assertEquals(
    postgresEngineSpec.parseSettings({ image: 'docker.io/library/mysql:9.7' }),
    null,
  )
})

test('runtime spec has no ports key and container port stays 5432', () => {
  const spec = postgresEngineSpec.buildRuntimeSpec({
    managedId: '11111111-1111-1111-1111-111111111111',
    settings: defaultSettings({
      exposure: { enabled: true, bind: 'public' },
    }),
    rootUsername: 'postgres',
  })
  assertEquals('ports' in spec.service, false)
  assertEquals(spec.exposure.containerPort, 5432)
  assertEquals(spec.exposure.enabled, true)
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
    ssl: { enabled: false },
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

test('postgres defaultSettings inherit ssl.enabled=true', () => {
  const defaults = postgresEngineSpec.defaultSettings
  assertEquals(defaults.ssl.enabled, true)
  const settings = defaultSettings()
  assertEquals(settings.ssl.enabled, true)
  const info = postgresEngineSpec.buildConnectionInfo({
    host: 'db.example',
    port: 5432,
    database: 'appdb',
    username: 'postgres',
    settings: settings as ManagedSettings,
  })
  assertEquals(info.dsn.includes('sslmode=verify-full'), true)
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
  assertEquals(info.dsn.includes('sslmode=verify-full'), true)
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
  assertEquals(
    postgresEngineSpec.parseSettings({
      engineConfig: "include_if_exists = 'extra.conf'\n",
    }),
    null,
  )
})

test('parseSettings rejects ssl_ca_file overrides in engineConfig', () => {
  assertEquals(
    postgresEngineSpec.parseSettings({
      engineConfig: "ssl_ca_file = '/tmp/evil-ca.crt'\n",
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

test('parseSettings rejects invalid initialDatabase and non-object input', () => {
  assertEquals(postgresEngineSpec.parseSettings([]), null)
  assertEquals(postgresEngineSpec.parseSettings('postgres'), null)
  assertEquals(
    postgresEngineSpec.parseSettings({ initialDatabase: '' }),
    null,
  )
  assertEquals(
    postgresEngineSpec.parseSettings({ initialDatabase: 'bad-name' }),
    null,
  )
  assertEquals(
    postgresEngineSpec.parseSettings({ initialDatabase: 12 }),
    null,
  )
  assertEquals(
    postgresEngineSpec.parseSettings({ initialDatabase: 'a'.repeat(64) }),
    null,
  )
})

test('parseSettings defaults initialDatabase and rejects blank conf lines that are not settings', () => {
  const defaults = postgresEngineSpec.parseSettings({}) as PostgresManagedSettings | null
  if (!defaults) throw new TypeError('expected defaults')
  assertEquals(defaults.initialDatabase, 'postgres')

  assertEquals(
    postgresEngineSpec.parseSettings({
      engineConfig: 'not a setting line\n',
    }),
    null,
  )
})

test('parseSettings accepts comment-only engineConfig', () => {
  const settings = postgresEngineSpec.parseSettings({
    engineConfig: '# tuning notes\n\n',
  })
  if (!settings) throw new TypeError('expected settings')
  assertEquals((settings as PostgresManagedSettings).engineConfig, '# tuning notes\n\n')
})

test('buildPlatformPgHba grants replication for co-resident peers and /128 for IPv6', () => {
  const settings = defaultSettings({ ssl: { enabled: true } })
  const spec = postgresEngineSpec.buildRuntimeSpec({
    managedId: '11111111-1111-1111-1111-111111111111',
    settings,
    rootUsername: 'postgres',
    useOrgTls: true,
    member: {
      role: 'primary',
      ordinal: 1,
      privateListener: { address: '203.0.113.10', port: 15432 },
      replication: {
        username: 'tp_repl',
        peerAddresses: [
          'tp-managed-engine-1',
          '203.0.113.20',
          '2001:db8::10',
        ],
      },
    },
  })
  const hba = spec.configFiles.find((f) => f.path === 'pg_hba.conf')?.contents ?? ''
  assertEquals(hba.includes('pg_hba.conf'), false) // path not contents
  assertEquals(
    hba.includes(
      'hostssl replication     tp_repl        172.16.0.0/12       scram-sha-256',
    ),
    true,
  )
  assertEquals(
    hba.includes(
      'hostssl replication     tp_repl        203.0.113.20/32                 scram-sha-256',
    ),
    true,
  )
  assertEquals(
    hba.includes(
      'hostssl replication     tp_repl        2001:db8::10/128                 scram-sha-256',
    ),
    true,
  )
  // IPv6 must not be written as /32.
  assertEquals(hba.includes('2001:db8::10/32'), false)
})

test('standby primary_conninfo has no passfile (no durable auth plaintext)', () => {
  const settings = defaultSettings({ ssl: { enabled: true } })
  const spec = postgresEngineSpec.buildRuntimeSpec({
    managedId: '11111111-1111-1111-1111-111111111111',
    settings,
    rootUsername: 'postgres',
    useOrgTls: true,
    member: {
      role: 'standby',
      ordinal: 2,
      privateListener: { address: '203.0.113.11', port: 15433 },
      replication: {
        username: 'tp_repl',
        slotName: 'tp_member_2',
        primary: {
          host: 'managed-11111111-1111-1111-1111-111111111111',
          hostaddr: '203.0.113.10',
          port: 15432,
        },
      },
    },
  })
  const conf = spec.configFiles.find((f) => f.path === 'postgresql.conf')?.contents ?? ''
  assertEquals(conf.includes('passfile='), false)
  assertEquals(conf.includes('sslmode=verify-full'), true)
  assertEquals(conf.includes('host=managed-11111111-1111-1111-1111-111111111111'), true)
  assertEquals(conf.includes('hostaddr=203.0.113.10'), true)
  // No durable auth/ volume mount for standby.
  const volumes = spec.service.volumes as string[]
  assertEquals(volumes.some((v) => v.includes('./auth')), false)
})

test('buildRuntimeSpec applies dockerOptions onto compose service and env', () => {
  const settings = defaultSettings({
    dockerOptions: {
      restart: 'always',
      stopGracePeriodSeconds: 30,
      shmSizeBytes: 64 * 1024 * 1024,
      ulimits: { nofile: { soft: 1024, hard: 2048 } },
      labels: { 'app.tier': 'db' },
      extraEnv: { MY_FLAG: '1' },
    },
    exposure: { enabled: true, bind: 'local' },
    resources: { memoryBytes: 256 * 1024 * 1024 },
  })
  const spec = postgresEngineSpec.buildRuntimeSpec({
    managedId: '11111111-1111-1111-1111-111111111111',
    settings,
    rootUsername: 'postgres',
  })
  assertEquals(spec.service.restart, 'always')
  assertEquals(spec.service.stop_grace_period, '30s')
  assertEquals(spec.service.shm_size, 64 * 1024 * 1024)
  assertEquals(spec.service.ulimits, {
    nofile: { soft: 1024, hard: 2048 },
  })
  assertEquals(spec.service.labels, { 'app.tier': 'db' })
  assertEquals(
    (spec.service.environment as Record<string, string>).MY_FLAG,
    '1',
  )
  assertEquals(spec.env.MY_FLAG, '1')
  assertEquals(spec.exposure.bind, 'local')
  assertEquals(
    spec.configFiles[0]?.contents.includes("shared_buffers = '"),
    true,
  )
})

test(
  'buildRuntimeSpec pins the container bootstrap superuser to "postgres" even when the ' +
    'user-facing root principal is a suffixed username',
  () => {
    // Regression coverage for the case where `resolveAvailableManagedRootUsername`
    // (instance `src/client/principals/store.ts`) suffixed the preferred "postgres"
    // login to avoid a collision with another managed Postgres cluster sharing the
    // same server-owning organization's ProxySQL namespace. `input.rootUsername` here
    // stands in for that resolved, possibly-suffixed frontend principal — the
    // container's actual bootstrap superuser (`POSTGRES_USER`), `pg_hba.conf` local
    // trust rule, and healthcheck user must all stay pinned to the stable platform
    // admin ("postgres") regardless, because every daemon admin path
    // (`waitReady`/`psql`/`pg_dump`/`pg_restore`/promote/replication health — see
    // `turbopaneld/src/managed/apply.ts`, `backup.ts`, `promote.ts`, `containers.ts`)
    // connects as the engine spec's static `rootUsername`, never this payload value.
    const settings = defaultSettings({ initialDatabase: 'appdb' })
    const spec = postgresEngineSpec.buildRuntimeSpec({
      managedId: '22222222-2222-2222-2222-222222222222',
      settings,
      rootUsername: 'postgres_a1b2c3d4',
    })

    assertEquals(
      (spec.service.environment as Record<string, string>).POSTGRES_USER,
      'postgres',
    )
    assertEquals(spec.healthcheck.test, [
      'CMD-SHELL',
      'pg_isready -U postgres -d appdb',
    ])
    const hba = spec.configFiles.find((f) => f.path === 'pg_hba.conf')?.contents ?? ''
    assertEquals(hba.includes('postgres_a1b2c3d4'), false)
    assertEquals(hba.includes('local   all             postgres'), true)
  },
)

test('buildConnectionInfo uses sslmode=prefer when ssl disabled', () => {
  const settings = defaultSettings({ ssl: { enabled: false } }) as ManagedSettings
  const info = postgresEngineSpec.buildConnectionInfo({
    host: 'db.example',
    port: 5432,
    database: 'appdb',
    username: 'app_user',
    settings,
  })
  assertEquals(info.dsn.includes('sslmode=prefer'), true)
  assertEquals(info.dsn.includes(encodeURIComponent('app_user')), true)
})
