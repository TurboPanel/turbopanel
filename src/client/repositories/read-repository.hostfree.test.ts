/**
 * Host-free coverage for daemon-backed repository reads.
 */

import { assertEquals } from '@std/assert'
import type { DaemonCellRegistry } from '../../daemon/cell/contracts.ts'
import type { Db } from '../../db.ts'
import { createServerPresenceDb } from '../managed/server-status-test-db.ts'
import {
  readRepositoryViaDaemon,
  REPO_READ_TIMEOUT_MS,
  resolveDefaultBranchViaDaemon,
} from './read-repository.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SERVER = 'server-1'
const BASE_PARAMS = {
  organizationId: 'org-1',
  cloneUrl: 'git@example.com:o/r.git',
  ref: 'main',
  paths: ['docker-compose.yml'] as const,
  maxBytesPerFile: 1024,
  serverIds: [SERVER] as const,
}

function registryReturning(
  record: { status: string; result?: unknown; error?: string },
  captured?: { envelope: unknown; timeoutMs: number }[],
): DaemonCellRegistry {
  return {
    getCell: () => ({
      createRequestAndWait: (envelope: unknown, timeoutMs: number) => {
        captured?.push({ envelope, timeoutMs })
        return Promise.resolve(record)
      },
    }),
  } as unknown as DaemonCellRegistry
}

test('REPO_READ_TIMEOUT_MS stays on the interactive 30s budget', () => {
  assertEquals(REPO_READ_TIMEOUT_MS, 30_000)
})

test('readRepositoryViaDaemon fails closed when no server is connected', async () => {
  const outcome = await readRepositoryViaDaemon(
    createServerPresenceDb(SERVER, false),
    registryReturning({ status: 'done', result: { ok: true } }),
    BASE_PARAMS,
  )
  assertEquals(outcome.ok, false)
  if (outcome.ok) throw new TypeError('expected failure')
  assertEquals(outcome.code, 'no_daemon_available')
})

test('readRepositoryViaDaemon maps an expired cell wait to timeout', async () => {
  const outcome = await readRepositoryViaDaemon(
    createServerPresenceDb(SERVER, true),
    registryReturning({ status: 'expired' }),
    BASE_PARAMS,
  )
  assertEquals(outcome, {
    ok: false,
    code: 'timeout',
    message: 'timeout reading repository',
  })
})

test('readRepositoryViaDaemon maps a failed wait, preferring the cell error', async () => {
  const withError = await readRepositoryViaDaemon(
    createServerPresenceDb(SERVER, true),
    registryReturning({ status: 'failed', error: 'clone refused' }),
    BASE_PARAMS,
  )
  assertEquals(withError, {
    ok: false,
    code: 'failed',
    message: 'clone refused',
  })

  const withoutError = await readRepositoryViaDaemon(
    createServerPresenceDb(SERVER, true),
    registryReturning({ status: 'failed' }),
    BASE_PARAMS,
  )
  assertEquals(withoutError, {
    ok: false,
    code: 'failed',
    message: 'failed to read repository',
  })
})

test('readRepositoryViaDaemon rejects a non-object result payload', async () => {
  for (const result of [null, 'oops', 12]) {
    const outcome = await readRepositoryViaDaemon(
      createServerPresenceDb(SERVER, true),
      registryReturning({ status: 'done', result }),
      BASE_PARAMS,
    )
    assertEquals(outcome, {
      ok: false,
      code: 'failed',
      message: 'malformed repository read result',
    })
  }
})

test('readRepositoryViaDaemon surfaces a provider-shaped failure on the daemon lane', async () => {
  const withMessage = await readRepositoryViaDaemon(
    createServerPresenceDb(SERVER, true),
    registryReturning({
      status: 'done',
      result: { ok: false, error: 'ref not found' },
    }),
    BASE_PARAMS,
  )
  assertEquals(withMessage, {
    ok: false,
    code: 'failed',
    message: 'ref not found',
  })

  const withoutMessage = await readRepositoryViaDaemon(
    createServerPresenceDb(SERVER, true),
    registryReturning({ status: 'done', result: { ok: false } }),
    BASE_PARAMS,
  )
  assertEquals(withoutMessage, {
    ok: false,
    code: 'failed',
    message: 'failed to read repository',
  })
})

