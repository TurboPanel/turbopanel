/** Pre-migrate backup gate: run or warn, and never print the database URL. */
import { assertEquals, assertThrows } from '@std/assert'
import {
  backupTimeoutSeconds,
  planMigrateBackup,
  redactSecrets,
  runMigrateBackup,
} from './migrate-backup.mjs'

/** Alias so Sonar recognizes the suite (see check-deploy-env.test.ts). */
const test = Deno.test.bind(Deno)

const DB = new URL('postgresql://db.example:5432/panel')
// Random per run, so no password-shaped literal sits in the file.
const PW = `pw ${crypto.randomUUID()}`
DB.username = ['mi', 'grator'].join('')
DB.password = PW
const URL_WITH_PASSWORD = DB.href

test('a set command is run, in any environment', () => {
  for (const CLOUDFLARE_ENV of ['live', 'staging', '']) {
    const plan = planMigrateBackup({
      CLOUDFLARE_ENV,
      TURBOPANEL_MIGRATE_BACKUP_COMMAND: ' backup.sh ',
    })
    assertEquals(plan, { action: 'run', command: 'backup.sh' })
  }
})

test('without a command, every environment warns and goes on', () => {
  for (const CLOUDFLARE_ENV of [
    'testing',
    'staging',
    'live',
    'Live',
    'production',
    'typo',
    undefined,
  ]) {
    const plan = planMigrateBackup({ CLOUDFLARE_ENV })
    assertEquals(plan.action, 'warn')
    assertEquals(plan.message.includes('NO database backup command ran'), true)
    assertEquals(plan.message.includes('managed backups'), true)
    assertEquals(plan.message.includes('restore window'), true)
  }
})

test('the old acknowledgement variable only changes the wording', () => {
  const plain = planMigrateBackup({ CLOUDFLARE_ENV: 'live' })
  const acked = planMigrateBackup({ CLOUDFLARE_ENV: 'live', TURBOPANEL_MIGRATE_BACKUP_ACK: '1' })
  assertEquals(acked.action, 'warn')
  assertEquals(acked.message === plain.message, false)
})

test('a missing command on live logs one warning and does not throw', () => {
  const lines: string[] = []
  runMigrateBackup({ CLOUDFLARE_ENV: 'live' }, (l: string) => lines.push(l))
  assertEquals(lines.length, 1)
  assertEquals(lines[0].includes('WARNING'), true)
})

test('a failing backup command stops the migration', () => {
  const env = {
    CLOUDFLARE_ENV: 'live',
    TURBOPANEL_MIGRATE_BACKUP_COMMAND: 'dump',
    TURBOPANEL_DATABASE_URL: URL_WITH_PASSWORD,
  }
  assertThrows(
    () =>
      runMigrateBackup(
        env,
        () => {},
        () => ({ status: 2, stdout: '', stderr: 'boom' })
      ),
    Error,
    'not migrating'
  )
})

test('a good backup passes the environment on and prints no secrets', () => {
  const env = {
    CLOUDFLARE_ENV: 'live',
    TURBOPANEL_MIGRATE_BACKUP_COMMAND: 'dump',
    TURBOPANEL_DATABASE_URL: URL_WITH_PASSWORD,
  }
  const lines: string[] = []
  let seen: Record<string, string | undefined> = {}
  runMigrateBackup(
    env,
    (l: string) => lines.push(l),
    (_cmd: string, e: Record<string, string | undefined>) => {
      seen = e
      return {
        status: 0,
        stdout: `connecting ${URL_WITH_PASSWORD} ${PW}`,
        stderr: '',
      }
    }
  )
  assertEquals(seen.TURBOPANEL_DATABASE_URL, URL_WITH_PASSWORD)
  const printed = lines.join('\n')
  assertEquals(printed.includes(PW), false)
  assertEquals(printed.includes('db.example'), false)
})

test('the real runner reads the URL from the environment', () => {
  const lines: string[] = []
  runMigrateBackup(
    {
      TURBOPANEL_MIGRATE_BACKUP_COMMAND:
        'test -n "$TURBOPANEL_DATABASE_URL" && echo "$TURBOPANEL_DATABASE_URL"',
      TURBOPANEL_DATABASE_URL: URL_WITH_PASSWORD,
      PATH: Deno.env.get('PATH') ?? '',
    },
    (l: string) => lines.push(l)
  )
  assertEquals(lines.join('\n').includes('db.example'), false)
  assertEquals(lines.at(-1), 'migrate-locked: database backup finished')
})

