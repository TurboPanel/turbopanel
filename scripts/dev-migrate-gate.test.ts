/** Development migrate-before-start gate: trunk-only migrations, backup command, pruning. */
import { assert, assertEquals, assertMatch } from '@std/assert'
import { join } from '@std/path'
import {
  BACKUP_DIR_VAR,
  buildDevBackupCommand,
  pruneBackups,
  trunkRefusal,
} from './dev-migrate-gate.mjs'

/** Alias so Sonar recognizes the suite (see check-deploy-env.test.ts). */
const test = Deno.test.bind(Deno)

const entry = (idx: number) => ({ tag: `000${idx}_m${idx}`, sha256: `h${idx}` })
const TRUNK = [entry(0), entry(1), entry(2), entry(3)]

/** A socket URL like the instance unit's, built from parts so no secret-shaped literal sits here. */
function socketUrl(user = 'turbopanel', db = 'turbopanel') {
  const pw = ['p', 'w'].join('')
  return ['postgresql:', '//', user, ':', pw, '@/', db, '?host=/run/turbopanel/postgres'].join('')
}

test('an older checkout whose pending migrations are all on trunk may migrate', () => {
  const refusal = trunkRefusal({
    localEntries: TRUNK.slice(0, 3),
    trunkEntries: TRUNK,
    pending: ['h1', 'h2'],
    changedFiles: [],
  })
  assertEquals(refusal, null)
})

test('a migration that exists only on a branch is refused', () => {
  const refusal = trunkRefusal({
    localEntries: [...TRUNK.slice(0, 2), { tag: '0002_branch', sha256: 'hb' }],
    trunkEntries: TRUNK,
    pending: ['hb'],
    changedFiles: ['migrations/0002_branch.sql'],
  })
  assertEquals(refusal, 'migration 0002_branch is not on origin/trunk')
})

test('a pending migration edited locally is refused', () => {
  const refusal = trunkRefusal({
    localEntries: TRUNK.slice(0, 3),
    trunkEntries: TRUNK,
    pending: ['h2'],
    changedFiles: ['migrations/0002_m2.sql'],
  })
  assertEquals(refusal, 'migrations/0002_m2.sql differs from origin/trunk')
})

test('a changed file that is not pending (or not a migration) does not block', () => {
  const refusal = trunkRefusal({
    localEntries: TRUNK.slice(0, 3),
    trunkEntries: TRUNK,
    pending: ['h2'],
    changedFiles: ['migrations/manifest.json', 'migrations/meta/_journal.json'],
  })
  assertEquals(refusal, null)
})

test('the backup dumps inside the local container into the folder', () => {
  const plan = buildDevBackupCommand(
    socketUrl(),
    '/var/lib/turbopanel/dev-updates/backups',
    'turbopanel-database'
  )
  assert('command' in plan)
  assertMatch(
    plan.command,
    /docker exec turbopanel-database pg_dump -Fc -U 'turbopanel' -d 'turbopanel' > "\$f\.part"/
  )
  assertMatch(plan.command, /f='\/var\/lib\/turbopanel\/dev-updates\/backups'\/turbopanel-/)
  assert(!plan.command.includes(['p', 'w'].join('')), 'the password never reaches the command')
})

test('a loopback TCP URL is local; any other host is refused', () => {
  const local = new URL('postgresql://localhost:5432/turbopanel')
  local.username = 'turbopanel'
  assert('command' in buildDevBackupCommand(local.href, '/tmp/b', 'turbopanel-database'))
  const remote = new URL(local.href)
  remote.hostname = 'db.example.com'
  assertEquals(buildDevBackupCommand(remote.href, '/tmp/b', 'turbopanel-database'), {
    error: 'the database is not on this machine (host db.example.com)',
  })
})

test('names and folders that are not plain are refused', () => {
  assertEquals(buildDevBackupCommand(socketUrl("x'y"), '/tmp/b', 'c'), {
    error: 'no plain user name in the URL',
  })
  assertEquals(buildDevBackupCommand(socketUrl('u', 'd;rm'), '/tmp/b', 'c'), {
    error: 'no plain database name in the URL',
  })
  for (const dir of ['', 'relative', '/tmp/../etc', "/tmp/a'b"]) {
    assertEquals(buildDevBackupCommand(socketUrl(), dir, 'c'), {
      error: `${BACKUP_DIR_VAR} is not a plain absolute path`,
    })
  }
  assertEquals(buildDevBackupCommand('mysql://h/d', '/tmp/b', 'c'), {
    error: 'the database URL is not a Postgres URL',
  })
})

test('pruning keeps the newest dumps and leaves other files', () => {
  const dir = Deno.makeTempDirSync()
  try {
    const dumps = ['20261101', '20261102', '20261103', '20261104'].map(
      (d) => `turbopanel-${d}T000000Z.dump`
    )
    for (const name of [...dumps, 'notes.txt']) Deno.writeTextFileSync(join(dir, name), 'x')
    pruneBackups(dir, 2)
    const left = [...Deno.readDirSync(dir)].map((e) => e.name).sort((a, b) => a.localeCompare(b))
    assertEquals(left, ['notes.txt', dumps[2], dumps[3]])
  } finally {
    Deno.removeSync(dir, { recursive: true })
  }
})

test('pruning a missing folder does nothing', () => {
  pruneBackups('/nonexistent/turbopanel-test-backups')
})
