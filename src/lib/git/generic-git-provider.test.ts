import { assertEquals } from '@std/assert'
import { genericGitProvider } from './generic-git-provider.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SHA = 'a'.repeat(40)
const ctx = { db: null as never }
const row = {
  id: 'src-1',
  provider: 'git' as const,
  repositoryUrl: 'git@github.com:org/app.git',
  defaultBranch: 'main',
  subdirectory: null,
  installationId: null,
  credentialId: 'cred-1',
}

test('generic git lists no repositories and rejects webhooks', async () => {
  assertEquals(
    await genericGitProvider.listRepositories(ctx, 'ignored'),
    [],
  )
  assertEquals(
    await genericGitProvider.verifyWebhook('secret', new Uint8Array(), {
      get: () => null,
    }),
    false,
  )
  assertEquals(genericGitProvider.parsePush({}), null)
  assertEquals(genericGitProvider.parseCheck('push', {}), null)
})

test('generic git prepareClone passes through the ref or pinned SHA', async () => {
  assertEquals(
    await genericGitProvider.prepareClone(ctx, {
      row,
      ref: 'main',
      needsCredential: true,
    }),
    { commit: { commitSha: 'main' } },
  )
  assertEquals(
    await genericGitProvider.prepareClone(ctx, {
      row,
      ref: 'main',
      needsCredential: true,
      requestedCommitSha: SHA,
    }),
    { commit: { commitSha: SHA } },
  )
})

test('generic git repository reads are unsupported', async () => {
  assertEquals(
    await genericGitProvider.readRepositoryFiles(ctx, {
      row,
      ref: 'main',
      paths: ['README.md'],
    }),
    { unsupported: true },
  )
  assertEquals(
    await genericGitProvider.listRepositoryEntries(ctx, {
      row,
      ref: 'main',
      path: '',
    }),
    { unsupported: true },
  )
})
