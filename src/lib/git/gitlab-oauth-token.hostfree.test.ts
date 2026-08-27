import { assertEquals, assertRejects } from '@std/assert'
import { deriveEncryptionSecretsConfig } from '../../client/authn/secrets.ts'
import { encryptSecret } from '../../client/authn/data-encryption.ts'
import type { Db } from '../../db.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { gitConnection } from '../db/schema.ts'
import {
  GitlabOauthTokenError,
  exchangeGitlabAuthorizationCode,
  gitlabAuthorizeUrl,
  type GitlabOauthCredentials,
  mintGitlabAccessToken,
  persistGitlabTokenPair,
  refreshGitlabAccessToken,
} from './gitlab-oauth-token.ts'
import {
  GITLAB_DEFAULT_BASE_URL,
  GITLAB_OAUTH_SCOPES,
} from './forge-records.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('gitlabAuthorizeUrl builds the OAuth authorize endpoint', () => {
  const url = gitlabAuthorizeUrl(
    { baseUrl: GITLAB_DEFAULT_BASE_URL, clientId: 'app-id' },
    {
      redirectUri: 'https://203.0.113.10:8443/api/client/v1/repositories/gitlab/oauth/callback',
      state: 'csrf-token',
    },
  )
  const parsed = new URL(url)
  assertEquals(parsed.origin, 'https://gitlab.com')
  assertEquals(parsed.pathname, '/oauth/authorize')
  assertEquals(parsed.searchParams.get('client_id'), 'app-id')
  assertEquals(
    parsed.searchParams.get('redirect_uri'),
    'https://203.0.113.10:8443/api/client/v1/repositories/gitlab/oauth/callback',
  )
  assertEquals(parsed.searchParams.get('response_type'), 'code')
  assertEquals(parsed.searchParams.get('state'), 'csrf-token')
  assertEquals(parsed.searchParams.get('scope'), GITLAB_OAUTH_SCOPES)
})

test('gitlabAuthorizeUrl respects a self-managed GitLab base URL', () => {
  const url = gitlabAuthorizeUrl(
    { baseUrl: 'https://git.example.lan', clientId: 'self-hosted' },
    { redirectUri: 'https://203.0.113.20/callback', state: 's' },
  )
  const parsed = new URL(url)
  assertEquals(parsed.origin, 'https://git.example.lan')
  assertEquals(parsed.pathname, '/oauth/authorize')
})

const oauthConfig: GitlabOauthCredentials = {
  clientId: 'app-id',
  clientSecret: 'app-secret',
  baseUrl: GITLAB_DEFAULT_BASE_URL,
}

function withFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    return Promise.resolve(handler(url, init))
  }) as typeof fetch
  return fn().finally(() => {
    globalThis.fetch = original
  })
}

test('exchangeGitlabAuthorizationCode posts the authorization-code grant', async () => {
  await withFetch((url, init) => {
    assertEquals(url, 'https://gitlab.com/oauth/token')
    assertEquals(init?.method, 'POST')
    const body = String(init?.body ?? '')
    assertEquals(body.includes('grant_type=authorization_code'), true)
    assertEquals(body.includes('code=auth-code'), true)
    assertEquals(
      body.includes('redirect_uri=https%3A%2F%2F203.0.113.10%2Fcallback'),
      true,
    )
    return new Response(
      JSON.stringify({
        access_token: 'glpat-access',
        refresh_token: 'glpat-refresh',
        expires_in: 3600,
        scope: 'api read_repository',
      }),
      { status: 200 },
    )
  }, async () => {
    const pair = await exchangeGitlabAuthorizationCode(oauthConfig, {
      code: 'auth-code',
      redirectUri: 'https://203.0.113.10/callback',
    })
    assertEquals(pair.token, 'glpat-access')
    assertEquals(pair.refreshToken, 'glpat-refresh')
    assertEquals(pair.scope, 'api read_repository')
    assertEquals(Number.isNaN(Date.parse(pair.expiresAt)), false)
  })
})

