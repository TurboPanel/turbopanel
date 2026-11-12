import { assertEquals, assertNotEquals, assertRejects } from '@std/assert'
import {
  computeDaemonSourceFingerprint,
  type DevOverlayHooks,
  DevOverlayRebuildError,
  ensureDevOverlayCurrent,
  readDevOverlayIdentity,
  readDevOverlayState,
  REBUILD_TAIL_LINES,
  rebuildOutputTail,
  resetDevOverlayCacheForTests,
  resolveDenoBinary,
  resolveDevTrunkManifest,
} from './dev-update-overlay.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const HEAD = 'abcdef0123456789abcdef0123456789abcdef01'

function stubGit(outputs: Record<string, string | Error>): NonNullable<DevOverlayHooks['runGit']> {
  return (_repo, args) => {
    const value = outputs[args[0]!]
    if (value instanceof Error) {
      return Promise.resolve({
        success: false,
        stdout: new Uint8Array(),
        stderr: new TextEncoder().encode(value.message),
      })
    }
    return Promise.resolve({
      success: true,
      stdout: new TextEncoder().encode(value ?? ''),
      stderr: new Uint8Array(),
    })
  }
}

const CLEAN_GIT = stubGit({
  'rev-parse': `${HEAD}\n`,
  diff: '',
  'ls-files': '',
})

function manifestText(source?: string): string {
  return JSON.stringify({
    schema: 1,
    channel: 'trunk',
    commit: `${HEAD}+1767225600`,
    buildId: 'dev-abcdef0+1767225600',
    builtAt: '2026-01-01T00:00:00.000Z',
    ...(source ? { source } : {}),
  })
}

test('computeDaemonSourceFingerprint matches the daemon algorithm shapes', async () => {
  const clean = await computeDaemonSourceFingerprint('/repo', CLEAN_GIT)
  assertEquals(clean, HEAD)

  const dirty = await computeDaemonSourceFingerprint(
    '/repo',
    stubGit({ 'rev-parse': HEAD, diff: '+x\n', 'ls-files': '' })
  )
  assertEquals(dirty.startsWith(`${HEAD}+dirty.`), true)
  assertEquals(/[0-9a-f]{12}$/.test(dirty), true)

  const untracked = await computeDaemonSourceFingerprint(
    '/repo',
    stubGit({
      'rev-parse': HEAD,
      diff: '',
      'ls-files': 'src/new.ts\n',
      'hash-object': '1111111111111111111111111111111111111111\n',
    })
  )
  assertNotEquals(untracked, HEAD)
  assertNotEquals(untracked, dirty)

  await assertRejects(
    () =>
      computeDaemonSourceFingerprint(
        '/repo',
        stubGit({ 'rev-parse': new Error('not a git repository') })
      ),
    Error,
    'git rev-parse failed'
  )
})

test('readDevOverlayIdentity parses the catalog and rejects malformed input', async () => {
  const identity = await readDevOverlayIdentity('/repo', () => Promise.resolve(manifestText(HEAD)))
  assertEquals(identity, {
    commit: `${HEAD}+1767225600`,
    buildId: 'dev-abcdef0+1767225600',
    builtAt: '2026-01-01T00:00:00.000Z',
    source: HEAD,
  })

  const withoutSource = await readDevOverlayIdentity('/repo', () => Promise.resolve(manifestText()))
  assertEquals(withoutSource?.source, undefined)

  assertEquals(await readDevOverlayIdentity('/repo', () => Promise.resolve('not json')), null)
  assertEquals(
    await readDevOverlayIdentity('/repo', () => Promise.resolve(JSON.stringify({ commit: 7 }))),
    null
  )
  assertEquals(
    await readDevOverlayIdentity('/repo', () => Promise.reject(new Error('ENOENT'))),
    null
  )
})

test('resolveDevTrunkManifest returns the overlay identity when fresh', async () => {
  resetDevOverlayCacheForTests()
  const target = await resolveDevTrunkManifest({
    repoPath: () => '/repo',
    runGit: CLEAN_GIT,
    readManifestText: () => Promise.resolve(manifestText(HEAD)),
  })
  assertEquals(target?.commit, `${HEAD}+1767225600`)
  assertEquals(target?.buildId, 'dev-abcdef0+1767225600')
  assertEquals(target?.channel, 'trunk')
  assertEquals(target?.manifestUrl, '/repo/dist/manifest.json')
})

