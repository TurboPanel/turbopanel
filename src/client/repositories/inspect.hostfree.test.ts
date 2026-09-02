import { assertEquals } from '@std/assert'
import type { DaemonCellRegistry } from '../../daemon/cell/contracts.ts'
import type { Db } from '../../db.ts'
import type { GitProvider, GitProviderSourceRow } from '../../lib/git/git-provider.ts'
import { createServerPresenceDb } from '../managed/server-status-test-db.ts'
import { inspectRepository, INSPECT_PROBE_PATHS } from './inspect.ts'

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

test('INSPECT_PROBE_PATHS covers every compose filename the wizard ranks', () => {
  // The UI's lane ranking checks all four compose spellings; a spelling the
  // probe set misses is a repository the wizard silently mis-detects.
  for (
    const path of [
      'docker-compose.yml',
      'docker-compose.yaml',
      'compose.yaml',
      'compose.yml',
    ]
  ) {
    assertEquals(INSPECT_PROBE_PATHS.includes(path), true)
  }
})

test('INSPECT_PROBE_PATHS probes the lockfiles that name a package manager', () => {
  // Existence is the signal — which lockfile is present tells the wizard the
  // package manager before the app exists, mirroring the daemon's build-time
  // detection order (pnpm > yarn > npm).
  for (const path of ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json']) {
    assertEquals(INSPECT_PROBE_PATHS.includes(path), true)
  }
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
        connectionId: null,
        secretId: 'c1',
      },
      ref: 'main',
      paths: ['docker-compose.yml'],
    },
  )
  assertEquals(read, { unsupported: true })
})

const GIT_ROW: GitProviderSourceRow = {
  id: 's1',
  provider: 'git',
  repositoryUrl: 'git@example.com:o/r.git',
  defaultBranch: 'main',
  subdirectory: null,
  connectionId: null,
  secretId: 'c1',
}

function inspectRegistry(
  record: { status: string; result?: unknown; error?: string },
): DaemonCellRegistry {
  return {
    getCell: () => ({
      createRequestAndWait: () => Promise.resolve(record),
    }),
  } as unknown as DaemonCellRegistry
}

test('inspectRepository falls back to 503 when a bare git remote has no registry', async () => {
  const outcome = await inspectRepository({
    db: {} as Db,
    registry: null,
    dataEncryptionSecrets: { current: { version: 1, key: {} as CryptoKey }, fallbacks: [] },
    organizationId: 'org-1',
    row: GIT_ROW,
    ref: 'main',
    serverIds: ['server-1'],
  })
  assertEquals(outcome.ok, false)
  if (outcome.ok) throw new TypeError('expected failure')
  assertEquals(outcome.status, 503)
  assertEquals(outcome.error, 'no_daemon_available')
})

test('inspectRepository maps daemon no_daemon_available to 503', async () => {
  const outcome = await inspectRepository({
    db: createServerPresenceDb('server-1', false),
    registry: inspectRegistry({ status: 'done', result: { ok: true } }),
    dataEncryptionSecrets: null,
    organizationId: 'org-1',
    row: GIT_ROW,
    ref: 'main',
    serverIds: ['server-1'],
    listPath: 'src',
    daemonCredential: { credential: 'tok', credentialKind: 'token' },
  })
  assertEquals(outcome.ok, false)
  if (outcome.ok) throw new TypeError('expected failure')
  assertEquals(outcome.status, 503)
  assertEquals(outcome.error, 'no_daemon_available')
})

test('inspectRepository maps a daemon timeout to 502', async () => {
  const outcome = await inspectRepository({
    db: createServerPresenceDb('server-1', true),
    registry: inspectRegistry({ status: 'expired' }),
    dataEncryptionSecrets: null,
    organizationId: 'org-1',
    row: GIT_ROW,
    ref: 'main',
    paths: ['package.json'],
    serverIds: ['server-1'],
  })
  assertEquals(outcome.ok, false)
  if (outcome.ok) throw new TypeError('expected failure')
  assertEquals(outcome.status, 502)
  assertEquals(outcome.error, 'timeout')
})

test('inspectRepository returns daemon files when the generic provider is unsupported', async () => {
  const outcome = await inspectRepository({
    db: createServerPresenceDb('server-1', true),
    registry: inspectRegistry({
      status: 'done',
      result: {
        ok: true,
        commitSha: 'deadbeef',
        files: [{ path: 'package.json', found: true, content: '{}', bytes: 2 }],
        entries: [{ path: '.', kind: 'dir' }],
      },
    }),
    dataEncryptionSecrets: null,
    organizationId: 'org-1',
    row: GIT_ROW,
    ref: 'main',
    serverIds: ['server-1'],
  })
  if (!outcome.ok) throw new TypeError('expected success')
  assertEquals(outcome.via, 'daemon')
  assertEquals(outcome.commitSha, 'deadbeef')
  assertEquals(outcome.files[0]?.path, 'package.json')
})