test('refreshGitlabAccessToken posts the refresh grant and defaults lifetime', async () => {
  await withFetch((url, init) => {
    assertEquals(url, 'https://gitlab.com/oauth/token')
    const body = String(init?.body ?? '')
    assertEquals(body.includes('grant_type=refresh_token'), true)
    assertEquals(body.includes('refresh_token=old-refresh'), true)
    return new Response(
      JSON.stringify({ access_token: 'glpat-new' }),
      { status: 200 },
    )
  }, async () => {
    const pair = await refreshGitlabAccessToken(oauthConfig, 'old-refresh')
    assertEquals(pair.token, 'glpat-new')
    assertEquals(pair.refreshToken, null)
    assertEquals(pair.scope, null)
  })
})

test('gitlab token exchange maps error_description from GitLab', async () => {
  await withFetch(
    () =>
      new Response(
        JSON.stringify({ error_description: 'The provided authorization grant is invalid' }),
        { status: 400 },
      ),
    async () => {
      const error = await assertRejects(
        () =>
          exchangeGitlabAuthorizationCode(oauthConfig, {
            code: 'bad',
            redirectUri: 'https://203.0.113.10/callback',
          }),
        GitlabOauthTokenError,
        'authorization grant is invalid',
      )
      if (!(error instanceof GitlabOauthTokenError)) {
        throw new TypeError('expected GitlabOauthTokenError')
      }
      assertEquals(error.status, 400)
    },
  )
})

test('gitlab token exchange falls back through message, error, then status', async () => {
  await withFetch(
    () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 401 }),
    async () => {
      await assertRejects(
        () => refreshGitlabAccessToken(oauthConfig, 'x'),
        GitlabOauthTokenError,
        'invalid_grant',
      )
    },
  )
  await withFetch(
    () => new Response('not-json', { status: 502 }),
    async () => {
      await assertRejects(
        () => refreshGitlabAccessToken(oauthConfig, 'x'),
        GitlabOauthTokenError,
        'gitlab request failed (502)',
      )
    },
  )
  await withFetch(
    () => new Response('', { status: 503 }),
    async () => {
      await assertRejects(
        () => refreshGitlabAccessToken(oauthConfig, 'x'),
        GitlabOauthTokenError,
        'gitlab request failed (503)',
      )
    },
  )
})

test('gitlab token exchange rejects a payload with no access_token', async () => {
  await withFetch(
    () => new Response(JSON.stringify({ refresh_token: 'only-refresh' }), { status: 200 }),
    async () => {
      await assertRejects(
        () => refreshGitlabAccessToken(oauthConfig, 'x'),
        GitlabOauthTokenError,
        'returned no token',
      )
    },
  )
})

test('gitlab token exchange wraps network failures', async () => {
  await withFetch(
    () => {
      throw new Error('tls handshake failed')
    },
    async () => {
      await assertRejects(
        () => refreshGitlabAccessToken(oauthConfig, 'x'),
        GitlabOauthTokenError,
        'tls handshake failed',
      )
    },
  )
})

test('gitlab token exchange wraps non-Error network failures', async () => {
  await withFetch(
    () => {
      throw 42
    },
    async () => {
      await assertRejects(
        () => refreshGitlabAccessToken(oauthConfig, 'x'),
        GitlabOauthTokenError,
        'network error',
      )
    },
  )
})

type GitlabDb = Db & {
  updated: unknown
}

/**
 * The OAuth application now arrives through an installation → gitapp join
 * rather than a singleton `setting` row; `innerJoin` distinguishes the reads.
 */
function gitlabDb(opts: {
  app?: Record<string, unknown> | null
  installation?: Record<string, unknown> | null
}): GitlabDb {
  const joined = () => ({
    where: () => ({
      limit: () => Promise.resolve(opts.app ? [{ app: opts.app }] : []),
    }),
  })
  const db = {
    updated: undefined as unknown,
    select: () => ({
      from: (table: unknown) => ({
        innerJoin: joined,
        where: () => ({
          limit: () => {
            if (table === gitConnection) {
              return Promise.resolve(opts.installation ? [opts.installation] : [])
            }
            return Promise.resolve([])
          },
        }),
      }),
    }),
    update: () => ({
      set: (values: unknown) => ({
        where: () => {
          db.updated = values
          return Promise.resolve(undefined)
        },
      }),
    }),
  }
  return db as unknown as GitlabDb
}

