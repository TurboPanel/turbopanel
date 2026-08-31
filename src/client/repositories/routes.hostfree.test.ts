/**
 * Host-free coverage for source route helpers and request short-circuits.
 */

import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from '../authn/crypto.ts'
import {
  deriveEncryptionSecretsConfig,
  deriveSecretsConfig,
} from '../authn/secrets.ts'
import type { Db } from '../../db.ts'
import { GithubAppTokenError } from '../../lib/git/github-app-token.ts'
import { GitlabApiError } from '../../lib/git/gitlab-api.ts'
import { GitlabOauthTokenError } from '../../lib/git/gitlab-oauth-token.ts'
import { CLIENT_API_PREFIX } from '../../surfaces.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { providerInstallUiReturnPath } from '../forges/routes-helpers.ts'
import {
  signGithubInstallState,
  signGitlabConnectState,
} from './provider-install-state.ts'
import {
  GIT_DEPLOY_KEY_CREDENTIAL_PROVIDER,
  SOURCE_REFERENCED_BY_COMPOSE_ERROR,
} from './routes-helpers.ts'
import {
  assertSecretInOrganization,
  assertConnectionInOrganization,
  assertConnectionUnclaimed,
  assertScopeInOrganization,
  composeReferencesRepository,
  fetchInstallationAccount,
  findAttachedSource,
  isUniqueViolation,
  providerErrorResponse,
  redirectToForgeUi,
  registerRepositoryRoutes,
  resolveConnectApp,
  resolveGitlabRedirectUri,
  resolveProviderCallbackSession,
  resolveSourceSession,
  resolveSourceWebhookInfo,
} from './routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORG_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_ORG = '22222222-2222-4222-8222-222222222222'
const APP_ID = '33333333-3333-4333-8333-333333333333'
const CONNECTION_ID = '44444444-4444-4444-8444-444444444444'
const CREDENTIAL_ID = '55555555-5555-4555-8555-555555555555'
const SOURCE_ID = '66666666-6666-4666-8666-666666666666'
const SERVICE_ID = '77777777-7777-4777-8777-777777777777'
const USER_ID = '88888888-8888-4888-8888-888888888888'

type MockContextOptions = {
  db?: Db
  session?: { userId: string }
  query?: Record<string, string>
  header?: Record<string, string>
}

function mockContext(options: MockContextOptions = {}): Context<AppEnv> {
  const store = new Map<string, unknown>()
  if (options.db !== undefined) store.set('db', options.db)
  if (options.session !== undefined) store.set('session', options.session)

  return {
    get: (key: string) => store.get(key),
    json: (body: unknown, status?: number) => Response.json(body, { status }),
    redirect: (url: string, status?: number) =>
      new Response(null, { status: status ?? 302, headers: { Location: url } }),
    req: {
      query: (key: string) => options.query?.[key],
      header: (key: string) => {
        if (!options.header) return undefined
        const found = Object.entries(options.header).find(
          ([name]) => name.toLowerCase() === key.toLowerCase(),
        )
        return found?.[1]
      },
    },
  } as unknown as Context<AppEnv>
}

function selectLimitDb(rows: unknown[]): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(rows),
          orderBy: () => Promise.resolve(rows),
        }),
        innerJoin: () => ({
          where: () => ({
            limit: () => Promise.resolve(rows),
          }),
        }),
      }),
    }),
    execute: () => Promise.resolve(rows),
  } as unknown as Db
}

function selectLimitSequence(steps: unknown[][]): Db {
  let index = 0
  const next = (): unknown[] => {
    const rows = steps[index] ?? []
    index += 1
    return rows
  }
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(next()),
          orderBy: () => Promise.resolve(next()),
        }),
        innerJoin: () => ({
          where: () => ({
            limit: () => Promise.resolve(next()),
          }),
        }),
      }),
    }),
    execute: () => Promise.resolve(next()),
  } as unknown as Db
}

function adminAccessDb(): Db {
  return selectLimitDb([{ role: 'superadmin' }])
}

async function expectJson(
  response: Response,
  status: number,
  body: Record<string, unknown>,
): Promise<void> {
  assertEquals(response.status, status)
  assertEquals(await response.json(), body)
}

test('isUniqueViolation only matches Postgres 23505', () => {
  assertEquals(isUniqueViolation({ code: '23505' }), true)
  assertEquals(isUniqueViolation({ code: '23503' }), false)
  assertEquals(isUniqueViolation({ message: '23505' }), false)
  assertEquals(isUniqueViolation(null), false)
  assertEquals(isUniqueViolation('23505'), false)
})

test('providerErrorResponse maps known provider statuses and rethrows bugs', async () => {
  const c = mockContext()
  await expectJson(
    providerErrorResponse(c, new GithubAppTokenError('missing', 404)),
    404,
    { error: 'git_provider_request_failed', detail: 'missing' },
  )
  await expectJson(
    providerErrorResponse(c, new GitlabOauthTokenError('taken', 409)),
    409,
    { error: 'git_provider_request_failed', detail: 'taken' },
  )
  await expectJson(
    providerErrorResponse(c, new GitlabApiError('rate limited', 429)),
    502,
    { error: 'git_provider_request_failed', detail: 'rate limited' },
  )

  try {
    providerErrorResponse(c, new TypeError('bug'))
    throw new TypeError('expected providerErrorResponse to rethrow')
  } catch (error) {
    if (!(error instanceof TypeError) || error.message !== 'bug') throw error
  }
})

test('redirectToForgeUi sends the console back, never JSON', () => {
  const c = mockContext()
  const withApp = redirectToForgeUi(c, ORG_ID, APP_ID, { installed: CONNECTION_ID })
  assertEquals(withApp.status, 302)
  assertEquals(
    withApp.headers.get('Location'),
    providerInstallUiReturnPath(ORG_ID, APP_ID, { installed: CONNECTION_ID }),
  )

  const failed = redirectToForgeUi(c, null, null, { error: 'invalid_request' })
  assertEquals(failed.headers.get('Location'), '/admin/git?error=invalid_request')
})