test('resolveDevTrunkManifest names only the built overlay, never a pending target', async () => {
  // The checkout changed since the build: the target is still the build.
  resetDevOverlayCacheForTests()
  const target = await resolveDevTrunkManifest({
    repoPath: () => '/repo',
    runGit: stubGit({ 'rev-parse': HEAD, diff: '+edited\n', 'ls-files': '' }),
    readManifestText: () => Promise.resolve(manifestText(HEAD)),
  })
  assertEquals(target?.commit, `${HEAD}+1767225600`)
  assertEquals(target?.buildId, 'dev-abcdef0+1767225600')

  // Nothing built yet: no target at all, so nothing reads as available.
  resetDevOverlayCacheForTests()
  const missing = await resolveDevTrunkManifest({
    repoPath: () => '/repo',
    runGit: CLEAN_GIT,
    readManifestText: () => Promise.reject(new Error('ENOENT')),
  })
  assertEquals(missing, null)
})

test('readDevOverlayState reports the build and whether the checkout changed', async () => {
  const fresh = await readDevOverlayState({
    repoPath: () => '/repo',
    runGit: CLEAN_GIT,
    readManifestText: () => Promise.resolve(manifestText(HEAD)),
  })
  assertEquals(fresh.sourceFingerprint, HEAD)
  assertEquals(fresh.sourceChanged, false)
  assertEquals(fresh.built?.commit, `${HEAD}+1767225600`)

  const edited = await readDevOverlayState({
    repoPath: () => '/repo',
    runGit: stubGit({ 'rev-parse': HEAD, diff: '+edited\n', 'ls-files': '' }),
    readManifestText: () => Promise.resolve(manifestText(HEAD)),
  })
  assertEquals(edited.sourceChanged, true)

  const none = await readDevOverlayState({
    repoPath: () => '/repo',
    runGit: CLEAN_GIT,
    readManifestText: () => Promise.reject(new Error('ENOENT')),
  })
  assertEquals(none.built, null)
  assertEquals(none.sourceChanged, true)
})

test('resolveDevTrunkManifest caches the overlay read', async () => {
  resetDevOverlayCacheForTests()
  let reads = 0
  const hooks: DevOverlayHooks = {
    repoPath: () => '/repo',
    runGit: CLEAN_GIT,
    readManifestText: () => {
      reads += 1
      return Promise.resolve(manifestText(HEAD))
    },
  }
  await resolveDevTrunkManifest(hooks)
  await resolveDevTrunkManifest(hooks)
  assertEquals(reads, 1)
})

test('ensureDevOverlayCurrent skips the build when the overlay is fresh', async () => {
  resetDevOverlayCacheForTests()
  let built = 0
  await ensureDevOverlayCurrent({
    repoPath: () => '/repo',
    runGit: CLEAN_GIT,
    readManifestText: () => Promise.resolve(manifestText(HEAD)),
    runRebuild: () => {
      built += 1
      return Promise.resolve({ success: true, code: 0, output: '' })
    },
  })
  assertEquals(built, 0)
})

test('ensureDevOverlayCurrent rebuilds on drift and coalesces callers', async () => {
  resetDevOverlayCacheForTests()
  let built = 0
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const hooks: DevOverlayHooks = {
    repoPath: () => '/repo',
    runGit: CLEAN_GIT,
    readManifestText: () => Promise.resolve(manifestText('stale-source')),
    runRebuild: async () => {
      built += 1
      await gate
      return { success: true, code: 0, output: 'done' }
    },
  }
  const first = ensureDevOverlayCurrent(hooks)
  const second = ensureDevOverlayCurrent(hooks)
  release!()
  await Promise.all([first, second])
  assertEquals(built, 1)
})

test('ensureDevOverlayCurrent rebuilds a fresh overlay when forced', async () => {
  resetDevOverlayCacheForTests()
  let built = 0
  await ensureDevOverlayCurrent(
    {
      repoPath: () => '/repo',
      runGit: CLEAN_GIT,
      readManifestText: () => Promise.resolve(manifestText(HEAD)),
      runRebuild: () => {
        built += 1
        return Promise.resolve({ success: true, code: 0, output: '' })
      },
    },
    { force: true }
  )
  assertEquals(built, 1)
})