async function sealedOauthApp() {
  const secrets = await deriveEncryptionSecretsConfig(
    parseTestSecretsConfig('deno'),
    'data-encryption',
  )
  return {
    secrets,
    app: {
      id: 'app-1',
      organizationId: null,
      provider: 'gitlab',
      name: 'TurboPanel',
      baseUrl: GITLAB_DEFAULT_BASE_URL,
      apiUrl: null,
      externalAppId: 'app-id',
      appSlug: null,
      clientId: 'app-id',
      redirectUri: null,
      webhookRef: 'ref-1',
      webhookTokenHash: null,
      envelopes: {
        clientSecretEnvelope: await encryptSecret(secrets, 'app-secret'),
      },
    },
  }
}

test('persistGitlabTokenPair seals the pair and keeps a stored refresh token', async () => {
  const secrets = await deriveEncryptionSecretsConfig(
    parseTestSecretsConfig('deno'),
    'data-encryption',
  )
  const storedRefresh = await encryptSecret(secrets, 'kept-refresh')
  const db = gitlabDb({
    installation: { oauthEnvelope: { refreshTokenEnvelope: storedRefresh } },
  })
  await persistGitlabTokenPair(db, secrets, 'install-1', {
    token: 'new-access',
    refreshToken: null,
    expiresAt: '2030-06-01T00:00:00.000Z',
    scope: 'api',
  })
  const updated = db.updated as {
    oauthEnvelope: {
      accessTokenEnvelope: string
      refreshTokenEnvelope: string
      expiresAt: string
      scope: string
    }
  }
  if (typeof updated?.oauthEnvelope?.accessTokenEnvelope !== 'string') {
    throw new TypeError('expected sealed access token envelope')
  }
  assertEquals(updated.oauthEnvelope.refreshTokenEnvelope, storedRefresh)
  assertEquals(updated.oauthEnvelope.expiresAt, '2030-06-01T00:00:00.000Z')
  assertEquals(updated.oauthEnvelope.scope, 'api')
})

test('persistGitlabTokenPair writes a rotated refresh token', async () => {
  const secrets = await deriveEncryptionSecretsConfig(
    parseTestSecretsConfig('deno'),
    'data-encryption',
  )
  const db = gitlabDb({ installation: { oauthEnvelope: {} } })
  await persistGitlabTokenPair(db, secrets, 'install-1', {
    token: 'access',
    refreshToken: 'rotated',
    expiresAt: '2030-06-01T00:00:00.000Z',
    scope: null,
  })
  const updated = db.updated as {
    oauthEnvelope: { refreshTokenEnvelope?: string; scope?: string }
  }
  if (typeof updated?.oauthEnvelope?.refreshTokenEnvelope !== 'string') {
    throw new TypeError('expected sealed refresh token envelope')
  }
  assertEquals(updated.oauthEnvelope.scope, undefined)
})

