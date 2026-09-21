import { assertEquals } from '@std/assert'
import {
  clampManagedResources,
  DEFAULT_MANAGED_SETTINGS,
  getManagedAllowedImages,
  getManagedReservedEnvKeys,
  isManagedImageAllowed,
  MANAGED_DOCKER_OPTION_DENYLIST,
  MARIADB_ALLOWED_IMAGES,
  MARIADB_RESERVED_ENV_KEYS,
  MYSQL_ALLOWED_IMAGES,
  MYSQL_RESERVED_ENV_KEYS,
  parseBackupSettings,
  parseManagedDockerOptions,
  parseManagedSettingsBase,
  POSTGRES_ALLOWED_IMAGES,
  POSTGRES_RESERVED_ENV_KEYS,
} from './settings.ts'
import { MANAGED_SSL_MODES } from './ssl.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parseManagedSettingsBase returns defaults for undefined/null', () => {
  // An absent `ssl.mode` inherits (org default → platform `require`); the
  // parser must not stamp a concrete mode, or an org-level change would stop
  // reaching services that never overrode it.
  assertEquals(parseManagedSettingsBase(undefined), {
    ssl: {},
    exposure: { enabled: true },
  })
  assertEquals(parseManagedSettingsBase(null), {
    ssl: {},
    exposure: { enabled: true },
  })
  assertEquals(
    parseManagedSettingsBase(undefined)?.ssl,
    DEFAULT_MANAGED_SETTINGS.ssl,
  )
})

test('ssl.mode round-trips every supported mode and rejects unknown ones', () => {
  for (const mode of MANAGED_SSL_MODES) {
    assertEquals(parseManagedSettingsBase({ ssl: { mode } })?.ssl, { mode })
  }
  assertEquals(parseManagedSettingsBase({ ssl: {} })?.ssl, {})
  // A typo must reject rather than fall back to a weaker mode.
  assertEquals(parseManagedSettingsBase({ ssl: { mode: 'requrie' } }), null)
  assertEquals(parseManagedSettingsBase({ ssl: { mode: true } }), null)
  assertEquals(parseManagedSettingsBase({ ssl: { enabled: true } }), null)
  assertEquals(parseManagedSettingsBase({ ssl: { enabled: false } }), null)
})

test('image ref accept/reject', () => {
  const ok = parseManagedSettingsBase({
    image: 'docker.io/library/postgres:18-alpine',
  })
  assertEquals(ok?.image, 'docker.io/library/postgres:18-alpine')

  assertEquals(
    parseManagedSettingsBase({ image: 'postgres:18' })?.image,
    'postgres:18',
  )
  assertEquals(parseManagedSettingsBase({ image: 'bad image' }), null)
  assertEquals(parseManagedSettingsBase({ image: 'postgres;rm' }), null)
  assertEquals(parseManagedSettingsBase({ image: '' }), null)
  assertEquals(parseManagedSettingsBase({ image: 12 }), null)
})