test('resolveSourceSession requires db, session, and an accessible org', async () => {
  const noDb = await resolveSourceSession(mockContext())
  if (!(noDb instanceof Response)) throw new TypeError('expected 503')
  await expectJson(noDb, 503, { error: 'Database unavailable' })

  const noSession = await resolveSourceSession(mockContext({ db: adminAccessDb() }))
  if (!(noSession instanceof Response)) throw new TypeError('expected 401')
  await expectJson(noSession, 401, { error: 'Unauthorized' })

  const missingOrg = await resolveSourceSession(mockContext({
    db: adminAccessDb(),
    session: { userId: USER_ID },
  }))
  if (!(missingOrg instanceof Response)) throw new TypeError('expected org required')
  await expectJson(missingOrg, 400, { error: 'organizationId required' })

  const ctx = await resolveSourceSession(mockContext({
    db: adminAccessDb(),
    session: { userId: USER_ID },
    header: { [ORG_ID_HEADER]: ORG_ID },
  }))
  if (ctx instanceof Response) throw new TypeError('expected session context')
  assertEquals(ctx.userId, USER_ID)
  assertEquals(ctx.organizationId, ORG_ID)
})

test('resolveProviderCallbackSession loads db and session without an org header', async () => {
  const noDb = await resolveProviderCallbackSession(mockContext())
  if (!(noDb instanceof Response)) throw new TypeError('expected 503')
  await expectJson(noDb, 503, { error: 'Database unavailable' })

  const noSession = await resolveProviderCallbackSession(mockContext({ db: adminAccessDb() }))
  if (!(noSession instanceof Response)) throw new TypeError('expected 401')
  await expectJson(noSession, 401, { error: 'Unauthorized' })

  const ctx = await resolveProviderCallbackSession(mockContext({
    db: adminAccessDb(),
    session: { userId: USER_ID },
  }))
  if (ctx instanceof Response) throw new TypeError('expected callback session')
  assertEquals(ctx.userId, USER_ID)
  assertEquals(ctx.secretsConfig, undefined)
  assertEquals(ctx.dataEncryptionSecrets, undefined)
})

test('composeReferencesRepository reads the EXISTS flag', async () => {
  assertEquals(
    await composeReferencesRepository(
      { execute: () => Promise.resolve([{ referenced: true }]) } as unknown as Db,
      ORG_ID,
      SOURCE_ID,
    ),
    true,
  )
  assertEquals(
    await composeReferencesRepository(
      { execute: () => Promise.resolve([{ referenced: false }]) } as unknown as Db,
      ORG_ID,
      SOURCE_ID,
    ),
    false,
  )
  assertEquals(
    await composeReferencesRepository(
      { execute: () => Promise.resolve([]) } as unknown as Db,
      ORG_ID,
      SOURCE_ID,
    ),
    false,
  )
})

test('assertScopeInOrganization hides a foreign or missing parent as 404', async () => {
  const c = mockContext()
  assertEquals(
    await assertScopeInOrganization(c, selectLimitDb([]), ORG_ID, 'service', null),
    null,
  )

  const missing = await assertScopeInOrganization(
    c,
    { execute: () => Promise.resolve([]) } as unknown as Db,
    ORG_ID,
    'service',
    SERVICE_ID,
  )
  if (!(missing instanceof Response)) throw new TypeError('expected 404')
  await expectJson(missing, 404, { error: 'Not found' })

  const foreign = await assertScopeInOrganization(
    c,
    { execute: () => Promise.resolve([{ organization_id: OTHER_ORG }]) } as unknown as Db,
    ORG_ID,
    'environment',
    SERVICE_ID,
  )
  if (!(foreign instanceof Response)) throw new TypeError('expected foreign 404')
  await expectJson(foreign, 404, { error: 'Not found' })

  assertEquals(
    await assertScopeInOrganization(
      c,
      { execute: () => Promise.resolve([{ organization_id: ORG_ID }]) } as unknown as Db,
      ORG_ID,
      'service',
      SERVICE_ID,
    ),
    null,
  )
})

test('assertConnectionInOrganization checks ownership then provider', async () => {
  const c = mockContext()
  assertEquals(
    await assertConnectionInOrganization(c, selectLimitDb([]), ORG_ID, null),
    null,
  )

  const missing = await assertConnectionInOrganization(
    c,
    selectLimitDb([]),
    ORG_ID,
    CONNECTION_ID,
  )
  if (!(missing instanceof Response)) throw new TypeError('expected missing install')
  await expectJson(missing, 404, { error: 'Not found' })

  const foreign = await assertConnectionInOrganization(
    c,
    selectLimitDb([{ organizationId: OTHER_ORG, provider: 'github' }]),
    ORG_ID,
    CONNECTION_ID,
  )
  if (!(foreign instanceof Response)) throw new TypeError('expected foreign install')
  await expectJson(foreign, 404, { error: 'Not found' })

  const mismatch = await assertConnectionInOrganization(
    c,
    selectLimitDb([{ organizationId: ORG_ID, provider: 'gitlab' }]),
    ORG_ID,
    CONNECTION_ID,
    'github',
  )
  if (!(mismatch instanceof Response)) throw new TypeError('expected mismatch')
  await expectJson(mismatch, 400, { error: 'source_installation_provider_mismatch' })

  assertEquals(
    await assertConnectionInOrganization(
      c,
      selectLimitDb([{ organizationId: ORG_ID, provider: 'github' }]),
      ORG_ID,
      CONNECTION_ID,
      'github',
    ),
    null,
  )
})

test('assertSecretInOrganization rejects the wrong lane or kind', async () => {
  const c = mockContext()
  assertEquals(
    await assertSecretInOrganization(c, selectLimitDb([]), ORG_ID, null, 'git'),
    null,
  )

  const missing = await assertSecretInOrganization(
    c,
    selectLimitDb([]),
    ORG_ID,
    CREDENTIAL_ID,
    'git',
  )
  if (!(missing instanceof Response)) throw new TypeError('expected missing credential')
  await expectJson(missing, 404, { error: 'Not found' })

  const githubDenied = await assertSecretInOrganization(
    c,
    selectLimitDb([{
      organizationId: ORG_ID,
      provider: GIT_DEPLOY_KEY_CREDENTIAL_PROVIDER,
    }]),
    ORG_ID,
    CREDENTIAL_ID,
    'github',
  )
  if (!(githubDenied instanceof Response)) throw new TypeError('expected github deny')
  await expectJson(githubDenied, 400, { error: 'source_credential_not_supported' })

  const storageKey = await assertSecretInOrganization(
    c,
    selectLimitDb([{ organizationId: ORG_ID, provider: 's3' }]),
    ORG_ID,
    CREDENTIAL_ID,
    'gitlab',
  )
  if (!(storageKey instanceof Response)) throw new TypeError('expected provider mismatch')
  await expectJson(storageKey, 400, { error: 'source_credential_provider_mismatch' })

  assertEquals(
    await assertSecretInOrganization(
      c,
      selectLimitDb([{
        organizationId: ORG_ID,
        provider: GIT_DEPLOY_KEY_CREDENTIAL_PROVIDER,
      }]),
      ORG_ID,
      CREDENTIAL_ID,
      'git',
    ),
    null,
  )
})

