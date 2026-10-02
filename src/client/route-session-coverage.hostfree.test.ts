/**
 * Session coverage for every route the client API mounts.
 *
 * Builds the real client router (`registerClientRoutes`) and calls every
 * mounted method + path twice:
 *
 * - without a cookie: every route outside {@link PUBLIC_ROUTES} must answer 401
 *   (a 2xx, 4xx or 5xx there means the handler ran without a session: fail-open);
 * - with a valid signed session cookie: no route may answer 401 (a session gap
 *   that locks real users out: the #212/#213 class), except the temporary
 *   {@link PENDING_212} entries.
 *
 * The database is a stub that answers the session lookup and returns no rows
 * for anything else, so handlers stop at their first lookup (404/403/400). Only
 * the status class matters here, never the body. Host-free: no network, no
 * Postgres; `fetch` is stubbed to fail.
 */
import { assert, assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../app/app.ts'
import type { Db } from '../db/connection.ts'
import { session } from '../db/schema.ts'
import { deriveEncryptionSecretsConfig, deriveSecretsConfig } from '../lib/secrets/secrets.ts'
import { forEachSequential } from '../lib/sequential.ts'
import { parseTestSecretsConfig } from '../test-fixtures/secrets.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from './authn/crypto.ts'
import { ORG_ID_HEADER } from './org-context.ts'
import { registerClientRoutes } from './routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const PREFIX = '/api/client/v1'
const ID = '11111111-1111-4111-8111-111111111111'
const TIMEOUT_MS = 10_000

/** Routes that answer without a session, each with the reason. Exact `METHOD path`. */
const PUBLIC_ROUTES: Record<string, string> = {
  'POST /auth/sign-in': 'exchanges credentials for a session',
  'POST /auth/sign-out': 'clears the cookie; idempotent without a session',
  'POST /auth/sign-up': 'creates the account the session will belong to',
  'GET /auth/verify-email': 'emailed verification link, opened signed out',
  'POST /auth/send-otp': 'requests a sign-in code before any session exists',
  'POST /auth/verify-otp': 'verifies an emailed code before any session exists',
  'POST /auth/sign-in/otp': 'signs in with an emailed code',
  'POST /auth/sign-in/2fa': 'second factor of a sign-in; carries a pending-2FA token',
  'POST /auth/reset-password/request-otp': 'password reset is for users who cannot sign in',
  'POST /auth/reset-password/otp': 'password reset is for users who cannot sign in',
  'POST /auth/request-password-reset': 'password reset is for users who cannot sign in',
  'GET /auth/reset-password/:token': 'emailed reset link; the token is the credential',
  'POST /auth/reset-password': 'completes a reset; the token is the credential',
  'GET /auth/invitations/by-token/:token': 'invitation landing; the link secret is the credential',
  'POST /auth/invitations/by-token/:token/sign-up': 'new invitee creates an account from the link',
  'GET /auth/invitations/:id': 'legacy `?id=` landing; organization and state only',
  'POST /auth/passkeys/login/options': 'passkey sign-in challenge',
  'POST /auth/passkeys/login/verify': 'passkey sign-in assertion',
  'GET /auth/oauth/:provider/start': 'OAuth sign-in redirect',
  'GET /auth/oauth/:provider/callback': 'OAuth provider redirect back; signed state',
  'GET /status': 'install and sign-up state, read before anyone signs in',
  'GET /notification-channels/verify/:token':
    'emailed channel confirm link; token is the credential',
  'GET /openapi.json': 'public API description',
  'GET /reference': 'public API reference page',
}

/**
 * TEMPORARY: handlers that answer 401 even with a valid session, because their
 * paths have no session middleware. turbopanel#212 fixes exactly these five;
 * delete this list with it. Never add to it: a new entry is a new lockout.
 */
const PENDING_212: ReadonlySet<string> = new Set([
  'GET /organizations/:id/audit',
  'GET /organizations/:id/deploy-hooks',
  'PUT /organizations/:id/deploy-hooks',
  'GET /organizations/:id/compose-resource-defaults',
  'PUT /organizations/:id/compose-resource-defaults',
])

const SESSION_ROW = {
  sessionId: ID,
  userId: ID,
  email: 'route-coverage@example.com',
  role: 'user',
  isDisabled: false,
  createdAt: '2026-01-01T00:00:00.000Z',
}

/**
 * A drizzle-shaped query: every builder method chains, awaiting it resolves
 * rows. Only the session lookup (`from(session)`) finds anything.
 */
function stubQuery(): unknown {
  let rows: unknown[] = []
  const builder: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
            Promise.resolve(rows).then(resolve, reject)
        }
        return (...args: unknown[]) => {
          if (prop === 'from' && args[0] === session) rows = [SESSION_ROW]
          return builder
        }
      },
    }
  )
  return builder
}