test('getManagedAllowedImages / isManagedImageAllowed expose the curated allowlists', () => {
  assertEquals(getManagedAllowedImages('postgres'), POSTGRES_ALLOWED_IMAGES)
  assertEquals(getManagedAllowedImages('mysql'), MYSQL_ALLOWED_IMAGES)
  assertEquals(getManagedAllowedImages('mariadb'), MARIADB_ALLOWED_IMAGES)
  // Engines without a curated allowlist yet (redis/clickhouse/unknown) are unrestricted.
  assertEquals(getManagedAllowedImages('redis'), undefined)
  assertEquals(getManagedAllowedImages('unknown'), undefined)

  assertEquals(
    isManagedImageAllowed('postgres', 'docker.io/library/postgres:18-alpine'),
    true,
  )
  // The catalog's default variant of a tested series is allowed.
  assertEquals(
    isManagedImageAllowed('postgres', 'docker.io/library/postgres:18'),
    true,
  )
  // Catalogued but untested (`tested: false`) is refused, same as never-catalogued.
  assertEquals(
    isManagedImageAllowed('postgres', 'docker.io/library/postgres:17'),
    false,
  )
  assertEquals(
    isManagedImageAllowed('postgres', 'docker.io/library/postgres:14'),
    false,
  )
  assertEquals(
    isManagedImageAllowed('mysql', 'docker.io/library/mysql:9.7'),
    true,
  )
  // Catalogued but untested — refused, same as EOL.
  assertEquals(
    isManagedImageAllowed('mysql', 'docker.io/library/mysql:8.4'),
    false,
  )
  // EOL since April 2026 — must never be creatable.
  assertEquals(
    isManagedImageAllowed('mysql', 'docker.io/library/mysql:8.0'),
    false,
  )
  assertEquals(
    isManagedImageAllowed('mysql', 'docker.io/library/mysql:8'),
    false,
  )
  assertEquals(
    isManagedImageAllowed('mariadb', 'docker.io/library/mariadb:12.3'),
    true,
  )
  assertEquals(
    isManagedImageAllowed('mariadb', 'docker.io/library/mariadb:10.11'),
    false,
  )
  assertEquals(
    isManagedImageAllowed('mariadb', 'docker.io/library/mariadb:11'),
    false,
  )
  // Unrestricted engines accept anything syntactically valid.
  assertEquals(
    isManagedImageAllowed('redis', 'docker.io/library/redis:7'),
    true,
  )
})

test('parseManagedSettingsBase enforces the engine allowlist when engine is passed', () => {
  assertEquals(
    parseManagedSettingsBase(
      { image: 'docker.io/library/mysql:9.7' },
      undefined,
      'mysql',
    )?.image,
    'docker.io/library/mysql:9.7',
  )
  // Outside the allowlist -> rejected, even though the OCI syntax is valid.
  assertEquals(
    parseManagedSettingsBase(
      { image: 'docker.io/library/mysql:8' },
      undefined,
      'mysql',
    ),
    null,
  )
  assertEquals(
    parseManagedSettingsBase(
      { image: 'docker.io/library/mariadb:11' },
      undefined,
      'mariadb',
    ),
    null,
  )
  // The tested series' non-default variant is accepted (create-time choice).
  assertEquals(
    parseManagedSettingsBase(
      { image: 'docker.io/library/postgres:18' },
      undefined,
      'postgres',
    )?.image,
    'docker.io/library/postgres:18',
  )
  // A catalogued-but-untested series is refused just like an unknown one.
  assertEquals(
    parseManagedSettingsBase(
      { image: 'docker.io/library/postgres:17-alpine' },
      undefined,
      'postgres',
    ),
    null,
  )
  assertEquals(
    parseManagedSettingsBase(
      { image: 'docker.io/library/postgres:14' },
      undefined,
      'postgres',
    ),
    null,
  )
  // Without an engine argument, the base parser stays syntax-only (callers that
  // already enforce the allowlist, e.g. via the command-payload check, may omit it).
  assertEquals(
    parseManagedSettingsBase({ image: 'docker.io/library/mysql:8' })?.image,
    'docker.io/library/mysql:8',
  )
  // No image at all is always fine (engine default applies later).
  assertEquals(
    parseManagedSettingsBase({}, undefined, 'mysql')?.image,
    undefined,
  )
})

test('engineConfig size cap and control-char reject', () => {
  const ok = parseManagedSettingsBase({
    engineConfig: 'shared_buffers = 128MB\n',
  })
  assertEquals(ok?.engineConfig, 'shared_buffers = 128MB\n')

  assertEquals(
    parseManagedSettingsBase({ engineConfig: 'a\r\nb' })?.engineConfig,
    'a\nb',
  )
  assertEquals(parseManagedSettingsBase({ engineConfig: 'x\0y' }), null)
  assertEquals(parseManagedSettingsBase({ engineConfig: 'x\u0007y' }), null)
  assertEquals(
    parseManagedSettingsBase({ engineConfig: 'a'.repeat(16 * 1024 + 1) }),
    null,
  )
})