test('ensureDevOverlayCurrent rejects with the stderr tail when the build fails', async () => {
  resetDevOverlayCacheForTests()
  const stderr = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
  const err = await assertRejects(
    () =>
      ensureDevOverlayCurrent({
        repoPath: () => '/repo',
        runGit: CLEAN_GIT,
        readManifestText: () => Promise.reject(new Error('ENOENT')),
        runRebuild: () =>
          Promise.resolve({ success: false, code: 7, output: 'compile boom', stderr }),
      }),
    DevOverlayRebuildError,
    'exited 7'
  )
  const lines = err.tail.split('\n')
  assertEquals(lines.length, REBUILD_TAIL_LINES)
  assertEquals(lines[0], 'line 6')
  assertEquals(lines.at(-1), 'line 20')
})

test('rebuildOutputTail keeps the last lines of plain output', () => {
  assertEquals(rebuildOutputTail('a\nb\n\n'), 'a\nb')
})

test('readDevOverlayIdentity rejects non-object manifests', async () => {
  assertEquals(await readDevOverlayIdentity('/repo', () => Promise.resolve('null')), null)
  assertEquals(await readDevOverlayIdentity('/repo', () => Promise.resolve('42')), null)
})

test('computeDaemonSourceFingerprint uses the default git runner', async () => {
  await assertRejects(() => computeDaemonSourceFingerprint('/tmp/turbopanel-missing-overlay-repo'))
})

const VERSIONED_DENO = '/opt/turbopanel/vendor/deno/2.9.8/deno'
const CURRENT_DENO = '/opt/turbopanel/vendor/deno/current/deno'
const BIN_DENO = '/opt/turbopanel/vendor/deno/bin/deno'

/** Resolve with the executable at `execPath` and only `allowed` in the run allow-list. */
function resolveWithAllowed(
  execPath: string,
  allowed: string[]
): { chosen: string; asked: string[] } {
  const asked: string[] = []
  const chosen = resolveDenoBinary({
    execPath: () => execPath,
    mayRun: (command) => {
      asked.push(command)
      return allowed.includes(command)
    },
  })
  return { chosen, asked }
}

test('resolveDenoBinary: spawns the executable path when the allow-list names it', () => {
  const { chosen, asked } = resolveWithAllowed(VERSIONED_DENO, [VERSIONED_DENO, CURRENT_DENO])
  assertEquals(chosen, VERSIONED_DENO)
  assertEquals(asked, [VERSIONED_DENO])
})

test('resolveDenoBinary: spawns the current link when only that spelling is allowed', () => {
  // The development unit: started through `current`, allow-list names `current`,
  // while the executable path is the versioned file the link points at.
  const { chosen } = resolveWithAllowed(VERSIONED_DENO, [CURRENT_DENO])
  assertEquals(chosen, CURRENT_DENO)
})

test('resolveDenoBinary: spawns the bin link when only that spelling is allowed', () => {
  const { chosen } = resolveWithAllowed(VERSIONED_DENO, [BIN_DENO])
  assertEquals(chosen, BIN_DENO)
})

test('resolveDenoBinary: falls back to deno on PATH when only the bare name is allowed', () => {
  const { chosen, asked } = resolveWithAllowed(VERSIONED_DENO, ['deno'])
  assertEquals(chosen, 'deno')
  assertEquals(asked, [VERSIONED_DENO, CURRENT_DENO, BIN_DENO, 'deno'])
})

test('resolveDenoBinary: names the executable path when nothing is allowed', () => {
  // The spawn then fails with "Requires run access to <that path>", which the
  // rebuild reports as it is.
  const { chosen } = resolveWithAllowed(VERSIONED_DENO, [])
  assertEquals(chosen, VERSIONED_DENO)
})

test('resolveDenoBinary: a compiled control plane never re-execs itself', () => {
  const { chosen, asked } = resolveWithAllowed('/opt/turbopanel/bin/turbopanel', [
    '/opt/turbopanel/bin/turbopanel',
  ])
  assertEquals(chosen, 'deno')
  assertEquals(asked, [])
})

test('resolveDenoBinary: asks this process for its own run permission by default', () => {
  // The executable path is the first choice when it may be run and the
  // fallback when nothing may be, so it is the answer with or without a grant.
  assertEquals(resolveDenoBinary(), Deno.execPath())
})
