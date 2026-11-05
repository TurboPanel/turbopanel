/** Development migrate-before-start gate: trunk-only migrations, backup command, pruning. */
import { assert, assertEquals, assertMatch } from '@std/assert'
import { join } from '@std/path'
import { createHash } from 'node:crypto'
import {
  BACKUP_DIR_VAR,
  buildDevBackupCommand,
  GIT,
  pruneBackups,
  readTrunkEntries,
  sqlHash,
  trunkRefusal,
} from './dev-migrate-gate.mjs'

/** Alias so Sonar recognizes the suite (see check-deploy-env.test.ts). */
const test = Deno.test.bind(Deno)

const entry = (idx: number) => ({ tag: `000${idx}_m${idx}`, when: 1000 + idx, sha256: `h${idx}` })
const TRUNK = [entry(0), entry(1), entry(2), entry(3)]
/** Local SQL hashes that match trunk, by tag. */
const MATCHING = (tag: string) => TRUNK.find((e) => e.tag === tag)?.sha256 ?? null

/** A socket URL like the instance unit's, built from parts so no secret-shaped literal sits here. */
function socketUrl(user = 'turbopanel', db = 'turbopanel') {
  const pw = ['p', 'w'].join('')
  return ['postgresql:', '//', user, ':', pw, '@/', db, '?host=/run/turbopanel/postgres'].join('')
}

test('an older checkout whose migrations are all on trunk may migrate', () => {
  const refusal = trunkRefusal({
    localEntries: TRUNK.slice(0, 3),
    journalEntries: TRUNK.slice(0, 3),
    trunkEntries: TRUNK,
    hashOf: MATCHING,
  })
  assertEquals(refusal, null)
})

test('a manifest entry that exists only on a branch is refused', () => {
  const branch = { tag: '0002_branch', when: 2000, sha256: 'hb' }
  const refusal = trunkRefusal({
    localEntries: [...TRUNK.slice(0, 2), branch],
    journalEntries: [...TRUNK.slice(0, 2), branch],
    trunkEntries: TRUNK,
    hashOf: MATCHING,
  })
  assertEquals(refusal, 'migration 0002_branch is not on origin/trunk')
})

test('a journal entry the manifest does not list yet is refused (what drizzle would apply)', () => {
  // `pnpm generate` on a branch: SQL and journal entry written, manifest not updated.
  const refusal = trunkRefusal({
    localEntries: TRUNK.slice(0, 2),
    journalEntries: [...TRUNK.slice(0, 2), { tag: '0002_new', when: 2000 }],
    trunkEntries: TRUNK,
    hashOf: (tag: string) => MATCHING(tag) ?? 'hn',
  })
  assertEquals(refusal, 'migration 0002_new is not on origin/trunk')
})

test('a journal entry past the end of trunk is refused', () => {
  const refusal = trunkRefusal({
    localEntries: TRUNK,
    journalEntries: [...TRUNK, { tag: '0004_next', when: 1004 }],
    trunkEntries: TRUNK,
    hashOf: MATCHING,
  })
  assertEquals(refusal, 'migration 0004_next is not on origin/trunk')
})

test('a migration whose SQL differs from trunk, or is missing, is refused', () => {
  const base = {
    localEntries: TRUNK.slice(0, 3),
    journalEntries: TRUNK.slice(0, 3),
    trunkEntries: TRUNK,
  }
  assertEquals(
    trunkRefusal({
      ...base,
      hashOf: (tag: string) => (tag === '0002_m2' ? 'edited' : MATCHING(tag)),
    }),
    'migrations/0002_m2.sql differs from origin/trunk'
  )
  assertEquals(
    trunkRefusal({ ...base, hashOf: (tag: string) => (tag === '0001_m1' ? null : MATCHING(tag)) }),
    'migrations/0001_m1.sql is missing'
  )
})

test('a journal entry with a different time than trunk is refused', () => {
  const refusal = trunkRefusal({
    localEntries: TRUNK.slice(0, 2),
    journalEntries: [TRUNK[0], { ...TRUNK[1], when: 9999 }],
    trunkEntries: TRUNK,
    hashOf: MATCHING,
  })
  assertEquals(refusal, 'migration 0001_m1 is not on origin/trunk')
})

function git(cwd: string, ...args: string[]) {
  const out = new Deno.Command(GIT, {
    args: [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    cwd,
    env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).outputSync()
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr))
}

test('trunk entries and SQL hashes are read from a real checkout', () => {
  const root = Deno.makeTempDirSync()
  try {
    Deno.mkdirSync(join(root, 'migrations'))
    const manifest = { entries: [{ tag: '0000_a', when: 1, sha256: 'x' }] }
    Deno.writeTextFileSync(join(root, 'migrations', 'manifest.json'), JSON.stringify(manifest))
    Deno.writeTextFileSync(join(root, 'migrations', '0000_a.sql'), 'select 1;\n')
    git(root, 'init', '-q', '-b', 'trunk')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'm')
    // Without an origin/trunk ref there is nothing to compare with.
    assertEquals(readTrunkEntries(root), null)
    git(root, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD')
    assertEquals(readTrunkEntries(root), manifest.entries)
    // drizzle's hash: sha256 of the file's text.
    assertEquals(sqlHash(root, '0000_a'), createHash('sha256').update('select 1;\n').digest('hex'))
    assertEquals(sqlHash(root, '0001_missing'), null)
  } finally {
    Deno.removeSync(root, { recursive: true })
  }
})

test('the backup dumps inside the local container into the folder', () => {
  const plan = buildDevBackupCommand(
    socketUrl(),
    '/var/lib/turbopanel/dev-updates/backups',
    'turbopanel-database'
  )
  if (!('command' in plan) || !plan.command) throw new Error(`no command: ${plan.error}`)
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
      (d) => `turbopanel-${d}T000000Z-1.dump`
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