test('mintGitlabAccessToken returns a still-valid sealed access token', async () => {
  const { secrets, app } = await sealedOauthApp()
  const access = await encryptSecret(secrets, 'still-valid')
  const db = gitlabDb({
    app,
    installation: {
      provider: 'gitlab',
      suspendedAt: null,
      oauthEnvelope: {
        accessTokenEnvelope: access,
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
    },
  })
  const minted = await mintGitlabAccessToken(db, secrets, 'install-1')
  assertEquals(minted.token, 'still-valid')
  assertEquals(minted.expiresAt, '2099-01-01T00:00:00.000Z')
})

test('mintGitlabAccessToken refreshes and writes back an expired pair', async () => {
  const { secrets, app } = await sealedOauthApp()
  const refresh = await encryptSecret(secrets, 'refresh-me')
  const db = gitlabDb({
    app,
    installation: {
      provider: 'gitlab',
      suspendedAt: null,
      oauthEnvelope: {
        refreshTokenEnvelope: refresh,
        expiresAt: '2000-01-01T00:00:00.000Z',
      },
    },
  })

  await withFetch(
    () =>
      new Response(
        JSON.stringify({
          access_token: 'glpat-fresh',
          refresh_token: 'glpat-rotated',
          expires_in: 7200,
        }),
        { status: 200 },
      ),
    async () => {
      const minted = await mintGitlabAccessToken(db, secrets, 'install-1')
      assertEquals(minted.token, 'glpat-fresh')
      const updated = db.updated as { oauthEnvelope: { expiresAt: string } }
      if (typeof updated?.oauthEnvelope?.expiresAt !== 'string') {
        throw new TypeError('expected persisted oauth envelope')
      }
    },
  )
})

test('mintGitlabAccessToken rejects missing config, row, provider, and suspension', async () => {
  const secrets = await deriveEncryptionSecretsConfig(
    parseTestSecretsConfig('deno'),
    'data-encryption',
  )
  // The application is resolved *through* the installation now, so a missing
  // installation reports itself rather than being blamed on configuration.
  await assertRejects(
    () => mintGitlabAccessToken(gitlabDb({}), secrets, 'install-1'),
    GitlabOauthTokenError,
    'installation not found',
  )

  // A live installation whose app row is gone is the configuration failure —
  // reached only on the refresh path, which is the only place the app is read.
  const unconfigured = await deriveEncryptionSecretsConfig(
    parseTestSecretsConfig('deno'),
    'data-encryption',
  )
  const staleRefresh = await encryptSecret(unconfigured, 'refresh-me')
  await assertRejects(
    () =>
      mintGitlabAccessToken(
        gitlabDb({
          app: null,
          installation: {
            provider: 'gitlab',
            suspendedAt: null,
            oauthEnvelope: {
              refreshTokenEnvelope: staleRefresh,
              expiresAt: '2000-01-01T00:00:00.000Z',
            },
          },
        }),
        unconfigured,
        'install-1',
      ),
    GitlabOauthTokenError,
    'gitlab oauth application is not configured',
  )

  const { secrets: sealedSecrets, app } = await sealedOauthApp()
  await assertRejects(
    () =>
      mintGitlabAccessToken(
        gitlabDb({ app, installation: null }),
        sealedSecrets,
        'missing',
      ),
    GitlabOauthTokenError,
    'installation not found',
  )
  await assertRejects(
    () =>
      mintGitlabAccessToken(
        gitlabDb({
          app,
          installation: { provider: 'github', suspendedAt: null, oauthEnvelope: {} },
        }),
        sealedSecrets,
        'install-1',
      ),
    GitlabOauthTokenError,
    'unsupported installation provider "github"',
  )
  const suspended = await assertRejects(
    () =>
      mintGitlabAccessToken(
        gitlabDb({
          app,
          installation: {
            provider: 'gitlab',
            suspendedAt: '2030-01-01T00:00:00.000Z',
            oauthEnvelope: {},
          },
        }),
        sealedSecrets,
        'install-1',
      ),
    GitlabOauthTokenError,
    'installation is suspended',
  )
  if (!(suspended instanceof GitlabOauthTokenError)) {
    throw new TypeError('expected GitlabOauthTokenError')
  }
  assertEquals(suspended.status, 409)
})

test('mintGitlabAccessToken rejects unsealed envelopes and a missing refresh token', async () => {
  const { secrets, app } = await sealedOauthApp()
  await assertRejects(
    () =>
      mintGitlabAccessToken(
        gitlabDb({
          app,
          installation: {
            provider: 'gitlab',
            suspendedAt: null,
            oauthEnvelope: {
              accessTokenEnvelope: 'not-sealed',
              expiresAt: '2099-01-01T00:00:00.000Z',
            },
          },
        }),
        secrets,
        'install-1',
      ),
    GitlabOauthTokenError,
    'gitlab access token is not sealed',
  )
  await assertRejects(
    () =>
      mintGitlabAccessToken(
        gitlabDb({
          app,
          installation: {
            provider: 'gitlab',
            suspendedAt: null,
            oauthEnvelope: { expiresAt: 'not-a-date' },
          },
        }),
        secrets,
        'install-1',
      ),
    GitlabOauthTokenError,
    'gitlab connection has no refresh token',
  )
  await assertRejects(
    () =>
      mintGitlabAccessToken(
        gitlabDb({
          app,
          installation: {
            provider: 'gitlab',
            suspendedAt: null,
            oauthEnvelope: { refreshTokenEnvelope: 'plaintext-refresh' },
          },
        }),
        secrets,
        'install-1',
      ),
    GitlabOauthTokenError,
    'gitlab refresh token is not sealed',
  )
})
