import { assertEquals } from '@std/assert'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import {
  assertProviderAuthShape,
  parseSourceCreateBody,
  parseSourcePatchBody,
  parseSourceAttachBody,
  readSourceMetadata,
  serializeConnectionRow,
  serializeSourceRow,
  SOURCE_REFERENCED_BY_COMPOSE_ERROR,
  validateRepositoryUrl,
  type SourceRowLike,
} from './routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const CONNECTION_ID = '550e8400-e29b-41d4-a716-446655440000'
const APP_ID = '11111111-1111-4111-8111-111111111111'
const CREDENTIAL_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const SERVICE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const ENV_ID = '11111111-2222-4333-8444-555555555555'

function mockContext(query: Record<string, string> = {}): Context<AppEnv> {
  return {
    req: {
      query(key: string) {
        return query[key]
      },
    },
    json(body: unknown, status?: number) {
      return Response.json(body, { status })
    },
  } as unknown as Context<AppEnv>
}

async function expectErrorResponse(
  response: Response | Record<string, unknown>,
  status: number,
  error: string,
): Promise<void> {
  if (!(response instanceof Response)) {
    throw new TypeError('expected error response')
  }
  assertEquals(response.status, status)
  assertEquals(await response.json(), { error })
}

test('assertProviderAuthShape enforces mutually exclusive clone lanes', () => {
  assertEquals(
    assertProviderAuthShape('github', null, null),
    'source_installation_required',
  )
  assertEquals(
    assertProviderAuthShape('github', CONNECTION_ID, CREDENTIAL_ID),
    'source_credential_not_supported',
  )
  assertEquals(assertProviderAuthShape('github', CONNECTION_ID, null), null)

  assertEquals(
    assertProviderAuthShape('gitlab', null, null),
    'source_installation_required',
  )
  assertEquals(
    assertProviderAuthShape('gitlab', CONNECTION_ID, CREDENTIAL_ID),
    'source_auth_ambiguous',
  )
  assertEquals(assertProviderAuthShape('gitlab', CONNECTION_ID, null), null)
  assertEquals(assertProviderAuthShape('gitlab', null, CREDENTIAL_ID), null)

  assertEquals(
    assertProviderAuthShape('git', CONNECTION_ID, null),
    'source_installation_not_supported',
  )
  assertEquals(assertProviderAuthShape('git', null, CREDENTIAL_ID), null)
  assertEquals(assertProviderAuthShape('git', null, null), null)
})

test('validateRepositoryUrl accepts https and SSH only on credential lanes', () => {
  assertEquals(
    validateRepositoryUrl('github', 'https://github.com/org/repo.git', null),
    { ok: true, url: 'https://github.com/org/repo.git' },
  )
  assertEquals(
    validateRepositoryUrl('github', 'git@github.com:org/repo.git', null),
    { ok: false, error: 'source_repository_url_must_be_https' },
  )
  assertEquals(
    validateRepositoryUrl('github', 'https://user@github.com/org/repo.git', null),
    { ok: false, error: 'source_repository_url_invalid' },
  )
  assertEquals(
    validateRepositoryUrl('git', 'git@git.example:org/repo.git', null),
    { ok: false, error: 'source_ssh_requires_credential' },
  )
  assertEquals(
    validateRepositoryUrl('git', 'git@git.example:org/repo.git', CREDENTIAL_ID),
    { ok: true, url: 'git@git.example:org/repo.git' },
  )
  assertEquals(
    validateRepositoryUrl(
      'gitlab',
      'ssh://git@gitlab.example/org/repo.git',
      CREDENTIAL_ID,
    ),
    { ok: true, url: 'ssh://git@gitlab.example/org/repo.git' },
  )
  assertEquals(
    validateRepositoryUrl('git', 'not-a-url', CREDENTIAL_ID),
    { ok: false, error: 'source_repository_url_invalid' },
  )
  assertEquals(
    validateRepositoryUrl('github', '', null),
    { ok: false, error: 'source_repository_url_invalid' },
  )
})

