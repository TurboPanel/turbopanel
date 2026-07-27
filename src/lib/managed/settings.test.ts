import { assertEquals } from 'jsr:@std/assert'
import {
  clampManagedResources,
  DEFAULT_MANAGED_SETTINGS,
  MANAGED_DOCKER_OPTION_DENYLIST,
  parseBackupSettings,
  parseManagedSettingsBase,
  RESERVED_PUBLISHED_PORTS,
} from './settings.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parseManagedSettingsBase returns defaults for undefined/null', () => {
  assertEquals(parseManagedSettingsBase(undefined), {
    ssl: { enabled: false },
    exposure: { enabled: false },
  })
  assertEquals(parseManagedSettingsBase(null), {
    ssl: { enabled: false },
    exposure: { enabled: false },
  })
  assertEquals(
    parseManagedSettingsBase(undefined)?.ssl,
    DEFAULT_MANAGED_SETTINGS.ssl,
  )
})

test('image ref accept/reject', () => {
  const ok = parseManagedSettingsBase({
    image: 'docker.io/library/postgres:18-alpine',
  })
  assertEquals(ok?.image, 'docker.io/library/postgres:18-alpine')

  assertEquals(parseManagedSettingsBase({ image: 'postgres:18' })?.image, 'postgres:18')
  assertEquals(parseManagedSettingsBase({ image: 'bad image' }), null)
  assertEquals(parseManagedSettingsBase({ image: 'postgres;rm' }), null)
  assertEquals(parseManagedSettingsBase({ image: '' }), null)
  assertEquals(parseManagedSettingsBase({ image: 12 }), null)
})

test('engineConfig size cap and control-char reject', () => {
  const ok = parseManagedSettingsBase({ engineConfig: 'shared_buffers = 128MB\n' })
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
  assertEquals(parsed?.dockerOptions?.ulimits?.nofile, { soft: 1024, hard: 2048 })
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

test('exposure port range, reserved ports, enabled requires port', () => {
  assertEquals(
    parseManagedSettingsBase({
      exposure: { enabled: true, publishedPort: 15432 },
    })?.exposure,
    { enabled: true, publishedPort: 15432 },
  )
  assertEquals(
    parseManagedSettingsBase({ exposure: { enabled: true } }),
    null,
  )
  assertEquals(
    parseManagedSettingsBase({
      exposure: { enabled: true, publishedPort: 0 },
    }),
    null,
  )
  assertEquals(
    parseManagedSettingsBase({
      exposure: { enabled: true, publishedPort: 70000 },
    }),
    null,
  )
  for (const port of RESERVED_PUBLISHED_PORTS) {
    assertEquals(
      parseManagedSettingsBase({
        exposure: { enabled: true, publishedPort: port },
      }),
      null,
      `reserved port ${port} must be rejected`,
    )
  }
  assertEquals(
    parseManagedSettingsBase({
      exposure: { enabled: false, bind: 'local' },
    })?.exposure,
    { enabled: false, bind: 'local' },
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
})

test('parseBackupSettings: retentionKeep accepted within bounds', () => {
  assertEquals(parseBackupSettings({ retentionKeep: 1 }), { retentionKeep: 1 })
  assertEquals(parseBackupSettings({ retentionKeep: 100 }), { retentionKeep: 100 })
  assertEquals(parseBackupSettings({ retentionKeep: 7.9 }), { retentionKeep: 7 })
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
  assertEquals(parseManagedSettingsBase({ backups: { retentionKeep: 0 } }), null)
  assertEquals(parseManagedSettingsBase(undefined)?.backups, undefined)
})