test('assertConnectionUnclaimed is first-come across organizations', async () => {
  const c = mockContext()
  const params = {
    forgeId: APP_ID,
    externalInstallationId: '42',
    provider: 'github' as const,
    organizationId: ORG_ID,
  }

  assertEquals(
    await assertConnectionUnclaimed(c, selectLimitDb([]), params),
    null,
  )
  assertEquals(
    await assertConnectionUnclaimed(
      c,
      selectLimitDb([{ organizationId: ORG_ID }]),
      params,
    ),
    null,
  )

  const claimed = await assertConnectionUnclaimed(
    c,
    selectLimitDb([{ organizationId: OTHER_ORG }]),
    params,
  )
  if (!(claimed instanceof Response)) throw new TypeError('expected 409')
  await expectJson(claimed, 409, { error: 'installation_claimed_by_another_organization' })
})

test('findAttachedSource returns the existing binding id', async () => {
  assertEquals(
    await findAttachedSource(selectLimitDb([]), ORG_ID, {
      connectionId: CONNECTION_ID,
      repositoryExternalId: '99',
    }),
    null,
  )
  assertEquals(
    await findAttachedSource(selectLimitDb([{ id: SOURCE_ID }]), ORG_ID, {
      connectionId: CONNECTION_ID,
      repositoryExternalId: '99',
    }),
    SOURCE_ID,
  )
})

test('resolveConnectApp requires a visible app id', async () => {
  const secrets = await deriveEncryptionSecretsConfig(
    parseTestSecretsConfig('deno'),
    'data-encryption',
  )

  const missing = await resolveConnectApp(
    mockContext({ query: {} }),
    selectLimitDb([]),
    secrets,
    ORG_ID,
    'github',
  )
  if (!(missing instanceof Response)) throw new TypeError('expected git_app_required')
  await expectJson(missing, 400, { error: 'git_app_required' })

  const invalid = await resolveConnectApp(
    mockContext({ query: { forgeId: 'not-a-uuid' } }),
    selectLimitDb([]),
    secrets,
    ORG_ID,
    'github',
  )
  if (!(invalid instanceof Response)) throw new TypeError('expected invalid app')
  await expectJson(invalid, 400, { error: 'git_app_required' })

  const hidden = await resolveConnectApp(
    mockContext({ query: { forgeId: APP_ID } }),
    selectLimitDb([]),
    secrets,
    ORG_ID,
    'github',
  )
  if (!(hidden instanceof Response)) throw new TypeError('expected hidden 404')
  await expectJson(hidden, 404, { error: 'Not found' })

  const unsealedMissing = await resolveConnectApp(
    mockContext({ query: { forgeId: APP_ID } }),
    selectLimitSequence([[{ id: APP_ID }], []]),
    secrets,
    ORG_ID,
    'gitlab',
  )
  if (!(unsealedMissing instanceof Response)) throw new TypeError('expected load 404')
  await expectJson(unsealedMissing, 404, { error: 'Not found' })
})

test('resolveGitlabRedirectUri prefers the configured URI then a public origin', async () => {
  assertEquals(
    await resolveGitlabRedirectUri(selectLimitDb([]), 'https://panel.example.com/cb'),
    'https://panel.example.com/cb',
  )
  assertEquals(await resolveGitlabRedirectUri(selectLimitDb([]), null), null)
  assertEquals(
    await resolveGitlabRedirectUri(selectLimitDb([{ value: [] }]), null),
    null,
  )
  assertEquals(
    await resolveGitlabRedirectUri(
      selectLimitDb([{ value: ['https://panel.example.com/'] }]),
      null,
    ),
    `https://panel.example.com${CLIENT_API_PREFIX}/repositories/gitlab/oauth/callback`,
  )
  assertEquals(
    await resolveGitlabRedirectUri(
      selectLimitDb([{ value: 'https://panel.example.com, https://other.example.com' }]),
      null,
    ),
    `https://panel.example.com${CLIENT_API_PREFIX}/repositories/gitlab/oauth/callback`,
  )
})

test('resolveSourceWebhookInfo is undefined for generic git and otherwise folds reachability', async () => {
  assertEquals(
    await resolveSourceWebhookInfo(selectLimitDb([]), 'git', CONNECTION_ID),
    undefined,
  )

  const noUrl = await resolveSourceWebhookInfo(selectLimitDb([{ value: [] }]), 'github', null)
  assertEquals(noUrl?.webhookUrl, null)
  assertEquals(noUrl?.webhookReachable, false)

  const publicGithub = await resolveSourceWebhookInfo(
    selectLimitDb([{ value: ['https://panel.example.com'] }]),
    'github',
    null,
  )
  assertEquals(publicGithub?.webhookReachable, true)
  assertEquals(publicGithub?.webhookUrl?.endsWith('/webhook/github'), true)

  const withApp = await resolveSourceWebhookInfo(
    selectLimitSequence([
      [{ value: ['https://panel.example.com'] }],
      [{
        webhookRef: 'app-ref',
        baseUrl: 'https://github.example.com',
        webhookOrigin: 'https://hooks.example.com',
      }],
    ]),
    'gitlab',
    CONNECTION_ID,
  )
  assertEquals(withApp?.webhookUrl?.includes('/webhook/gitlab'), true)
})