test('validateRepositoryUrl returns the canonical .git spelling', () => {
  // The accepted URL is what the per-organization unique index dedupes on, so
  // every spelling of one repository must leave here identical.
  assertEquals(
    validateRepositoryUrl('github', 'https://GitHub.com/org/repo', null),
    { ok: true, url: 'https://github.com/org/repo.git' },
  )
  assertEquals(
    validateRepositoryUrl('github', 'https://github.com/org/repo/', null),
    { ok: true, url: 'https://github.com/org/repo.git' },
  )
  assertEquals(
    validateRepositoryUrl('git', 'git@Git.Example:org/repo', CREDENTIAL_ID),
    { ok: true, url: 'git@git.example:org/repo.git' },
  )
  assertEquals(
    validateRepositoryUrl(
      'gitlab',
      'ssh://git@gitlab.example/org/repo',
      CREDENTIAL_ID,
    ),
    { ok: true, url: 'ssh://git@gitlab.example/org/repo.git' },
  )
})

test('parseSourceCreateBody defaults github + disabled and rejects bad pairs', async () => {
  const c = mockContext()
  const created = parseSourceCreateBody(c, {
    connectionId: CONNECTION_ID,
    repositoryUrl: 'https://github.com/org/repo.git',
  })
  if (created instanceof Response) {
    throw new TypeError('expected create fields')
  }
  assertEquals(created.provider, 'github')
  assertEquals(created.autoDeploy, 'disabled')
  assertEquals(created.connectionId, CONNECTION_ID)
  assertEquals(created.repositoryUrl, 'https://github.com/org/repo.git')

  await expectErrorResponse(
    parseSourceCreateBody(c, {
      provider: 'not-a-provider',
      repositoryUrl: 'https://github.com/org/repo.git',
    }),
    400,
    'Invalid request',
  )
  // The parent-scope columns are gone; a caller still naming them learns at
  // the write boundary instead of being silently ignored.
  await expectErrorResponse(
    parseSourceCreateBody(c, {
      provider: 'github',
      connectionId: CONNECTION_ID,
      serviceId: SERVICE_ID,
      repositoryUrl: 'https://github.com/org/repo.git',
    }),
    400,
    'source_scope_not_supported',
  )
  await expectErrorResponse(
    parseSourceCreateBody(c, {
      provider: 'github',
      connectionId: CONNECTION_ID,
      environmentId: ENV_ID,
      repositoryUrl: 'https://github.com/org/repo.git',
    }),
    400,
    'source_scope_not_supported',
  )
  await expectErrorResponse(
    parseSourceCreateBody(c, {
      provider: 'github',
      repositoryUrl: 'https://github.com/org/repo.git',
    }),
    400,
    'source_installation_required',
  )
  await expectErrorResponse(
    parseSourceCreateBody(c, {
      provider: 'github',
      connectionId: CONNECTION_ID,
      repositoryUrl: 12,
    }),
    400,
    'Invalid request',
  )
  await expectErrorResponse(
    parseSourceCreateBody(c, {
      provider: 'github',
      connectionId: 'not-a-uuid',
      repositoryUrl: 'https://github.com/org/repo.git',
    }),
    400,
    'Invalid request',
  )
  await expectErrorResponse(
    parseSourceCreateBody(c, {
      provider: 'github',
      connectionId: CONNECTION_ID,
      repositoryUrl: 'https://github.com/org/repo.git',
      subdirectory: '../escape',
    }),
    400,
    'Invalid request',
  )
  await expectErrorResponse(
    parseSourceCreateBody(c, {
      provider: 'github',
      connectionId: CONNECTION_ID,
      repositoryUrl: 'https://github.com/org/repo.git',
      autoDeploy: 'whenever',
    }),
    400,
    'Invalid request',
  )
  await expectErrorResponse(
    parseSourceCreateBody(c, {
      provider: 'github',
      connectionId: CONNECTION_ID,
      repositoryUrl: 'https://github.com/org/repo.git',
      metadata: ['not-jsonb'],
    }),
    400,
    'Invalid request',
  )

  const withKey = parseSourceCreateBody(c, {
    provider: 'git',
    secretId: CREDENTIAL_ID,
    repositoryUrl: 'git@git.example:org/repo.git',
    defaultBranch: 'trunk',
    subdirectory: 'apps/web',
    autoDeploy: 'immediate',
    metadata: { note: 'ops' },
    options: { pendingChecks: null },
  })
  if (withKey instanceof Response) {
    throw new TypeError('expected git create fields')
  }
  assertEquals(withKey.provider, 'git')
  assertEquals(withKey.secretId, CREDENTIAL_ID)
  assertEquals(withKey.defaultBranch, 'trunk')
  assertEquals(withKey.subdirectory, 'apps/web')
  assertEquals(withKey.autoDeploy, 'immediate')
})