test('dockerOptions allowlist accept', () => {
  const parsed = parseManagedSettingsBase({
    dockerOptions: {
      restart: 'unless-stopped',
      stopGracePeriodSeconds: 45,
      shmSizeBytes: 67108864,
      ulimits: { nofile: { soft: 1024, hard: 2048 } },
      labels: { 'app.tier': 'db' },
      extraEnv: { MY_FLAG: '1' },
    },
  })
  assertEquals(parsed?.dockerOptions?.restart, 'unless-stopped')
  assertEquals(parsed?.dockerOptions?.stopGracePeriodSeconds, 45)
  assertEquals(parsed?.dockerOptions?.shmSizeBytes, 67108864)
  assertEquals(parsed?.dockerOptions?.ulimits?.nofile, {
    soft: 1024,
    hard: 2048,
  })
  assertEquals(parsed?.dockerOptions?.labels, { 'app.tier': 'db' })
  assertEquals(parsed?.dockerOptions?.extraEnv, { MY_FLAG: '1' })
})

test('dockerOptions returns null on each denied key', () => {
  for (const key of MANAGED_DOCKER_OPTION_DENYLIST) {
    assertEquals(
      parseManagedSettingsBase({ dockerOptions: { [key]: true } }),
      null,
      `expected null for denied key ${key}`,
    )
  }
  assertEquals(
    parseManagedSettingsBase({ dockerOptions: { privileged: true } }),
    null,
  )
  assertEquals(
    parseManagedSettingsBase({ dockerOptions: { volumes: ['/tmp:/tmp'] } }),
    null,
  )
  assertEquals(
    parseManagedSettingsBase({ dockerOptions: { ports: ['5432:5432'] } }),
    null,
  )
  assertEquals(
    parseManagedSettingsBase({ dockerOptions: { network_mode: 'host' } }),
    null,
  )
  assertEquals(
    parseManagedSettingsBase({ dockerOptions: { pid: 'host' } }),
    null,
  )
  assertEquals(
    parseManagedSettingsBase({ dockerOptions: { user: '0:0' } }),
    null,
  )
  assertEquals(
    parseManagedSettingsBase({ dockerOptions: { cap_add: ['NET_ADMIN'] } }),
    null,
  )
  assertEquals(
    parseManagedSettingsBase({ dockerOptions: { devices: ['/dev/null'] } }),
    null,
  )
  assertEquals(
    parseManagedSettingsBase({ dockerOptions: { unknownKey: 1 } }),
    null,
  )
})

test('exposure accept/reject scope only', () => {
  assertEquals(
    parseManagedSettingsBase({
      exposure: { enabled: true, scope: 'public' },
    })?.exposure,
    { enabled: true, scope: 'public' },
  )
  assertEquals(
    parseManagedSettingsBase({
      exposure: { enabled: true, scope: 'turbofabric' },
    })?.exposure,
    { enabled: true, scope: 'turbofabric' },
  )
  assertEquals(
    parseManagedSettingsBase({
      exposure: { enabled: true },
    })?.exposure,
    { enabled: true },
  )
  assertEquals(
    parseManagedSettingsBase({
      exposure: { enabled: true, scope: 'internet' },
    }),
    null,
  )
  assertEquals(
    parseManagedSettingsBase({
      exposure: { enabled: true, bind: 'public' },
    }),
    null,
  )
  assertEquals(
    parseManagedSettingsBase({
      exposure: { enabled: true, bind: 'internet' },
    }),
    null,
  )
  // Unknown exposure keys (e.g. retired publishedPort) reject the document.
  assertEquals(
    parseManagedSettingsBase({
      exposure: { enabled: true, publishedPort: 22, scope: 'local' },
    }),
    null,
  )
  assertEquals(
    parseManagedSettingsBase({
      exposure: { enabled: false, scope: 'local' },
    })?.exposure,
    { enabled: false, scope: 'local' },
  )
})