function stubDb(): Db {
  const db: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') return undefined
        if (prop === 'transaction') return (fn: (tx: unknown) => unknown) => fn(db)
        if (prop === 'execute') return () => Promise.resolve([])
        return () => stubQuery()
      },
    }
  )
  return db as Db
}

type Route = { key: string; method: string; url: string }

async function buildClientApp(): Promise<{ app: Hono<AppEnv>; cookie: string }> {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption'
  )
  const db = stubDb()
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('runtime', 'deno')
    c.set('secretsConfig', secretsConfig)
    c.set('dataEncryptionSecrets', dataEncryptionSecrets)
    return next()
  })
  registerClientRoutes(app, { secrets, runtime: 'deno', signupEnvOverride: undefined })
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie('session-token', secrets)}`
  return { app, cookie }
}

/** Every mounted handler once, keyed `METHOD path` relative to the client prefix. */
function mountedRoutes(app: Hono<AppEnv>): Route[] {
  const routes = new Map<string, Route>()
  for (const route of app.routes) {
    if (route.method === 'ALL' || !route.path.startsWith(PREFIX)) continue
    const path = route.path.slice(PREFIX.length)
    const key = `${route.method} ${path}`
    const url = route.path
      .replaceAll(':provider', 'github')
      .replaceAll(/:[A-Za-z]+(\{[^}]*\})?\??/g, ID)
      .replaceAll('*', 'x')
    routes.set(key, { key, method: route.method, url: `http://localhost${url}` })
  }
  return [...routes.values()]
}

/** Status, or `null` when the handler did not answer in time. */
async function statusOf(app: Hono<AppEnv>, route: Route, cookie?: string): Promise<number | null> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    origin: 'http://localhost',
    [ORG_ID_HEADER]: ID,
  }
  if (cookie) headers.cookie = cookie
  const hasBody = !['GET', 'HEAD', 'DELETE'].includes(route.method)
  const answer = Promise.resolve(
    app.request(route.url, { method: route.method, headers, body: hasBody ? '{}' : undefined })
  ).then(async (res) => {
    await res.body?.cancel()
    return res.status
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), TIMEOUT_MS)
  })
  try {
    return await Promise.race([answer, timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function withoutNetwork<T>(fn: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch
  globalThis.fetch = (() => Promise.reject(new TypeError('network disabled'))) as typeof fetch
  try {
    return await fn()
  } finally {
    globalThis.fetch = realFetch
  }
}

type Check = {
  name: string
  cookie: boolean
  /** Routes this check skips. */
  exempt: (key: string) => boolean
  /** A failure message for `status`, or null when it is fine. */
  verdict: (status: number) => string | null
}

const CHECKS: Check[] = [
  {
    name: 'without a cookie every non-public client route answers 401',
    cookie: false,
    exempt: (key) => key in PUBLIC_ROUTES,
    verdict: (status) => (status === 401 ? null : `answered ${status} without a session`),
  },
  {
    name: 'with a valid session cookie no client route answers 401',
    cookie: true,
    exempt: (key) => key in PUBLIC_ROUTES || PENDING_212.has(key),
    verdict: (status) => (status === 401 ? 'answered 401 with a valid session' : null),
  },
]

for (const check of CHECKS) {
  test(`route session coverage: ${check.name}`, async () => {
    const { app, cookie } = await buildClientApp()
    const routes = mountedRoutes(app)
    assert(routes.length > 300, `expected the full client route list, found ${routes.length}`)
    const failures: string[] = []
    // Sequential on purpose: `fetch` is swapped globally for the whole run.
    await withoutNetwork(() =>
      forEachSequential(
        routes.filter((entry) => !check.exempt(entry.key)),
        async (route) => {
          const status = await statusOf(app, route, check.cookie ? cookie : undefined)
          const problem = status === null ? 'no answer in time' : check.verdict(status)
          if (problem) failures.push(`${route.key}: ${problem}`)
        }
      )
    )
    assertEquals(failures, [], failures.join('\n'))
  })
}

test('route session coverage: every allowance names a mounted route', async () => {
  const { app } = await buildClientApp()
  const mounted = new Set(mountedRoutes(app).map((route) => route.key))
  const stale = [...Object.keys(PUBLIC_ROUTES), ...PENDING_212].filter((key) => !mounted.has(key))
  assertEquals(stale, [], 'allowance entries with no mounted route')
})