test('readRepositoryViaDaemon normalizes files, entries, and optional credential fields', async () => {
  const captured: { envelope: unknown; timeoutMs: number }[] = []
  const outcome = await readRepositoryViaDaemon(
    createServerPresenceDb(SERVER, true),
    registryReturning({
      status: 'done',
      result: {
        ok: true,
        commitSha: 'abc123',
        files: [
          { path: 'compose.yaml', found: true, content: 'x: 1', bytes: 4 },
          { path: 'inferred.txt', found: true, content: 'hi' },
          { path: 'big.bin', found: false, reason: 'too_large' },
          { path: 'dir', found: false, reason: 'not_a_file' },
          { path: 'pic.png', found: false, reason: 'binary' },
          { path: 'missing.yml', found: false, reason: 'gone' },
          { path: 12 },
          'skip-me',
          null,
        ],
        entries: [
          { path: 'src', kind: 'dir' },
          { path: 'README.md', kind: 'file', bytes: 12 },
          { path: 'other', kind: 'symlink' },
          { path: 9 },
          null,
        ],
      },
    }, captured),
    {
      ...BASE_PARAMS,
      listPath: '',
      credential: 'token',
      credentialKind: 'token',
      credentialUsername: 'oauth2',
    },
  )

  if (!outcome.ok) throw new TypeError('expected a successful read')
  assertEquals(outcome.commitSha, 'abc123')
  assertEquals(outcome.files, [
    { path: 'compose.yaml', found: true, content: 'x: 1', bytes: 4 },
    { path: 'inferred.txt', found: true, content: 'hi', bytes: 2 },
    { path: 'big.bin', found: false, reason: 'too_large' },
    { path: 'dir', found: false, reason: 'not_a_file' },
    { path: 'pic.png', found: false, reason: 'binary' },
    { path: 'missing.yml', found: false, reason: 'not_found' },
  ])
  assertEquals(outcome.entries, [
    { path: 'src', kind: 'dir' },
    { path: 'README.md', kind: 'file', bytes: 12 },
    { path: 'other', kind: 'file' },
  ])

  const envelope = captured[0]?.envelope as Record<string, unknown>
  assertEquals(captured[0]?.timeoutMs, REPO_READ_TIMEOUT_MS)
  assertEquals(envelope.kind, 'repo-read-request')
  assertEquals(envelope.listPath, '')
  assertEquals(envelope.credential, 'token')
  assertEquals(envelope.credentialKind, 'token')
  assertEquals(envelope.credentialUsername, 'oauth2')
})

test('readRepositoryViaDaemon treats missing files/entries as empty and blanks a non-string sha', async () => {
  const outcome = await readRepositoryViaDaemon(
    createServerPresenceDb(SERVER, true),
    registryReturning({
      status: 'done',
      result: { ok: true, commitSha: 99, files: 'nope', entries: {} },
    }),
    BASE_PARAMS,
  )
  if (!outcome.ok) throw new TypeError('expected a successful read')
  assertEquals(outcome.commitSha, '')
  assertEquals(outcome.files, [])
  assertEquals(outcome.entries, [])
})

test('readRepositoryViaDaemon omits optional credential fields when they are unset', async () => {
  const captured: { envelope: unknown; timeoutMs: number }[] = []
  await readRepositoryViaDaemon(
    createServerPresenceDb(SERVER, true),
    registryReturning({
      status: 'done',
      result: { ok: true, commitSha: 'sha' },
    }, captured),
    BASE_PARAMS,
  )
  const envelope = captured[0]?.envelope as Record<string, unknown>
  assertEquals('listPath' in envelope, false)
  assertEquals('credential' in envelope, false)
  assertEquals('credentialKind' in envelope, false)
  assertEquals('credentialUsername' in envelope, false)
})

test('readRepositoryViaDaemon returns no_daemon_available when the id list is empty', async () => {
  const outcome = await readRepositoryViaDaemon(
    {} as Db,
    registryReturning({ status: 'done' }),
    { ...BASE_PARAMS, serverIds: [] },
  )
  if (outcome.ok) throw new TypeError('expected failure')
  assertEquals(outcome.code, 'no_daemon_available')
})

const BRANCH_PARAMS = {
  organizationId: 'org-1',
  cloneUrl: 'https://example.test/repo.git',
  serverIds: [SERVER] as const,
}

test('resolveDefaultBranchViaDaemon fails closed when no server is connected', async () => {
  const outcome = await resolveDefaultBranchViaDaemon(
    createServerPresenceDb(SERVER, false),
    registryReturning({ status: 'done', result: { ok: true } }),
    BRANCH_PARAMS,
  )
  if (outcome.ok) throw new TypeError('expected failure')
  assertEquals(outcome.code, 'no_daemon_available')
})