test('clampManagedResources clamps against org and server limits', () => {
  const settings = parseManagedSettingsBase({
    resources: { cpus: 8, memoryBytes: 16 * 1024 * 1024 * 1024 },
  })
  if (!settings) throw new TypeError('expected settings')
  const clamped = clampManagedResources(
    settings,
    { maxCpus: 4, maxMemoryBytes: 4 * 1024 * 1024 * 1024 },
    { maxCpus: 2, maxMemoryBytes: 8 * 1024 * 1024 * 1024 },
  )
  assertEquals(clamped.resources?.cpus, 2)
  assertEquals(clamped.resources?.memoryBytes, 4 * 1024 * 1024 * 1024)
})

test('parseBackupSettings: absent -> undefined', () => {
  assertEquals(parseBackupSettings(undefined), undefined)
  // Empty object has no retentionKeep — inherit engine defaults.
  assertEquals(parseBackupSettings({}), undefined)
})

test('parseBackupSettings: retentionKeep accepted within bounds', () => {
  assertEquals(parseBackupSettings({ retentionKeep: 1 }), { retentionKeep: 1 })
  assertEquals(parseBackupSettings({ retentionKeep: 100 }), {
    retentionKeep: 100,
  })
  assertEquals(parseBackupSettings({ retentionKeep: 7.9 }), {
    retentionKeep: 7,
  })
})

test('parseBackupSettings: rejects malformed / out-of-range retentionKeep', () => {
  assertEquals(parseBackupSettings(null), null)
  assertEquals(parseBackupSettings('nope'), null)
  assertEquals(parseBackupSettings({ retentionKeep: 0 }), null)
  assertEquals(parseBackupSettings({ retentionKeep: -1 }), null)
  assertEquals(parseBackupSettings({ retentionKeep: 101 }), null)
  assertEquals(parseBackupSettings({ retentionKeep: 'many' }), null)
})

test('parseManagedSettingsBase wires backups through', () => {
  const parsed = parseManagedSettingsBase({ backups: { retentionKeep: 14 } })
  assertEquals(parsed?.backups, { retentionKeep: 14 })
  assertEquals(
    parseManagedSettingsBase({ backups: { retentionKeep: 0 } }),
    null,
  )
  assertEquals(parseManagedSettingsBase(undefined)?.backups, undefined)
})

test('parseManagedSettingsBase wires routing.autoReadSplit through', () => {
  assertEquals(
    parseManagedSettingsBase({ routing: { autoReadSplit: true } })?.routing,
    { autoReadSplit: true },
  )
  assertEquals(
    parseManagedSettingsBase({ routing: { autoReadSplit: false } })?.routing,
    { autoReadSplit: false },
  )
  assertEquals(parseManagedSettingsBase({ routing: {} })?.routing, undefined)
  assertEquals(parseManagedSettingsBase(undefined)?.routing, undefined)
})

test('parseManagedSettingsBase rejects malformed routing', () => {
  assertEquals(parseManagedSettingsBase({ routing: 'yes' }), null)
  assertEquals(parseManagedSettingsBase({ routing: [] }), null)
  assertEquals(
    parseManagedSettingsBase({ routing: { autoReadSplit: 'yes' } }),
    null,
  )
  assertEquals(
    parseManagedSettingsBase({ routing: { readSplit: true } }),
    null,
  )
})

test('getManagedReservedEnvKeys returns the engine set or empty for unknown engines', () => {
  assertEquals(
    getManagedReservedEnvKeys('postgres'),
    POSTGRES_RESERVED_ENV_KEYS,
  )
  assertEquals(getManagedReservedEnvKeys('mysql'), MYSQL_RESERVED_ENV_KEYS)
  assertEquals(getManagedReservedEnvKeys('mariadb'), MARIADB_RESERVED_ENV_KEYS)
  assertEquals(getManagedReservedEnvKeys('unknown').size, 0)
})

