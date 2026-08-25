import { assertEquals } from '@std/assert'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import {
  assertProviderAuthShape,
  parseSourceCreateBody,
  parseSourceListFilter,
  parseSourcePatchBody,
  serializeInstallationRow,
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

const INSTALL_ID = '550e8400-e29b-41d4-a716-446655440000'
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
    assertProviderAuthShape('github', INSTALL_ID, CREDENTIAL_ID),
    'source_credential_not_supported',
  )
  assertEquals(assertProviderAuthShape('github', INSTALL_ID, null), null)

  assertEquals(
    assertProviderAuthShape('gitlab', null, null),
    'source_installation_required',
  )
  assertEquals(
    assertProviderAuthShape('gitlab', INSTALL_ID, CREDENTIAL_ID),
    'source_auth_ambiguous',
  )
  assertEquals(assertProviderAuthShape('gitlab', INSTALL_ID, null), null)
  assertEquals(assertProviderAuthShape('gitlab', null, CREDENTIAL_ID), null)

  assertEquals(
    assertProviderAuthShape('git', INSTALL_ID, null),
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

test('parseSourceCreateBody defaults github + disabled and rejects bad pairs', async () => {
  const c = mockContext()
  const created = parseSourceCreateBody(c, {
    installationId: INSTALL_ID,
    repositoryUrl: 'https://github.com/org/repo.git',
  })
  if (created instanceof Response) {
    throw new TypeError('expected create fields')
  }
  assertEquals(created.provider, 'github')
  assertEquals(created.autoDeploy, 'disabled')
  assertEquals(created.installationId, INSTALL_ID)
  assertEquals(created.repositoryUrl, 'https://github.com/org/repo.git')

  await expectErrorResponse(
    parseSourceCreateBody(c, {
      provider: 'not-a-provider',
      repositoryUrl: 'https://github.com/org/repo.git',
    }),
    400,
    'Invalid request',
  )
  await expectErrorResponse(
    parseSourceCreateBody(c, {
      provider: 'github',
      installationId: INSTALL_ID,
      serviceId: SERVICE_ID,
      environmentId: ENV_ID,
      repositoryUrl: 'https://github.com/org/repo.git',
    }),
    400,
    'source_single_parent_required',
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
      installationId: INSTALL_ID,
      repositoryUrl: 12,
    }),
    400,
    'Invalid request',
  )
  await expectErrorResponse(
    parseSourceCreateBody(c, {
      provider: 'github',
      installationId: 'not-a-uuid',
      repositoryUrl: 'https://github.com/org/repo.git',
    }),
    400,
    'Invalid request',
  )
  await expectErrorResponse(
    parseSourceCreateBody(c, {
      provider: 'github',
      installationId: INSTALL_ID,
      repositoryUrl: 'https://github.com/org/repo.git',
      subdirectory: '../escape',
    }),
    400,
    'Invalid request',
  )
  await expectErrorResponse(
    parseSourceCreateBody(c, {
      provider: 'github',
      installationId: INSTALL_ID,
      repositoryUrl: 'https://github.com/org/repo.git',
      autoDeploy: 'whenever',
    }),
    400,
    'Invalid request',
  )
  await expectErrorResponse(
    parseSourceCreateBody(c, {
      provider: 'github',
      installationId: INSTALL_ID,
      repositoryUrl: 'https://github.com/org/repo.git',
      metadata: ['not-jsonb'],
    }),
    400,
    'Invalid request',
  )

  const withParent = parseSourceCreateBody(c, {
    provider: 'git',
    credentialId: CREDENTIAL_ID,
    serviceId: SERVICE_ID,
    repositoryUrl: 'git@git.example:org/repo.git',
    defaultBranch: 'trunk',
    subdirectory: 'apps/web',
    autoDeploy: 'immediate',
    metadata: { note: 'ops' },
    options: { pendingChecks: null },
  })
  if (withParent instanceof Response) {
    throw new TypeError('expected git create fields')
  }
  assertEquals(withParent.provider, 'git')
  assertEquals(withParent.credentialId, CREDENTIAL_ID)
  assertEquals(withParent.serviceId, SERVICE_ID)
  assertEquals(withParent.defaultBranch, 'trunk')
  assertEquals(withParent.subdirectory, 'apps/web')
  assertEquals(withParent.autoDeploy, 'immediate')
})

test('parseSourcePatchBody rejects immutable scope and rechecks auth + URL', async () => {
  const c = mockContext()
  const existing = {
    provider: 'github' as const,
    installationId: INSTALL_ID,
    credentialId: null,
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
    parseSourcePatchBody(c, { installationId: 'bad' }, existing),
    400,
    'Invalid request',
  )
  await expectErrorResponse(
    parseSourcePatchBody(c, { installationId: null }, existing),
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
    installationId: null,
    credentialId: CREDENTIAL_ID,
    repositoryUrl: 'git@git.example:org/repo.git',
  }
  await expectErrorResponse(
    parseSourcePatchBody(c, { credentialId: null }, gitExisting),
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

test('parseSourceListFilter accepts at most one UUID scope', async () => {
  const empty = parseSourceListFilter(mockContext())
  if (empty instanceof Response) {
    throw new TypeError('expected empty filter')
  }
  assertEquals(empty, {})

  const byService = parseSourceListFilter(mockContext({ serviceId: SERVICE_ID }))
  if (byService instanceof Response) {
    throw new TypeError('expected service filter')
  }
  assertEquals(byService, { serviceId: SERVICE_ID })

  const byEnv = parseSourceListFilter(mockContext({ environmentId: ENV_ID }))
  if (byEnv instanceof Response) {
    throw new TypeError('expected environment filter')
  }
  assertEquals(byEnv, { environmentId: ENV_ID })

  await expectErrorResponse(
    parseSourceListFilter(
      mockContext({ serviceId: SERVICE_ID, environmentId: ENV_ID }),
    ),
    400,
    'Invalid request',
  )
  await expectErrorResponse(
    parseSourceListFilter(mockContext({ serviceId: 'not-a-uuid' })),
    400,
    'Invalid request',
  )
  await expectErrorResponse(
    parseSourceListFilter(mockContext({ environmentId: 'not-a-uuid' })),
    400,
    'Invalid request',
  )
})

test('serializeSourceRow and serializeInstallationRow fold optional facts', () => {
  const row: SourceRowLike = {
    id: SERVICE_ID,
    organizationId: INSTALL_ID,
    installationId: INSTALL_ID,
    serviceId: null,
    environmentId: ENV_ID,
    credentialId: null,
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
    serializeInstallationRow({
      id: INSTALL_ID,
      organizationId: INSTALL_ID,
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
    serializeInstallationRow({
      id: INSTALL_ID,
      organizationId: INSTALL_ID,
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
