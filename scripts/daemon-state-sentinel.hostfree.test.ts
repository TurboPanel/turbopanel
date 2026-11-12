/**
 * The CI daemon state sentinel: it notices every kind of write, it never
 * seeds over real files, and every Deno test job in build.yml seeds it before
 * the tests and checks it after them. Temp dirs under `/tmp` only.
 */
import { assert, assertEquals, assertStringIncludes, assertThrows } from '@std/assert'
import { dirname, fromFileUrl, join } from '@std/path'
import { SENTINEL_FILES, seedSentinel, sentinelProblems } from './daemon-state-sentinel.mjs'
import {
  COLOCATED_LICENSE_ID_FILE,
  COLOCATED_LICENSE_TOKEN_FILE,
  COLOCATED_SERVER_ID_FILE,
  COLOCATED_SERVER_KEY_FILE,
  COLOCATED_SERVER_KEY_ID_FILE,
} from '../src/client/authn/colocated-credentials-dir.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const REPO = dirname(dirname(fromFileUrl(import.meta.url)))
const NOT_CI = { GITHUB_ACTIONS: undefined }

async function withSeeded(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = await Deno.makeTempDir({ dir: '/tmp', prefix: 'tp-state-sentinel-' })
  try {
    seedSentinel(dir, NOT_CI)
    await fn(dir)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

test('a freshly seeded sentinel has no problems', async () => {
  await withSeeded((dir) => {
    assertEquals(sentinelProblems(dir), [])
    for (const [name, body] of Object.entries(SENTINEL_FILES)) {
      assertEquals(Deno.readTextFileSync(join(dir, name)), body)
    }
  })
})

test('the sentinel holds exactly the files the control plane writes for the daemon', () => {
  const daemonFiles = [
    COLOCATED_LICENSE_ID_FILE,
    COLOCATED_LICENSE_TOKEN_FILE,
    COLOCATED_SERVER_ID_FILE,
    COLOCATED_SERVER_KEY_FILE,
    COLOCATED_SERVER_KEY_ID_FILE,
  ]
  assertEquals(Object.keys(SENTINEL_FILES).sort(), daemonFiles.sort())
})

test('an overwritten license token is reported', async () => {
  await withSeeded(async (dir) => {
    await Deno.writeTextFile(join(dir, COLOCATED_LICENSE_TOKEN_FILE), 'a throwaway database value')
    assertEquals(sentinelProblems(dir), [`changed: ${COLOCATED_LICENSE_TOKEN_FILE}`])
  })
})

test('a removed server key is reported', async () => {
  await withSeeded(async (dir) => {
    await Deno.remove(join(dir, COLOCATED_SERVER_KEY_FILE))
    assertEquals(sentinelProblems(dir), [`removed: ${COLOCATED_SERVER_KEY_FILE}`])
  })
})

test('a new file or folder anywhere under the dir is reported', async () => {
  await withSeeded(async (dir) => {
    await Deno.mkdir(join(dir, 'execution-logs', 'run'), { recursive: true })
    assertEquals(sentinelProblems(dir), [
      'new entry: execution-logs',
      'new entry: execution-logs/run',
    ])
  })
})

test('a sentinel file replaced by a link is reported', async () => {
  await withSeeded(async (dir) => {
    await Deno.remove(join(dir, 'server.id'))
    await Deno.symlink('/etc/hostname', join(dir, 'server.id'))
    assertEquals(sentinelProblems(dir), ['not a plain file: server.id'])
  })
})

test('a missing dir is reported', () => {
  assertEquals(sentinelProblems('/tmp/tp-state-sentinel-never-made'), [
    '/tmp/tp-state-sentinel-never-made is missing',
  ])
})

test('seed never writes over files that are not the sentinel', async () => {
  const dir = await Deno.makeTempDir({ dir: '/tmp', prefix: 'tp-state-sentinel-' })
  try {
    await Deno.writeTextFile(join(dir, 'license.id'), 'real-looking')
    assertThrows(() => seedSentinel(dir, NOT_CI), Error, 'refusing to seed')
    assertEquals(await Deno.readTextFile(join(dir, 'license.id')), 'real-looking')
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

test('seed refuses a dir outside /tmp unless it runs under GitHub Actions', () => {
  assertThrows(
    () => seedSentinel('/var/lib/turbopanel-sentinel-never-made', NOT_CI),
    Error,
    'outside /tmp'
  )
})

test('verify exits non-zero and names the change', async () => {
  await withSeeded(async (dir) => {
    await Deno.writeTextFile(join(dir, 'license.id'), 'throwaway')
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        'run',
        '--allow-read',
        join(REPO, 'scripts', 'daemon-state-sentinel.mjs'),
        'verify',
        dir,
      ],
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    assertEquals(out.code, 1)
    assertStringIncludes(new TextDecoder().decode(out.stderr), 'changed: license.id')
  })
})

/** One top-level job's text (`  <name>:` up to the next job). */
function jobText(source: string, name: string): string {
  const start = source.indexOf(`\n  ${name}:\n`)
  assert(start >= 0, `build.yml has no ${name} job`)
  const rest = source.slice(start + 1)
  const end = rest.slice(1).search(/\n {2}[\w-]+:\n/)
  return end < 0 ? rest : rest.slice(0, end + 2)
}

test('every Deno test job seeds the sentinel before its tests and verifies it after', () => {
  const build = Deno.readTextFileSync(join(REPO, '.github', 'workflows', 'build.yml'))
  const jobs: Array<[string, string]> = [
    ['deno-hostfree', 'run: pnpm test:coverage'],
    ['deno-db', 'run: pnpm test:coverage'],
    ['deno-redis', 'run: deno test -A'],
  ]
  for (const [name, testStep] of jobs) {
    const job = jobText(build, name)
    const seed = job.indexOf('daemon-state-sentinel.mjs seed /var/lib/turbopanel')
    const tests = job.indexOf(testStep)
    const verify = job.indexOf('daemon-state-sentinel.mjs verify /var/lib/turbopanel')
    assert(seed >= 0 && tests > seed, `${name}: seed the sentinel before the tests`)
    assert(verify > tests, `${name}: verify the sentinel after the tests`)
    const verifyStep = job.slice(job.lastIndexOf('- name:', verify), verify)
    assertStringIncludes(verifyStep, '!cancelled()', `${name}: verify even when tests fail`)
    assert(
      !/TURBOPANEL_(DAEMON_)?STATE_DIR/.test(job),
      `${name}: keep the default state dir so the sentinel is the dir the writers resolve`
    )
  }
})