test('fetchInstallationAccount treats lookup failures as authorization failures', async () => {
  const originalFetch = globalThis.fetch
  const calls: string[] = []

  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('/missing')) {
      return Promise.resolve(new Response('gone', { status: 404 }))
    }
    if (url.includes('/boom')) {
      return Promise.resolve(new Response('nope', { status: 500 }))
    }
    if (url.includes('/bad-json')) {
      return Promise.resolve(new Response('not-json', { status: 200 }))
    }
    if (url.includes('/network')) {
      return Promise.reject(new TypeError('offline'))
    }
    return Promise.resolve(Response.json({
      account: { login: 'acme', type: 'Organization' },
    }))
  }) as typeof fetch

  try {
    assertEquals(
      await fetchInstallationAccount('jwt', '42'),
      { accountLogin: 'acme', accountType: 'Organization' },
    )
    assertEquals(calls[0]?.includes('/app/installations/42'), true)

    assertEquals(
      await fetchInstallationAccount('jwt', 'bad-json', 'https://ghe.example.com/api/v3'),
      { accountLogin: null, accountType: null },
    )

    try {
      await fetchInstallationAccount('jwt', 'missing')
      throw new TypeError('expected 404 lookup to throw')
    } catch (error) {
      if (!(error instanceof GithubAppTokenError)) throw error
      assertEquals(error.status, 404)
    }

    try {
      await fetchInstallationAccount('jwt', 'boom')
      throw new TypeError('expected non-404 to keep status')
    } catch (error) {
      if (!(error instanceof GithubAppTokenError)) throw error
      assertEquals(error.status, 500)
    }

    try {
      await fetchInstallationAccount('jwt', 'network')
      throw new TypeError('expected network error to throw')
    } catch (error) {
      if (!(error instanceof GithubAppTokenError)) throw error
      assertEquals(error.message.includes('offline'), true)
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('registerRepositoryRoutes refuses to mount without session secrets', () => {
  try {
    registerRepositoryRoutes(new Hono<AppEnv>(), {
      runtime: 'deno',
      signupEnvOverride: undefined,
    } as AuthRouteOpts)
    throw new TypeError('expected TypeError')
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    assertEquals(error.message, 'session secrets are required for repository routes')
  }
})

const SOURCE_PATHS = [
  ['GET', '/repositories'],
  ['POST', '/repositories'],
  ['POST', '/repositories/attach'],
  ['GET', `/repositories/${SOURCE_ID}`],
  ['PATCH', `/repositories/${SOURCE_ID}`],
  ['DELETE', `/repositories/${SOURCE_ID}`],
  ['GET', `/repositories/${SOURCE_ID}/inspect`],
  ['GET', '/repositories/connections'],
  ['GET', `/repositories/connections/${CONNECTION_ID}/repositories`],
  ['GET', '/repositories/github/install'],
  ['GET', '/repositories/github/callback'],
  ['GET', '/repositories/gitlab/oauth'],
  ['GET', '/repositories/gitlab/oauth/callback'],
  ['POST', '/repositories/gitlab/deploy-keys'],
] as const

async function buildSourceApp(db?: Db): Promise<{
  app: Hono<AppEnv>
  cookie: string
}> {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption',
  )
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    if (db) c.set('db', db)
    c.set('runtime', 'deno')
    c.set('secretsConfig', secretsConfig)
    c.set('dataEncryptionSecrets', dataEncryptionSecrets)
    return next()
  })
  registerRepositoryRoutes(app, { secrets, runtime: 'deno', signupEnvOverride: undefined })
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie('session-token', secrets)}`
  return { app, cookie }
}

function sessionRow(role = 'superadmin') {
  return {
    sessionId: 'sess-1',
    userId: USER_ID,
    email: 'ops@example.com',
    role,
    isDisabled: false,
  }
}

function takeNext(queue: unknown[][] | undefined, fallback: unknown[]): unknown[] {
  if (!queue || queue.length === 0) return fallback
  return queue.shift() ?? fallback
}

/** Flatten a Drizzle SQL object so host-free execute doubles can inspect ancestry. */
function flattenSql(query: unknown): string {
  const parts: string[] = []
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      parts.push(node)
      return
    }
    if (!node || typeof node !== 'object') return
    const obj = node as Record<string, unknown>
    if (Array.isArray(obj.queryChunks)) {
      for (const chunk of obj.queryChunks) visit(chunk)
    }
  }
  visit(query)
  return parts.join('')
}

function sourceHttpDb(options: {
  selectRows?: unknown[]
  limitQueue?: unknown[][]
  orderByRows?: unknown[]
  executeRows?: unknown[]
  executeQueue?: unknown[][]
  execute?: (query: unknown) => Promise<unknown[]>
  insertId?: string | null
  insertError?: unknown
  sessionRole?: string
} = {}): Db {
  const sessionRole = options.sessionRole ?? 'superadmin'
  const session = sessionRow(sessionRole)
  const defaultSelect = options.selectRows ?? [{ role: sessionRole }]
  const defaultExecute = options.executeRows ?? [{
    allowed: true,
    item_id: SOURCE_ID,
    referenced: false,
    organization_id: ORG_ID,
  }]
  const limitRows = () => Promise.resolve(takeNext(options.limitQueue, defaultSelect))
  const whereResult = () => {
    const rows = limitRows()
    return Object.assign(rows, {
      limit: () => rows,
      orderBy: () => Promise.resolve(options.orderByRows ?? []),
    })
  }
  return {
    select: () => ({
      from: () => ({
        where: whereResult,
        innerJoin: () => ({
          where: () => ({
            limit: () => Promise.resolve([session]),
          }),
          innerJoin: () => ({
            where: () => ({
              limit: () => Promise.resolve(takeNext(options.limitQueue, defaultSelect)),
            }),
          }),
        }),
        orderBy: () => Promise.resolve(options.orderByRows ?? []),
      }),
    }),
    execute: (query: unknown) => {
      if (options.execute) return options.execute(query)
      return Promise.resolve(takeNext(options.executeQueue, defaultExecute))
    },
    insert: () => ({
      values: () => {
        if (options.insertError) throw options.insertError
        return {
          returning: () =>
            Promise.resolve(options.insertId === null ? [] : [{ id: options.insertId ?? SOURCE_ID }]),
          onConflictDoUpdate: () => ({
            returning: () =>
              Promise.resolve(options.insertId === null ? [] : [{ id: options.insertId ?? CONNECTION_ID }]),
          }),
        }
      },
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }),
    delete: () => ({
      where: () => Promise.resolve(),
    }),
  } as unknown as Db
}

test('source routes return 401 without a session cookie', async () => {
  const { app } = await buildSourceApp(sourceHttpDb())
  for (const [method, path] of SOURCE_PATHS) {
    const res = await app.request(path, {
      method,
      headers: {
        'content-type': 'application/json',
        [ORG_ID_HEADER]: ORG_ID,
      },
      body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify({}),
    })
    assertEquals(res.status, 401, `${method} ${path}`)
    const body = await res.json() as { error?: unknown }
    assertEquals(body.error, 'Unauthorized', `${method} ${path}`)
  }
})

function authHeaders(cookie: string, extra?: Record<string, string>): Record<string, string> {
  return {
    Cookie: cookie,
    [ORG_ID_HEADER]: ORG_ID,
    ...extra,
  }
}

test('authenticated source routes reject bad ids, bodies, and missing signing material', async () => {
  const db = sourceHttpDb({ selectRows: [] })
  const { app, cookie } = await buildSourceApp(db)
  const headers = authHeaders(cookie)

  await expectJson(
    await app.request(`/repositories/${CONNECTION_ID.slice(0, 8)}`, { headers }),
    404,
    { error: 'Not found' },
  )
  await expectJson(
    await app.request(`/repositories/${CONNECTION_ID.slice(0, 8)}/inspect`, { headers }),
    404,
    { error: 'Not found' },
  )
  await expectJson(
    await app.request(`/repositories/${SOURCE_ID}`, {
      method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ autoDeploy: 'immediate' }),
    }),
    404,
    { error: 'Not found' },
  )
  await expectJson(
    await app.request(`/repositories/not-a-uuid`, {
      method: 'DELETE',
      headers,
    }),
    404,
    { error: 'Not found' },
  )
  await expectJson(
    await app.request('/repositories/connections/not-a-uuid/repositories', { headers }),
    400,
    { error: 'Invalid request' },
  )
  await expectJson(
    await app.request('/repositories/github/install', { headers }),
    400,
    { error: 'git_app_required' },
  )
  await expectJson(
    await app.request('/repositories/gitlab/oauth', { headers }),
    400,
    { error: 'git_app_required' },
  )
  await expectJson(
    await app.request('/repositories/attach', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ repositoryUrl: 'https://github.com/acme/app.git' }),
    }),
    400,
    {
      error:
        'expected { connectionId, repositoryExternalId, repositoryUrl, defaultBranch? }',
    },
  )
  await expectJson(
    await app.request('/repositories', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ repositoryUrl: 'https://github.com/acme/app.git' }),
    }),
    400,
    { error: 'source_installation_required' },
  )
  await expectJson(
    await app.request('/repositories/gitlab/deploy-keys', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    }),
    400,
    { error: 'Invalid request' },
  )
})

test('github and gitlab callbacks redirect into the console on a bad hop', async () => {
  const { app, cookie } = await buildSourceApp(sourceHttpDb())
  const headers = { Cookie: cookie }

  const github = await app.request('/repositories/github/callback', { headers })
  assertEquals(github.status, 302)
  assertEquals(
    github.headers.get('Location'),
    providerInstallUiReturnPath(null, null, { error: 'invalid_request' }),
  )

  const gitlab = await app.request('/repositories/gitlab/oauth/callback', { headers })
  assertEquals(gitlab.status, 302)
  assertEquals(
    gitlab.headers.get('Location'),
    providerInstallUiReturnPath(null, null, { error: 'invalid_request' }),
  )
})

test('list and detail short-circuit on empty visibility and missing rows', async () => {
  const emptyVisible = sourceHttpDb({
    executeQueue: [[{ allowed: true }], []],
  })
  const listed = await buildSourceApp(emptyVisible)
  await expectJson(
    await listed.app.request('/repositories', { headers: authHeaders(listed.cookie) }),
    200,
    { repositories: [] },
  )

  const missing = await buildSourceApp(sourceHttpDb({ selectRows: [] }))
  await expectJson(
    await missing.app.request(`/repositories/${SOURCE_ID}`, {
      headers: authHeaders(missing.cookie),
    }),
    404,
    { error: 'Not found' },
  )
  await expectJson(
    await missing.app.request('/repositories/connections', {
      headers: authHeaders(missing.cookie),
    }),
    200,
    { connections: [] },
  )
})

test('inspect requires a ref when the source has no default branch', async () => {
  const db = sourceHttpDb({
    selectRows: [{
      id: SOURCE_ID,
      organizationId: ORG_ID,
      connectionId: CONNECTION_ID,
      serviceId: null,
      environmentId: null,
      secretId: null,
      provider: 'github',
      repositoryUrl: 'https://github.com/acme/app.git',
      repositoryExternalId: '99',
      defaultBranch: null,
      subdirectory: null,
      autoDeploy: 'disabled',
      metadata: null,
      options: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    }],
  })
  const { app, cookie } = await buildSourceApp(db)
  const res = await app.request(`/repositories/${SOURCE_ID}/inspect`, {
    headers: authHeaders(cookie),
  })
  assertEquals(res.status, 400)
  const body = await res.json() as { error?: unknown }
  assertEquals(body.error, 'ref_required')
})

test('delete refuses a compose-referenced source and otherwise returns ok', async () => {
  const referenced = sourceHttpDb({
    selectRows: [{ id: SOURCE_ID }],
    executeRows: [{
      allowed: true,
      referenced: true,
      organization_id: ORG_ID,
    }],
  })
  const { app, cookie } = await buildSourceApp(referenced)
  await expectJson(
    await app.request(`/repositories/${SOURCE_ID}`, {
      method: 'DELETE',
      headers: authHeaders(cookie),
    }),
    409,
    { error: SOURCE_REFERENCED_BY_COMPOSE_ERROR },
  )

  const free = sourceHttpDb({
    selectRows: [{ id: SOURCE_ID }],
    executeRows: [{
      allowed: true,
      referenced: false,
      organization_id: ORG_ID,
    }],
  })
  const freed = await buildSourceApp(free)
  await expectJson(
    await freed.app.request(`/repositories/${SOURCE_ID}`, {
      method: 'DELETE',
      headers: authHeaders(freed.cookie),
    }),
    200,
    { ok: true },
  )
})

test('attach reuses an existing binding and maps a unique-violation race', async () => {
  const installRow = { organizationId: ORG_ID, provider: 'github' }
  const reused = sourceHttpDb({
    limitQueue: [
      [{ role: 'superadmin' }],
      [installRow],
      [{ provider: 'github' }],
      [{ id: SOURCE_ID }],
    ],
  })
  const first = await buildSourceApp(reused)
  await expectJson(
    await first.app.request('/repositories/attach', {
      method: 'POST',
      headers: { ...authHeaders(first.cookie), 'content-type': 'application/json' },
      body: JSON.stringify({
        connectionId: CONNECTION_ID,
        repositoryExternalId: '99',
        repositoryUrl: 'https://github.com/acme/app.git',
      }),
    }),
    200,
    { ok: true, id: SOURCE_ID, reused: true },
  )

  const raced = sourceHttpDb({
    limitQueue: [
      [{ role: 'superadmin' }],
      [installRow],
      [{ provider: 'github' }],
      [],
      [{ id: SOURCE_ID }],
    ],
    insertError: { code: '23505' },
  })
  const second = await buildSourceApp(raced)
  await expectJson(
    await second.app.request('/repositories/attach', {
      method: 'POST',
      headers: { ...authHeaders(second.cookie), 'content-type': 'application/json' },
      body: JSON.stringify({
        connectionId: CONNECTION_ID,
        repositoryExternalId: '99',
        repositoryUrl: 'https://github.com/acme/app.git',
      }),
    }),
    200,
    { ok: true, id: SOURCE_ID, reused: true },
  )
})

test('signing-unavailable github install answers 503 when secretsConfig is missing', async () => {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', sourceHttpDb())
    c.set('runtime', 'deno')
    return next()
  })
  registerRepositoryRoutes(app, { secrets, runtime: 'deno', signupEnvOverride: undefined })
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie('session-token', secrets)}`
  await expectJson(
    await app.request(`/repositories/github/install?forgeId=${APP_ID}`, {
      headers: authHeaders(cookie),
    }),
    503,
    { error: 'Signing unavailable — no root secret configured' },
  )
  await expectJson(
    await app.request(`/repositories/gitlab/oauth?forgeId=${APP_ID}`, {
      headers: authHeaders(cookie),
    }),
    503,
    { error: 'Signing unavailable — no root secret configured' },
  )
})

function sourceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SOURCE_ID,
    organizationId: ORG_ID,
    connectionId: CONNECTION_ID,
    serviceId: null,
    environmentId: null,
    secretId: null,
    provider: 'github',
    repositoryUrl: 'https://github.com/acme/app.git',
    repositoryExternalId: '99',
    defaultBranch: 'trunk',
    subdirectory: null,
    autoDeploy: 'disabled',
    metadata: null,
    options: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  }
}

test('list filters and create/patch bodies reject invalid combinations', async () => {
  const { app, cookie } = await buildSourceApp(sourceHttpDb({ selectRows: [] }))
  const headers = authHeaders(cookie)

  await expectJson(
    await app.request(
      `/repositories?serviceId=${SERVICE_ID}&environmentId=${SOURCE_ID}`,
      { headers },
    ),
    400,
    { error: 'Invalid request' },
  )
  await expectJson(
    await app.request('/repositories?serviceId=not-a-uuid', { headers }),
    400,
    { error: 'Invalid request' },
  )
  await expectJson(
    await app.request('/repositories', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'bitbucket',
        repositoryUrl: 'https://github.com/acme/app.git',
        connectionId: CONNECTION_ID,
      }),
    }),
    400,
    { error: 'Invalid request' },
  )
  await expectJson(
    await app.request('/repositories', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        repositoryUrl: 'https://github.com/acme/app.git',
        connectionId: CONNECTION_ID,
        serviceId: SERVICE_ID,
        environmentId: SOURCE_ID,
      }),
    }),
    400,
    { error: 'source_single_parent_required' },
  )
  await expectJson(
    await app.request(`/repositories/${SOURCE_ID}/inspect`, { headers }),
    404,
    { error: 'Not found' },
  )
  await expectJson(
    await app.request(`/repositories/github/install?forgeId=${APP_ID}`, { headers }),
    404,
    { error: 'Not found' },
  )
})