test('image digest and tag edge cases', () => {
  assertEquals(
    parseManagedSettingsBase({
      image: 'postgres@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    })?.image,
    'postgres@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  )
  assertEquals(
    parseManagedSettingsBase({ image: 'postgres@sha256:deadbeef' }),
    null,
  )
  assertEquals(parseManagedSettingsBase({ image: 'postgres:bad tag!' }), null)
  assertEquals(
    parseManagedSettingsBase({ image: 'a'.repeat(257) }),
    null,
  )
})

test('ssl / resources / engineConfig / exposure reject malformed input', () => {
  assertEquals(parseManagedSettingsBase({ ssl: 'on' }), null)
  assertEquals(parseManagedSettingsBase({ ssl: { mode: 'yes' } }), null)
  assertEquals(parseManagedSettingsBase({ resources: [] }), null)
  assertEquals(parseManagedSettingsBase({ resources: { cpus: -1 } }), null)
  assertEquals(
    parseManagedSettingsBase({ resources: { memoryBytes: 0 } }),
    null,
  )
  assertEquals(
    parseManagedSettingsBase({ resources: { memoryReservationBytes: -5 } }),
    null,
  )
  assertEquals(parseManagedSettingsBase({ engineConfig: 12 }), null)
  assertEquals(parseManagedSettingsBase({ exposure: 'public' }), null)
  assertEquals(parseManagedSettingsBase({ exposure: { enabled: 1 } }), null)
  assertEquals(
    parseManagedSettingsBase({
      exposure: { enabled: false, bind: 'local' },
    }),
    null,
  )
  assertEquals(parseManagedSettingsBase([]), null)
  assertEquals(parseManagedSettingsBase('nope'), null)
})

test('resources accept valid optional fields', () => {
  const parsed = parseManagedSettingsBase({
    resources: {
      cpus: 0,
      memoryBytes: 128 * 1024 * 1024,
      memoryReservationBytes: 64 * 1024 * 1024,
    },
  })
  assertEquals(parsed?.resources, {
    cpus: 0,
    memoryBytes: 128 * 1024 * 1024,
    memoryReservationBytes: 64 * 1024 * 1024,
  })
  assertEquals(
    parseManagedSettingsBase({ resources: {} })?.resources,
    undefined,
  )
})

test('dockerOptions labels and extraEnv reject malformed / reserved', () => {
  assertEquals(
    parseManagedSettingsBase({
      dockerOptions: { labels: { 'traefik.http': '1' } },
    }),
    null,
  )
  assertEquals(
    parseManagedSettingsBase({
      dockerOptions: { labels: { 'com.docker.compose.project': 'x' } },
    }),
    null,
  )
  assertEquals(
    parseManagedSettingsBase({
      dockerOptions: { labels: { '': 'x' } },
    }),
    null,
  )
  assertEquals(
    parseManagedSettingsBase({
      dockerOptions: { labels: { ok: 'x'.repeat(257) } },
    }),
    null,
  )
  assertEquals(
    parseManagedSettingsBase({
      dockerOptions: {
        labels: Object.fromEntries(
          Array.from({ length: 33 }, (_, i) => [`k${i}`, 'v']),
        ),
      },
    }),
    null,
  )
  assertEquals(
    parseManagedSettingsBase(
      { dockerOptions: { extraEnv: { POSTGRES_PASSWORD: 'x' } } },
      POSTGRES_RESERVED_ENV_KEYS,
    ),
    null,
  )
  assertEquals(
    parseManagedSettingsBase({
      dockerOptions: { extraEnv: { '1BAD': 'x' } },
    }),
    null,
  )
  assertEquals(
    parseManagedSettingsBase({
      dockerOptions: { extraEnv: { OK: 'x\u0000y' } },
    }),
    null,
  )
  assertEquals(
    parseManagedSettingsBase({
      dockerOptions: { extraEnv: { OK: 'x'.repeat(4097) } },
    }),
    null,
  )
  assertEquals(
    parseManagedSettingsBase({
      dockerOptions: {
        extraEnv: Object.fromEntries(
          Array.from({ length: 33 }, (_, i) => [`K${i}`, 'v']),
        ),
      },
    }),
    null,
  )
  assertEquals(
    parseManagedSettingsBase({ dockerOptions: { labels: [] } }),
    null,
  )
  assertEquals(
    parseManagedSettingsBase({ dockerOptions: { extraEnv: [] } }),
    null,
  )
})

test('dockerOptions field value rejects and empty object collapses', () => {
  assertEquals(
    parseManagedSettingsBase({ dockerOptions: { restart: 'sometimes' } }),
    null,
  )
  assertEquals(
    parseManagedSettingsBase({ dockerOptions: { stopGracePeriodSeconds: 0 } }),
    null,
  )
  assertEquals(
    parseManagedSettingsBase({ dockerOptions: { shmSizeBytes: -1 } }),
    null,
  )
  assertEquals(
    parseManagedSettingsBase({
      dockerOptions: { ulimits: { nofile: { soft: 2048, hard: 1024 } } },
    }),
    null,
  )
  assertEquals(
    parseManagedSettingsBase({
      dockerOptions: { ulimits: { nofile: { soft: 1 } } },
    }),
    null,
  )
  assertEquals(
    parseManagedSettingsBase({
      dockerOptions: { ulimits: { nofile: 'x' } },
    }),
    null,
  )
  assertEquals(
    parseManagedSettingsBase({ dockerOptions: { ulimits: { memlock: {} } } }),
    null,
  )
  assertEquals(
    parseManagedSettingsBase({ dockerOptions: { ulimits: [] } }),
    null,
  )
  assertEquals(
    parseManagedDockerOptions(undefined),
    undefined,
  )
  assertEquals(parseManagedDockerOptions([]), null)
  assertEquals(parseManagedDockerOptions({}), undefined)
  assertEquals(
    parseManagedDockerOptions({ ulimits: {} })?.ulimits,
    {},
  )
  assertEquals(parseManagedDockerOptions(null), null)
  assertEquals(
    parseManagedSettingsBase({ dockerOptions: null }),
    null,
  )
  assertEquals(
    parseManagedSettingsBase({
      dockerOptions: { extraEnv: { OK: 1 } },
    }),
    null,
  )
  assertEquals(
    parseManagedSettingsBase({
      dockerOptions: { labels: { ok: 1 } },
    }),
    null,
  )
  assertEquals(
    parseManagedSettingsBase(
      { dockerOptions: { extraEnv: { MYSQL_DATABASE: 'x' } } },
      MYSQL_RESERVED_ENV_KEYS,
    ),
    null,
  )
  assertEquals(
    parseManagedSettingsBase({ dockerOptions: { extraEnv: {} } })
      ?.dockerOptions,
    { extraEnv: {} },
  )
})

test('clampManagedResources yields an empty resources object when none were set', () => {
  const settings = parseManagedSettingsBase(undefined)
  if (!settings) throw new TypeError('expected default settings')
  assertEquals(
    clampManagedResources(
      settings,
      { maxCpus: 1, maxMemoryBytes: 1024 },
      { maxCpus: 1, maxMemoryBytes: 1024 },
    ).resources,
    {},
  )
})

test('ssl.mode omitted on an explicit ssl object still inherits', () => {
  assertEquals(parseManagedSettingsBase({ ssl: { mode: undefined } })?.ssl, {})
})

test('image tag-only rejects and non-finite resource numbers', () => {
  assertEquals(parseManagedSettingsBase({ image: 'postgres:' }), null)
  assertEquals(parseManagedSettingsBase({ image: 'postgres:!bad' }), null)
  assertEquals(
    parseManagedSettingsBase({ resources: { cpus: Number.NEGATIVE_INFINITY } }),
    null,
  )
  assertEquals(
    parseManagedSettingsBase({ resources: { cpus: -2.5 } }),
    null,
  )
})
