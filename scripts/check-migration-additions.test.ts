/**
 * Migration additions guard: additions pass; edits or deletions of shipped
 * migrations and snapshots fail; journal and manifest may change.
 */
import { assertEquals, assertStringIncludes } from '@std/assert'
import { findViolations, parseChanges, resolveBase } from './check-migration-additions.mjs'

/** Alias so Sonar recognizes the suite (see check-deploy-env.test.ts). */
const test = Deno.test.bind(Deno)

test('added migrations and snapshots pass', () => {
  assertEquals(
    findViolations([
      { status: 'A', path: 'migrations/0017_new.sql' },
      { status: 'A', path: 'migrations/meta/0017_snapshot.json' },
    ]),
    []
  )
})

test('editing or deleting an applied migration fails', () => {
  const edited = { status: 'M', path: 'migrations/0013_add_edict_and_bulwark.sql' }
  const deleted = { status: 'D', path: 'migrations/meta/0013_snapshot.json' }
  assertEquals(findViolations([edited, deleted]), [edited, deleted])
})

test('editing a grandfathered migration still fails (grandfathering is forward-only only)', () => {
  const edited = { status: 'M', path: 'migrations/0011_rename_upgradestep_to_stage.sql' }
  assertEquals(findViolations([edited]), [edited])
})

test('journal and manifest may change', () => {
  assertEquals(
    findViolations([
      { status: 'M', path: 'migrations/meta/_journal.json' },
      { status: 'M', path: 'migrations/manifest.json' },
    ]),
    []
  )
})

test('resolveBase skips the -- pnpm forwards', () => {
  assertEquals(resolveBase(['--', 'abc123']), 'abc123')
  assertEquals(resolveBase(['--']), 'origin/trunk')
})

test('a rename or copy is a violation when either path is immutable', () => {
  const moved = {
    status: 'R',
    path: 'migrations/archive/0001_a.sql',
    paths: ['migrations/0001_a.sql', 'migrations/archive/0001_a.sql'],
  }
  const renamed = {
    status: 'R',
    path: 'migrations/0001_b.sql',
    paths: ['migrations/0001_a.sql', 'migrations/0001_b.sql'],
  }
  const copied = {
    status: 'C',
    path: 'migrations/0001_a.sql',
    paths: ['migrations/0002_x.sql', 'migrations/0001_a.sql'],
  }
  assertEquals(findViolations([moved, renamed, copied]), [moved, renamed, copied])
})

test('parseChanges keeps both paths of a rename', () => {
  assertEquals(
    parseChanges(
      'R100\tmigrations/0001_a.sql\tmigrations/archive/0001_a.sql\nA\tmigrations/0002_b.sql\n'
    ),
    [
      {
        status: 'R',
        path: 'migrations/archive/0001_a.sql',
        paths: ['migrations/0001_a.sql', 'migrations/archive/0001_a.sql'],
      },
      { status: 'A', path: 'migrations/0002_b.sql', paths: ['migrations/0002_b.sql'] },
    ]
  )
})

/** Run the guard in a throwaway repo whose base commit has a frozen manifest. */
function guardAfter(change: (dir: string) => void): { code: number; out: string } {
  const dir = Deno.makeTempDirSync()
  try {
    const git = (...args: string[]) => {
      const result = new Deno.Command('git', {
        args: ['-C', dir, '-c', 'commit.gpgsign=false', ...args],
        env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
        stdout: 'piped',
        stderr: 'piped',
      }).outputSync()
      if (!result.success) throw new Error(new TextDecoder().decode(result.stderr))
    }
    git('init', '-q')
    git('config', 'user.name', 'test')
    git('config', 'user.email', 'test@example.invalid')
    Deno.mkdirSync(`${dir}/migrations`)
    Deno.writeTextFileSync(`${dir}/migrations/manifest.json`, '{"frozen":true}')
    Deno.writeTextFileSync(`${dir}/migrations/0001_a.sql`, 'select 1;\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'base')
    change(dir)
    git('add', '-A')
    git('commit', '-q', '-m', 'change')
    const run = new Deno.Command('node', {
      args: [new URL('./check-migration-additions.mjs', import.meta.url).pathname, 'HEAD~1'],
      cwd: dir,
      stdout: 'piped',
      stderr: 'piped',
    }).outputSync()
    const decoder = new TextDecoder()
    return { code: run.code, out: decoder.decode(run.stdout) + decoder.decode(run.stderr) }
  } finally {
    Deno.removeSync(dir, { recursive: true })
  }
}

test('script: moving a shipped migration into a subfolder fails', () => {
  const result = guardAfter((dir) => {
    Deno.mkdirSync(`${dir}/migrations/archive`)
    Deno.renameSync(`${dir}/migrations/0001_a.sql`, `${dir}/migrations/archive/0001_a.sql`)
  })
  assertEquals(result.code, 1)
  assertStringIncludes(result.out, 'migrations/0001_a.sql was deleted')
})

test('script: renaming a shipped migration in place fails', () => {
  const result = guardAfter((dir) => {
    Deno.renameSync(`${dir}/migrations/0001_a.sql`, `${dir}/migrations/0001_b.sql`)
  })
  assertEquals(result.code, 1)
})

test('script: deleting or editing a shipped migration fails, adding one passes', () => {
  assertEquals(guardAfter((dir) => Deno.removeSync(`${dir}/migrations/0001_a.sql`)).code, 1)
  assertEquals(
    guardAfter((dir) => Deno.writeTextFileSync(`${dir}/migrations/0001_a.sql`, 'select 2;\n')).code,
    1
  )
  assertEquals(
    guardAfter((dir) => Deno.writeTextFileSync(`${dir}/migrations/0002_b.sql`, 'select 3;\n')).code,
    0
  )
})