test('detail serializes a visible source and patch writes autoDeploy', async () => {
  const db = sourceHttpDb({
    selectRows: [sourceRow()],
    executeRows: [{ allowed: true, item_id: SOURCE_ID }],
  })
  const { app, cookie } = await buildSourceApp(db)
  const headers = authHeaders(cookie)

  const detail = await app.request(`/repositories/${SOURCE_ID}`, { headers })
  assertEquals(detail.status, 200)
  const body = await detail.json() as { repository?: { id?: unknown; provider?: unknown } }
  assertEquals(body.repository?.id, SOURCE_ID)
  assertEquals(body.repository?.provider, 'github')

  await expectJson(
    await app.request(`/repositories/${SOURCE_ID}`, {
      method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ autoDeploy: 'immediate' }),
    }),
    200,
    { ok: true },
  )
})

test('github and gitlab callbacks reject bad or foreign state', async () => {
  const { app, cookie } = await buildSourceApp(sourceHttpDb())
  const headers = { Cookie: cookie }
  const secretsConfig = parseTestSecretsConfig('deno')

  const invalidGithub = await app.request(
    '/repositories/github/callback?state=not-signed&installation_id=1',
    { headers },
  )
  assertEquals(invalidGithub.status, 302)
  assertEquals(
    invalidGithub.headers.get('Location'),
    providerInstallUiReturnPath(null, null, { error: 'state_invalid' }),
  )

  const foreignState = await signGithubInstallState(secretsConfig, {
    organizationId: OTHER_ORG,
    forgeId: APP_ID,
  })
  const foreign = await app.request(
    `/repositories/github/callback?state=${encodeURIComponent(foreignState)}&installation_id=1`,
    { headers },
  )
  assertEquals(foreign.status, 302)
  assertEquals(
    foreign.headers.get('Location'),
    providerInstallUiReturnPath(OTHER_ORG, APP_ID, { error: 'not_configured' }),
  )

  const invalidGitlab = await app.request(
    '/repositories/gitlab/oauth/callback?state=not-signed&code=abc',
    { headers },
  )
  assertEquals(invalidGitlab.status, 302)
  assertEquals(
    invalidGitlab.headers.get('Location'),
    providerInstallUiReturnPath(null, null, { error: 'state_invalid' }),
  )

  const gitlabForeign = await signGitlabConnectState(secretsConfig, {
    organizationId: OTHER_ORG,
    forgeId: APP_ID,
  })
  const gitlab = await app.request(
    `/repositories/gitlab/oauth/callback?state=${encodeURIComponent(gitlabForeign)}&code=abc`,
    { headers },
  )
  assertEquals(gitlab.status, 302)
  assertEquals(
    gitlab.headers.get('Location'),
    providerInstallUiReturnPath(OTHER_ORG, APP_ID, { error: 'not_configured' }),
  )
})