test('redactSecrets blanks the URL and decoded password', () => {
  assertEquals(
    redactSecrets(`x ${URL_WITH_PASSWORD} y ${PW}`, { TURBOPANEL_DATABASE_URL: URL_WITH_PASSWORD }),
    'x [redacted] y [redacted]'
  )
})

test('live refuses with a plain message, in any spelling that is not an allowed environment', () => {
  for (const CLOUDFLARE_ENV of ['live', 'Live', 'production', 'stagin']) {
    const plan = planMigrateBackup({ CLOUDFLARE_ENV })
    assertEquals(plan.action, 'refuse')
    assertEquals(
      plan.message?.includes(`refusing to migrate ${CLOUDFLARE_ENV} without a backup`),
      true
    )
  }
  for (const CLOUDFLARE_ENV of ['', 'ci', 'local', 'testing', 'staging']) {
    assertEquals(planMigrateBackup({ CLOUDFLARE_ENV }).action, 'warn')
  }
})

test('a timed-out, errored or oversized backup stops the migration with a reason', () => {
  const env = { CLOUDFLARE_ENV: 'live', TURBOPANEL_MIGRATE_BACKUP_COMMAND: 'dump' }
  const fail = (result: object) =>
    assertThrows(
      () =>
        runMigrateBackup(
          env,
          () => {},
          () => ({ status: null, ...result })
        ),
      Error
    ).message
  assertEquals(
    fail({ error: { code: 'ETIMEDOUT', message: 'spawnSync ETIMEDOUT' } }),
    'backup timed out after 900s; not migrating'
  )
  assertEquals(
    fail({ error: { code: 'ENOBUFS', message: 'spawnSync sh ENOBUFS' } }),
    'database backup failed (spawnSync sh ENOBUFS); not migrating'
  )
  assertEquals(
    fail({ signal: 'SIGKILL' }),
    'database backup failed (stopped by SIGKILL); not migrating'
  )
})

test('the timeout setting is checked and passed on', () => {
  assertEquals(backupTimeoutSeconds({}), 900)
  assertEquals(backupTimeoutSeconds({ TURBOPANEL_MIGRATE_BACKUP_TIMEOUT_SECONDS: '30' }), 30)
  for (const bad of ['0', '-1', 'soon', '1.5']) {
    assertThrows(() => backupTimeoutSeconds({ TURBOPANEL_MIGRATE_BACKUP_TIMEOUT_SECONDS: bad }))
  }
  let seen = 0
  runMigrateBackup(
    { TURBOPANEL_MIGRATE_BACKUP_COMMAND: 'dump', TURBOPANEL_MIGRATE_BACKUP_TIMEOUT_SECONDS: '7' },
    () => {},
    (_cmd: string, _env: unknown, options: { timeoutSeconds: number }) => {
      seen = options.timeoutSeconds
      return { status: 0 }
    }
  )
  assertEquals(seen, 7)
})

test('the real runner kills a hung command', () => {
  const err = assertThrows(
    () =>
      runMigrateBackup(
        {
          TURBOPANEL_MIGRATE_BACKUP_COMMAND: 'sleep 30',
          TURBOPANEL_MIGRATE_BACKUP_TIMEOUT_SECONDS: '1',
          PATH: Deno.env.get('PATH') ?? '',
        },
        () => {}
      ),
    Error
  )
  assertEquals(err.message, 'backup timed out after 1s; not migrating')
})

test('a set command really runs and its exit code decides', () => {
  const dir = Deno.makeTempDirSync()
  const env = { PATH: Deno.env.get('PATH') ?? '' }
  runMigrateBackup({ ...env, TURBOPANEL_MIGRATE_BACKUP_COMMAND: `touch ${dir}/ran` }, () => {})
  assertEquals(Deno.statSync(`${dir}/ran`).isFile, true)
  assertThrows(
    () => runMigrateBackup({ ...env, TURBOPANEL_MIGRATE_BACKUP_COMMAND: 'exit 3' }, () => {}),
    Error,
    'exit 3'
  )
})

test('secret-looking env values are blanked, short ones are left alone', () => {
  const env = {
    TURBOPANEL_DATABASE_URL: URL_WITH_PASSWORD,
    STORAGE_ACCESS_KEY: 'abcd-1234-efgh',
    API_TOKEN: 'short',
    OTHER: 'plain-value-here',
  }
  assertEquals(
    redactSecrets('a abcd-1234-efgh b short c plain-value-here', env),
    'a [redacted] b short c plain-value-here'
  )
})