test('resolveDefaultBranchViaDaemon maps an expired cell wait to timeout', async () => {
  const outcome = await resolveDefaultBranchViaDaemon(
    createServerPresenceDb(SERVER, true),
    registryReturning({ status: 'expired' }),
    BRANCH_PARAMS,
  )
  assertEquals(outcome, {
    ok: false,
    code: 'timeout',
    message: 'timeout resolving default branch',
  })
})

test('resolveDefaultBranchViaDaemon maps a failed wait, preferring the cell error', async () => {
  const withError = await resolveDefaultBranchViaDaemon(
    createServerPresenceDb(SERVER, true),
    registryReturning({ status: 'failed', error: 'ls-remote refused' }),
    BRANCH_PARAMS,
  )
  assertEquals(withError, {
    ok: false,
    code: 'failed',
    message: 'ls-remote refused',
  })

  const withoutError = await resolveDefaultBranchViaDaemon(
    createServerPresenceDb(SERVER, true),
    registryReturning({ status: 'failed' }),
    BRANCH_PARAMS,
  )
  assertEquals(withoutError, {
    ok: false,
    code: 'failed',
    message: 'failed to resolve default branch',
  })
})

test('resolveDefaultBranchViaDaemon rejects a non-object result payload', async () => {
  for (const result of [null, 'oops', 12]) {
    const outcome = await resolveDefaultBranchViaDaemon(
      createServerPresenceDb(SERVER, true),
      registryReturning({ status: 'done', result }),
      BRANCH_PARAMS,
    )
    assertEquals(outcome, {
      ok: false,
      code: 'failed',
      message: 'malformed default-branch result',
    })
  }
})

test('resolveDefaultBranchViaDaemon surfaces a provider-shaped failure on the daemon lane', async () => {
  const withMessage = await resolveDefaultBranchViaDaemon(
    createServerPresenceDb(SERVER, true),
    registryReturning({
      status: 'done',
      result: { ok: false, error: 'remote unreachable' },
    }),
    BRANCH_PARAMS,
  )
  assertEquals(withMessage, {
    ok: false,
    code: 'failed',
    message: 'remote unreachable',
  })

  const withoutMessage = await resolveDefaultBranchViaDaemon(
    createServerPresenceDb(SERVER, true),
    registryReturning({ status: 'done', result: { ok: false } }),
    BRANCH_PARAMS,
  )
  assertEquals(withoutMessage, {
    ok: false,
    code: 'failed',
    message: 'failed to resolve default branch',
  })
})

test('resolveDefaultBranchViaDaemon reports the branch name and sends no credential', async () => {
  const captured: { envelope: unknown; timeoutMs: number }[] = []
  const outcome = await resolveDefaultBranchViaDaemon(
    createServerPresenceDb(SERVER, true),
    registryReturning({
      status: 'done',
      result: { ok: true, defaultBranch: 'trunk' },
    }, captured),
    BRANCH_PARAMS,
  )
  if (!outcome.ok) throw new TypeError('expected a successful resolve')
  assertEquals(outcome.defaultBranch, 'trunk')

  const envelope = captured[0]?.envelope as Record<string, unknown>
  assertEquals(captured[0]?.timeoutMs, REPO_READ_TIMEOUT_MS)
  assertEquals(envelope.kind, 'repo-default-branch-request')
  assertEquals(envelope.cloneUrl, BRANCH_PARAMS.cloneUrl)
  assertEquals('credential' in envelope, false)
})

test('resolveDefaultBranchViaDaemon treats a non-string defaultBranch as null', async () => {
  const outcome = await resolveDefaultBranchViaDaemon(
    createServerPresenceDb(SERVER, true),
    registryReturning({ status: 'done', result: { ok: true, defaultBranch: null } }),
    BRANCH_PARAMS,
  )
  if (!outcome.ok) throw new TypeError('expected a successful resolve')
  assertEquals(outcome.defaultBranch, null)
})

test('resolveDefaultBranchViaDaemon returns no_daemon_available when the id list is empty', async () => {
  const outcome = await resolveDefaultBranchViaDaemon(
    {} as Db,
    registryReturning({ status: 'done' }),
    { ...BRANCH_PARAMS, serverIds: [] },
  )
  if (outcome.ok) throw new TypeError('expected failure')
  assertEquals(outcome.code, 'no_daemon_available')
})