test('parseSourcePatchBody rejects immutable scope and rechecks auth + URL', async () => {
  const c = mockContext()
  const existing = {
    provider: 'github' as const,
    connectionId: CONNECTION_ID,
    secretId: null,
    repositoryUrl: 'https://github.com/org/repo.git',
  }

  await expectErrorResponse(
    parseSourcePatchBody(c, { provider: 'gitlab' }, existing),
    400,
    'source_scope_immutable',
  )
  await expectErrorResponse(
    parseSourcePatchBody(c, { serviceId: SERVICE_ID }, existing),
    400,
    'source_scope_immutable',
  )
  await expectErrorResponse(
    parseSourcePatchBody(c, { connectionId: 'bad' }, existing),
    400,
    'Invalid request',
  )
  await expectErrorResponse(
    parseSourcePatchBody(c, { connectionId: null }, existing),
    400,
    'source_installation_required',
  )
  await expectErrorResponse(
    parseSourcePatchBody(
      c,
      { repositoryUrl: 'git@github.com:org/repo.git' },
      existing,
    ),
    400,
    'source_repository_url_must_be_https',
  )
  await expectErrorResponse(
    parseSourcePatchBody(c, { autoDeploy: 'nope' }, existing),
    400,
    'Invalid request',
  )

  const patched = parseSourcePatchBody(
    c,
    { autoDeploy: 'checks_passed', defaultBranch: 'main' },
    existing,
  )
  if (patched instanceof Response) {
    throw new TypeError('expected patch fields')
  }
  assertEquals(patched.autoDeploy, 'checks_passed')
  assertEquals(patched.defaultBranch, 'main')
  assertEquals(typeof patched.updatedAt, 'string')

  const gitExisting = {
    provider: 'git' as const,
    connectionId: null,
    secretId: CREDENTIAL_ID,
    repositoryUrl: 'git@git.example:org/repo.git',
  }
  await expectErrorResponse(
    parseSourcePatchBody(c, { secretId: null }, gitExisting),
    400,
    'source_ssh_requires_credential',
  )
  await expectErrorResponse(
    parseSourcePatchBody(c, { repositoryUrl: 9 }, gitExisting),
    400,
    'Invalid request',
  )

  const urlPatched = parseSourcePatchBody(
    c,
    { repositoryUrl: 'https://git.example/org/repo.git' },
    gitExisting,
  )
  if (urlPatched instanceof Response) {
    throw new TypeError('expected url patch fields')
  }
  assertEquals(urlPatched.repositoryUrl, 'https://git.example/org/repo.git')
})

test('readSourceMetadata copies objects and resets everything else', () => {
  const stored = { detectedDefaultBranch: 'trunk' }
  const copy = readSourceMetadata(stored)
  assertEquals(copy, stored)
  copy.defaultBranchCheckedAt = 'now'
  // A copy, not the stored reference — mutating it must not touch the row.
  assertEquals('defaultBranchCheckedAt' in stored, false)

  assertEquals(readSourceMetadata(null), {})
  assertEquals(readSourceMetadata(undefined), {})
  assertEquals(readSourceMetadata('not-an-object'), {})
  assertEquals(readSourceMetadata(['not', 'a', 'record']), {})
})

test('serializeSourceRow and serializeConnectionRow fold optional facts', () => {
  const row: SourceRowLike = {
    id: SERVICE_ID,
    organizationId: CONNECTION_ID,
    connectionId: CONNECTION_ID,
    secretId: null,
    provider: 'github',
    repositoryUrl: 'https://github.com/org/repo.git',
    repositoryExternalId: '42',
    defaultBranch: 'trunk',
    subdirectory: null,
    autoDeploy: 'disabled',
    metadata: undefined,
    options: undefined,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  }
  assertEquals(serializeSourceRow(row).metadata, null)
  assertEquals(serializeSourceRow(row).options, null)
  assertEquals(
    serializeSourceRow(row, {
      webhookUrl: 'https://panel.example.com/hooks/github',
      webhookReachable: false,
      reachabilityNote: 'LAN-only',
    }).reachabilityNote,
    'LAN-only',
  )
  assertEquals(SOURCE_REFERENCED_BY_COMPOSE_ERROR, 'source_referenced_by_compose')

  assertEquals(
    serializeConnectionRow({
      id: CONNECTION_ID,
      organizationId: CONNECTION_ID,
      forgeId: APP_ID,
      provider: 'github',
      externalInstallationId: '99',
      accountLogin: 'acme',
      accountType: 'Organization',
      suspendedAt: '2026-01-03T00:00:00.000Z',
      metadata: undefined,
      options: { extra: true },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    }).suspended,
    true,
  )
  assertEquals(
    serializeConnectionRow({
      id: CONNECTION_ID,
      organizationId: CONNECTION_ID,
      forgeId: APP_ID,
      provider: 'gitlab',
      externalInstallationId: '1',
      accountLogin: null,
      accountType: null,
      suspendedAt: null,
      metadata: { ok: true },
      options: undefined,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    }).suspended,
    false,
  )
})

