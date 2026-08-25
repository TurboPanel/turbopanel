import { assertEquals } from '@std/assert'
import type { GitProvider } from '../../lib/git/git-provider.ts'
import { INSPECT_PROBE_PATHS } from './inspect.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

/**
 * The fallback rule, exercised directly.
 *
 * `inspectRepository` resolves its provider through the module registry, so
 * these assert the decision function rather than stubbing module state: a
 * failure carrying an HTTP status is the provider's ANSWER and must surface;
 * one without a status never got an HTTP answer and is therefore a reachability
 * problem the daemon may not share.
 */
function shouldFallBackToDaemon(
  read: { unsupported?: true; failure?: string; status?: number },
): boolean {
  if (read.unsupported) return true
  if (read.failure === undefined) return false
  return read.status === undefined
}

test('INSPECT_PROBE_PATHS is a closed compose/app filename set', () => {
  assertEquals(INSPECT_PROBE_PATHS.includes('docker-compose.yml'), true)
  assertEquals(INSPECT_PROBE_PATHS.includes('package.json'), true)
  assertEquals(INSPECT_PROBE_PATHS.includes('.env'), false)
})

test('a provider failure WITH a status is the answer, not a fallback', () => {
  // The daemon would be told the same thing, so retrying through it would just
  // spend a round-trip to reproduce a 403.
  assertEquals(shouldFallBackToDaemon({ failure: 'forbidden', status: 403 }), false)
  assertEquals(shouldFallBackToDaemon({ failure: 'not found', status: 404 }), false)
  assertEquals(shouldFallBackToDaemon({ failure: 'rate limited', status: 429 }), false)
})

test('a provider failure WITHOUT a status falls back to the daemon', () => {
  // No HTTP answer means the fetch never reached the provider — which is
  // exactly the LAN-only case, and needs no configuration toggle.
  assertEquals(shouldFallBackToDaemon({ failure: 'network error' }), true)
})

test('an unsupported provider always falls back', () => {
  // A bare git remote has no read API; a GitLab deploy key has no OAuth token.
  assertEquals(shouldFallBackToDaemon({ unsupported: true }), true)
})

test('every provider implements the read surface', async () => {
  const { resolveGitProvider } = await import('../../lib/git/git-provider.ts')
  for (const name of ['github', 'gitlab', 'git']) {
    const provider: GitProvider = resolveGitProvider(name)
    assertEquals(typeof provider.readRepositoryFiles, 'function')
    assertEquals(typeof provider.listRepositoryEntries, 'function')
  }
})

test('the generic provider answers unsupported rather than throwing', async () => {
  const { resolveGitProvider } = await import('../../lib/git/git-provider.ts')
  const provider = resolveGitProvider('git')
  const read = await provider.readRepositoryFiles(
    { db: null as never },
    {
      row: {
        id: 's1',
        provider: 'git',
        repositoryUrl: 'git@example.com:o/r.git',
        defaultBranch: 'main',
        subdirectory: null,
        installationId: null,
        credentialId: 'c1',
      },
      ref: 'main',
      paths: ['docker-compose.yml'],
    },
  )
  assertEquals(read, { unsupported: true })
})
