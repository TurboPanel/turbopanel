import { assertEquals } from '@std/assert'
import {
  GITLAB_OAUTH_HTTPS_USERNAME,
  gitlabProvider,
  gitlabRepositoryExternalId,
  parseGitlabInstallationEvent,
  parseGitlabPipeline,
  parseGitlabPush,
} from './gitlab-provider.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SHA = 'a'.repeat(40)
const NULL_SHA = '0'.repeat(40)

function pushPayload(overrides: Record<string, unknown> = {}) {
  return {
    object_kind: 'push',
    ref: 'refs/heads/main',
    before: 'b'.repeat(40),
    after: SHA,
    checkout_sha: SHA,
    project_id: 15,
    project: { id: 15, path_with_namespace: 'group/app' },
    ...overrides,
  }
}

test('parseGitlabPush reads the branch, head sha, and project', () => {
  assertEquals(parseGitlabPush(pushPayload()), {
    externalInstallationId: null,
    repositoryExternalId: '15',
    ref: 'refs/heads/main',
    branch: 'main',
    commitSha: SHA,
    deleted: false,
  })
})

test('a GitLab push names no connection — every live one is a candidate', () => {
  // GitLab's payload identifies the project, never the OAuth connection the
  // operator registered it under, so the resolver must widen rather than guess.
  assertEquals(parseGitlabPush(pushPayload())?.externalInstallationId, null)
})

test('a branch delete carries no head and is reported as deleted', () => {
  const deleted = parseGitlabPush(
    pushPayload({ after: NULL_SHA, checkout_sha: null }),
  )
  assertEquals(deleted?.deleted, true)
  assertEquals(deleted?.commitSha, null)
})

test('a tag push and a non-branch ref are not push triggers', () => {
  assertEquals(parseGitlabPush(pushPayload({ ref: 'refs/tags/v1' })), null)
  assertEquals(
    parseGitlabPush(pushPayload({ object_kind: 'tag_push' })),
    null,
  )
})

test('a push with no identifiable project is dropped', () => {
  assertEquals(
    parseGitlabPush(pushPayload({ project_id: undefined, project: {} })),
    null,
  )
})

test('parseGitlabPipeline releases only a succeeded pipeline', () => {
  const base = {
    object_kind: 'pipeline',
    project: { id: 15, path_with_namespace: 'group/app' },
  }
  assertEquals(
    parseGitlabPipeline({
      ...base,
      object_attributes: { id: 31, ref: 'main', sha: SHA, status: 'success' },
    }),
    { externalInstallationId: null, repositoryExternalId: '15', commitSha: SHA },
  )
  // Anything short of a finished green pipeline is not an all-checks-green
  // signal, which is the whole point of `autoDeploy: 'checks_passed'`.
  for (const status of ['running', 'failed', 'pending', 'canceled']) {
    assertEquals(
      parseGitlabPipeline({
        ...base,
        object_attributes: { sha: SHA, status },
      }),
      null,
    )
  }
})

test('a job hook is never a release signal', () => {
  // One job finishing green says nothing about the rest of the pipeline.
  assertEquals(
    parseGitlabPipeline({
      object_kind: 'build',
      build_status: 'success',
      sha: SHA,
      project: { id: 15 },
    }),
    null,
  )
})

test('gitlabRepositoryExternalId reads either shape GitLab sends', () => {
  assertEquals(gitlabRepositoryExternalId({ project_id: 15 }), '15')
  assertEquals(gitlabRepositoryExternalId({ project: { id: 15 } }), '15')
  assertEquals(gitlabRepositoryExternalId({ project: {} }), null)
})

test('parseGitlabInstallationEvent is always null', () => {
  assertEquals(parseGitlabInstallationEvent({}), null)
})

test('gitlab prepareClone preview and deploy-key lanes', async () => {
  const ctx = { db: null as never }
  const row = {
    id: 'src-1',
    provider: 'gitlab' as const,
    repositoryUrl: 'https://gitlab.com/group/app.git',
    defaultBranch: 'main',
    subdirectory: null,
    installationId: null,
    credentialId: 'cred-1',
  }

  assertEquals(
    await gitlabProvider.prepareClone(ctx, {
      row,
      ref: 'main',
      needsCredential: false,
      requestedCommitSha: SHA,
    }),
    { commit: { commitSha: SHA } },
  )

  assertEquals(
    await gitlabProvider.prepareClone(ctx, {
      row,
      ref: 'main',
      needsCredential: true,
    }),
    { commit: { commitSha: 'main' } },
  )

  assertEquals(
    await gitlabProvider.prepareClone(ctx, {
      row: { ...row, credentialId: null },
      ref: 'main',
      needsCredential: true,
    }),
    { failure: 'gitlab source has neither an oauth connection nor a deploy key' },
  )
})

test('gitlab oauth username is the documented basic-auth user', () => {
  assertEquals(GITLAB_OAUTH_HTTPS_USERNAME, 'oauth2')
})