test('nested source routes answer 503 when encryption secrets are missing', async () => {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', sourceHttpDb({
      selectRows: [{ organizationId: ORG_ID, provider: 'github' }],
    }))
    c.set('runtime', 'deno')
    c.set('secretsConfig', secretsConfig)
    return next()
  })
  registerRepositoryRoutes(app, { secrets, runtime: 'deno', signupEnvOverride: undefined })
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie('session-token', secrets)}`
  const headers = authHeaders(cookie)

  await expectJson(
    await app.request(`/repositories/connections/${CONNECTION_ID}/repositories`, { headers }),
    503,
    { error: 'Encryption unavailable — no encryption key configured' },
  )
  await expectJson(
    await app.request('/repositories/gitlab/deploy-keys', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'read-only' }),
    }),
    503,
    { error: 'Encryption unavailable — no encryption key configured' },
  )
  await expectJson(
    await app.request(`/repositories/gitlab/oauth?forgeId=${APP_ID}`, { headers }),
    503,
    { error: 'Encryption unavailable — no encryption key configured' },
  )

  const state = await signGithubInstallState(secretsConfig, {
    organizationId: ORG_ID,
    forgeId: APP_ID,
  })
  const callback = await app.request(
    `/repositories/github/callback?state=${encodeURIComponent(state)}&installation_id=1`,
    { headers },
  )
  assertEquals(callback.status, 302)
  assertEquals(
    callback.headers.get('Location'),
    providerInstallUiReturnPath(ORG_ID, APP_ID, { error: 'unavailable' }),
  )
})

test('create and attach insert a new binding when none exists', async () => {
  const installRow = { organizationId: ORG_ID, provider: 'github' }
  const created = sourceHttpDb({
    limitQueue: [
      [{ role: 'superadmin' }],
      [installRow],
    ],
    insertId: SOURCE_ID,
  })
  const first = await buildSourceApp(created)
  await expectJson(
    await first.app.request('/repositories', {
      method: 'POST',
      headers: { ...authHeaders(first.cookie), 'content-type': 'application/json' },
      body: JSON.stringify({
        repositoryUrl: 'https://github.com/acme/app.git',
        connectionId: CONNECTION_ID,
      }),
    }),
    200,
    { ok: true, id: SOURCE_ID },
  )

  const attached = sourceHttpDb({
    limitQueue: [
      [{ role: 'superadmin' }],
      [installRow],
      [installRow],
      [],
    ],
    insertId: SOURCE_ID,
  })
  const second = await buildSourceApp(attached)
  await expectJson(
    await second.app.request('/repositories/attach', {
      method: 'POST',
      headers: { ...authHeaders(second.cookie), 'content-type': 'application/json' },
      body: JSON.stringify({
        connectionId: CONNECTION_ID,
        repositoryExternalId: '99',
        repositoryUrl: 'https://github.com/acme/app.git',
      }),
    }),
    201,
    { ok: true, id: SOURCE_ID, reused: false },
  )

  const failedInsert = sourceHttpDb({
    limitQueue: [
      [{ role: 'superadmin' }],
      [installRow],
    ],
    insertId: null,
  })
  const third = await buildSourceApp(failedInsert)
  await expectJson(
    await third.app.request('/repositories', {
      method: 'POST',
      headers: { ...authHeaders(third.cookie), 'content-type': 'application/json' },
      body: JSON.stringify({
        repositoryUrl: 'https://github.com/acme/app.git',
        connectionId: CONNECTION_ID,
      }),
    }),
    500,
    { error: 'Failed to create repository' },
  )
})

test('attach succeeds for a non-platform user with an organization:manage grant', async () => {
  const installRow = { organizationId: ORG_ID, provider: 'github' }
  const attached = sourceHttpDb({
    sessionRole: 'user',
    limitQueue: [
      [{ role: 'user' }],
      [installRow],
      [installRow],
      [],
    ],
    insertId: SOURCE_ID,
    execute: (query) => {
      // Repository ancestry keys on repository.id, so an org-level manage
      // grant never hits when the create gate is keyed by organizationId as
      // a repository id. Deny those queries so this test cannot pass via
      // platform-admin bypass or a catch-all execute stub.
      const sqlText = flattenSql(query)
      if (sqlText.includes('FROM repository')) {
        return Promise.resolve([{ allowed: false }])
      }
      return Promise.resolve([{ allowed: true }])
    },
  })
  const { app, cookie } = await buildSourceApp(attached)
  await expectJson(
    await app.request('/repositories/attach', {
      method: 'POST',
      headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
      body: JSON.stringify({
        connectionId: CONNECTION_ID,
        repositoryExternalId: '99',
        repositoryUrl: 'https://github.com/acme/app.git',
      }),
    }),
    201,
    { ok: true, id: SOURCE_ID, reused: false },
  )
})

test('list and installations return visible rows; connect callbacks fail closed after a valid state', async () => {
  const listed = sourceHttpDb({
    selectRows: [{ role: 'superadmin' }],
    executeQueue: [
      [{ allowed: true }],
      [{ organization_id: ORG_ID }],
      [{ item_id: SOURCE_ID }],
    ],
    orderByRows: [sourceRow({ serviceId: SERVICE_ID })],
  })
  const { app, cookie } = await buildSourceApp(listed)
  const headers = authHeaders(cookie)
  const list = await app.request(`/repositories?serviceId=${SERVICE_ID}`, { headers })
  assertEquals(list.status, 200)
  const listedBody = await list.json() as { repositories?: Array<{ id?: unknown }> }
  assertEquals(listedBody.repositories?.length, 1)
  assertEquals(listedBody.repositories?.[0]?.id, SOURCE_ID)

  const envList = await buildSourceApp(sourceHttpDb({
    selectRows: [{ role: 'superadmin' }],
    executeQueue: [
      [{ allowed: true }],
      [{ organization_id: OTHER_ORG }],
    ],
  }))
  await expectJson(
    await envList.app.request(`/repositories?environmentId=${SOURCE_ID}`, {
      headers: authHeaders(envList.cookie),
    }),
    404,
    { error: 'Not found' },
  )

  const installs = await buildSourceApp(sourceHttpDb({
    selectRows: [{ role: 'superadmin' }],
    orderByRows: [{
      id: CONNECTION_ID,
      organizationId: ORG_ID,
      forgeId: APP_ID,
      provider: 'github',
      externalInstallationId: '99',
      accountLogin: 'acme',
      accountType: 'Organization',
      suspendedAt: null,
      metadata: null,
      options: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    }],
  }))
  const installRes = await installs.app.request('/repositories/connections', {
    headers: authHeaders(installs.cookie),
  })
  assertEquals(installRes.status, 200)
  const installBody = await installRes.json() as {
    connections?: Array<{ id?: unknown; suspended?: unknown }>
  }
  assertEquals(installBody.connections?.[0]?.id, CONNECTION_ID)
  assertEquals(installBody.connections?.[0]?.suspended, false)

  const secretsConfig = parseTestSecretsConfig('deno')
  const connect = await buildSourceApp(sourceHttpDb({ selectRows: [] }))
  const connectHeaders = { Cookie: connect.cookie }
  const githubState = await signGithubInstallState(secretsConfig, {
    organizationId: ORG_ID,
    forgeId: APP_ID,
  })
  const github = await connect.app.request(
    `/repositories/github/callback?state=${encodeURIComponent(githubState)}&installation_id=1`,
    { headers: connectHeaders },
  )
  assertEquals(github.status, 302)
  assertEquals(
    github.headers.get('Location'),
    providerInstallUiReturnPath(ORG_ID, APP_ID, { error: 'not_configured' }),
  )

  const gitlabState = await signGitlabConnectState(secretsConfig, {
    organizationId: ORG_ID,
    forgeId: APP_ID,
  })
  const gitlab = await connect.app.request(
    `/repositories/gitlab/oauth/callback?state=${encodeURIComponent(gitlabState)}&code=abc`,
    { headers: connectHeaders },
  )
  assertEquals(gitlab.status, 302)
  assertEquals(
    gitlab.headers.get('Location'),
    providerInstallUiReturnPath(ORG_ID, APP_ID, { error: 'not_configured' }),
  )
})

test('github install 404s when the app id is visible but cannot be loaded', async () => {
  const db = sourceHttpDb({
    limitQueue: [
      [{ role: 'superadmin' }],
      [{ id: APP_ID }],
      [],
    ],
  })
  const { app, cookie } = await buildSourceApp(db)
  await expectJson(
    await app.request(`/repositories/github/install?forgeId=${APP_ID}`, {
      headers: authHeaders(cookie),
    }),
    404,
    { error: 'Not found' },
  )
})

test('deploy-keys mints a show-once public key', async () => {
  const { app, cookie } = await buildSourceApp(sourceHttpDb({ insertId: CREDENTIAL_ID }))
  const res = await app.request('/repositories/gitlab/deploy-keys', {
    method: 'POST',
    headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'read-only' }),
  })
  assertEquals(res.status, 200)
  const body = await res.json() as {
    ok?: unknown
    secretId?: unknown
    publicKey?: unknown
    fingerprint?: unknown
  }
  assertEquals(body.ok, true)
  assertEquals(body.secretId, CREDENTIAL_ID)
  if (typeof body.publicKey !== 'string' || !body.publicKey.includes('ssh-ed25519')) {
    throw new TypeError('expected an OpenSSH public key')
  }
  if (typeof body.fingerprint !== 'string' || body.fingerprint.length === 0) {
    throw new TypeError('expected a key fingerprint')
  }
})

test('inspect with a default branch and repositories reach the provider boundary', async () => {
  const db = sourceHttpDb({
    selectRows: [sourceRow()],
    limitQueue: [
      [{ role: 'superadmin' }],
      [sourceRow()],
      [],
    ],
  })
  const { app, cookie } = await buildSourceApp(db)
  const inspect = await app.request(`/repositories/${SOURCE_ID}/inspect`, {
    headers: authHeaders(cookie),
  })
  assertEquals(inspect.status >= 400, true)

  const repos = sourceHttpDb({
    limitQueue: [
      [{ role: 'superadmin' }],
      [{ organizationId: ORG_ID, provider: 'github' }],
      [{ provider: 'github' }],
    ],
  })
  const listed = await buildSourceApp(repos)
  const res = await listed.app.request(
    `/repositories/connections/${CONNECTION_ID}/repositories`,
    { headers: authHeaders(listed.cookie) },
  )
  assertEquals(res.status >= 400, true)
})

test('inspect rejects an unsafe listPath before touching the provider', async () => {
  const db = sourceHttpDb({
    selectRows: [sourceRow()],
    limitQueue: [
      [{ role: 'superadmin' }],
      [sourceRow()],
    ],
  })
  const { app, cookie } = await buildSourceApp(db)
  await expectJson(
    await app.request(
      `/repositories/${SOURCE_ID}/inspect?listPath=${encodeURIComponent('../x')}`,
      { headers: authHeaders(cookie) },
    ),
    400,
    {
      error: 'invalid_list_path',
      message: 'listPath must be a relative path without ".." (e.g. "apps/web").',
    },
  )
})

test('inspect passes a safe listPath through to the provider boundary', async () => {
  const db = sourceHttpDb({
    selectRows: [sourceRow()],
    limitQueue: [
      [{ role: 'superadmin' }],
      [sourceRow()],
      [],
    ],
  })
  const { app, cookie } = await buildSourceApp(db)
  const res = await app.request(
    `/repositories/${SOURCE_ID}/inspect?listPath=apps/web`,
    { headers: authHeaders(cookie) },
  )
  // Same shape as the no-listPath case above: the value clears validation and
  // the request fails only at the unreachable provider.
  assertEquals(res.status >= 400, true)
  const body = await res.json() as { error?: unknown }
  assertEquals(body.error === 'invalid_list_path', false)
})

test('patch names a foreign installation as not found; attach insert miss is 500', async () => {
  const patched = sourceHttpDb({
    selectRows: [sourceRow()],
    limitQueue: [
      [{ role: 'superadmin' }],
      [sourceRow({ connectionId: CONNECTION_ID, secretId: null, repositoryUrl: 'https://github.com/acme/app.git', provider: 'github' })],
      [],
    ],
  })
  const first = await buildSourceApp(patched)
  await expectJson(
    await first.app.request(`/repositories/${SOURCE_ID}`, {
      method: 'PATCH',
      headers: { ...authHeaders(first.cookie), 'content-type': 'application/json' },
      body: JSON.stringify({ connectionId: CONNECTION_ID }),
    }),
    404,
    { error: 'Not found' },
  )

  const installRow = { organizationId: ORG_ID, provider: 'github' }
  const failedAttach = sourceHttpDb({
    limitQueue: [
      [{ role: 'superadmin' }],
      [installRow],
      [installRow],
      [],
    ],
    insertId: null,
  })
  const second = await buildSourceApp(failedAttach)
  await expectJson(
    await second.app.request('/repositories/attach', {
      method: 'POST',
      headers: { ...authHeaders(second.cookie), 'content-type': 'application/json' },
      body: JSON.stringify({
        connectionId: CONNECTION_ID,
        repositoryExternalId: '99',
        repositoryUrl: 'https://github.com/acme/app.git',
      }),
    }),
    500,
    { error: 'Failed to attach repository' },
  )
})