test('attach accepts only what a repository pick can name', () => {
  const parsed = parseSourceAttachBody({
    connectionId: CONNECTION_ID,
    repositoryExternalId: '  99  ',
    repositoryUrl: ' https://github.com/acme/app.git ',
    defaultBranch: ' trunk ',
  })
  assertEquals(parsed, {
    connectionId: CONNECTION_ID,
    repositoryExternalId: '99',
    repositoryUrl: 'https://github.com/acme/app.git',
    defaultBranch: 'trunk',
  })

  // The attach lane canonicalizes like the create lane, so both dedupe on the
  // same stored spelling.
  assertEquals(
    parseSourceAttachBody({
      connectionId: CONNECTION_ID,
      repositoryExternalId: '99',
      repositoryUrl: 'https://GitHub.com/acme/app/',
    })?.repositoryUrl,
    'https://github.com/acme/app.git',
  )

  // An omitted or blank branch means "the repository's own default", which is
  // null on the row rather than an empty string.
  assertEquals(
    parseSourceAttachBody({
      connectionId: CONNECTION_ID,
      repositoryExternalId: '99',
      repositoryUrl: 'https://github.com/acme/app.git',
    })?.defaultBranch,
    null,
  )
  assertEquals(
    parseSourceAttachBody({
      connectionId: CONNECTION_ID,
      repositoryExternalId: '99',
      repositoryUrl: 'https://github.com/acme/app.git',
      defaultBranch: '   ',
    })?.defaultBranch,
    null,
  )
})

test('attach refuses the fields that make a source a managed thing', () => {
  // Attaching is implicit and repeatable, so it must not be able to set the
  // parent scope, the auto-deploy policy, or a deploy-key credential — the
  // second attach of a repository would otherwise differ from the first.
  const parsed = parseSourceAttachBody({
    connectionId: CONNECTION_ID,
    repositoryExternalId: '99',
    repositoryUrl: 'https://github.com/acme/app.git',
    serviceId: SERVICE_ID,
    autoDeploy: 'immediate',
    secretId: CONNECTION_ID,
  })
  assertEquals(parsed !== null, true)
  for (const key of ['serviceId', 'autoDeploy', 'secretId', 'environmentId']) {
    assertEquals(parsed !== null && key in parsed, false, `${key} must not survive`)
  }
})

test('attach rejects a malformed body', () => {
  assertEquals(parseSourceAttachBody(null), null)
  assertEquals(parseSourceAttachBody([]), null)
  // The installation is a uuid we are about to authorize against; a non-uuid
  // is a bad request, not a 404 lookup.
  assertEquals(
    parseSourceAttachBody({
      connectionId: 'not-a-uuid',
      repositoryExternalId: '99',
      repositoryUrl: 'https://github.com/acme/app.git',
    }),
    null,
  )
  // The provider-side id is what webhook matching keys on, so a blank one
  // would make the row unroutable.
  assertEquals(
    parseSourceAttachBody({
      connectionId: CONNECTION_ID,
      repositoryExternalId: '   ',
      repositoryUrl: 'https://github.com/acme/app.git',
    }),
    null,
  )
  assertEquals(
    parseSourceAttachBody({
      connectionId: CONNECTION_ID,
      repositoryExternalId: '99',
      repositoryUrl: '',
    }),
    null,
  )
  assertEquals(
    parseSourceAttachBody({
      connectionId: CONNECTION_ID,
      repositoryExternalId: '99',
      repositoryUrl: 'https://github.com/acme/app.git',
      defaultBranch: 42,
    }),
    null,
  )
})
