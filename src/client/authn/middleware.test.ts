import { eq } from 'drizzle-orm'
import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from './crypto.ts'
import {
  createAdminAccessMiddleware,
  createDeveloperAccessMiddleware,
  createRootOnlyMiddleware,
  createSessionMiddleware,
  resolveRootSession,
  resolveSession,
} from './middleware.ts'
import { createSession } from './session-store.ts'
import {
  deriveSecretsConfig,
  parseSecretsEnv,
  type DerivedSecretsConfig,
} from './secrets.ts'
import { session, user } from '../../lib/db/schema.ts'
import { TEST_ONLY_TURBOPANEL_SECRET, parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import {
  createEmptyMockAuthState,
  createMockAuthDb,
  readJsonBody,
  seedMockSession,
} from './authn-hostfree-doubles.ts'
import type { SessionData } from './session-store.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()
const V2_SECRET = 'Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll2_Mm3Nn4Oo5Pp6Qq7Rr8'

function sessionSigningSecrets(): Promise<DerivedSecretsConfig> {
  const config = parseSecretsEnv(`2:${V2_SECRET},1:${TEST_ONLY_TURBOPANEL_SECRET}`,
    'deno')
  return deriveSecretsConfig(config, 'session-signing')
}

async function signedCookieForUser(
  db: ReturnType<typeof createDenoDb>,
  secrets: DerivedSecretsConfig,
  userId: string,
  signWithCurrent = true,
): Promise<string> {
  const { token } = await createSession(db, userId, {})
  const signingSecrets = signWithCurrent
    ? secrets
    : await deriveSecretsConfig(
      parseTestSecretsConfig('deno'),
      'session-signing',
    )
  return await buildSignedCookie(token, signingSecrets)
}

async function withRoleUser(
  role: 'user' | 'admin' | 'superadmin',
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    userId: string
    secrets: DerivedSecretsConfig
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping middleware DB test: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const secrets = await sessionSigningSecrets()
  const email = `middleware-${role}-${crypto.randomUUID()}@example.com`
  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role })
    .returning({ id: user.id })
  const userId = insertedUser!.id

  try {
    await fn({ db, userId, secrets })
  } finally {
    await db.delete(session).where(eq(session.userId, userId))
    await db.delete(user).where(eq(user.id, userId))
  }
}

test('createSessionMiddleware rejects missing cookies', async () => {
  const secrets = await sessionSigningSecrets()
  const app = new Hono<AppEnv>()
  app.use('*', createSessionMiddleware(secrets))
  app.get('/protected', (c) => c.json({ ok: true }))

  const res = await app.request('http://localhost/protected')
  assertEquals(res.status, 401)
  const body = await readJsonBody<{ error: string }>(res)
  assertEquals(body.error, 'Unauthorized')
})

test('resolveSession and resolveRootSession return null without a cookie', async () => {
  const secrets = await sessionSigningSecrets()
  const app = new Hono<AppEnv>()
  app.get('/probe', async (c) => {
    const resolved = await resolveSession(c, secrets)
    const root = await resolveRootSession(c, secrets)
    return c.json({ resolved: resolved !== null, root: root !== null })
  })

  const res = await app.request('http://localhost/probe')
  assertEquals(res.status, 200)
  const body = await readJsonBody<{ resolved: boolean; root: boolean }>(res)
  assertEquals(body.resolved, false)
  assertEquals(body.root, false)
})

test('resolveSession rejects tampered cookie signatures', async () => {
  const secrets = await sessionSigningSecrets()
  const app = new Hono<AppEnv>()
  app.get('/probe', async (c) => {
    const resolved = await resolveSession(c, secrets)
    return c.json({ resolved: resolved !== null })
  })

  const res = await app.request('http://localhost/probe', {
    headers: { Cookie: `${HTTP_SESSION_COOKIE_NAME}=not-a-valid-cookie` },
  })
  assertEquals(res.status, 200)
  const body = await readJsonBody<{ resolved: boolean }>(res)
  assertEquals(body.resolved, false)
})

test('createSessionMiddleware accepts a valid signed session cookie', async () => {
  await withRoleUser('user', async ({ db, userId, secrets }) => {
    const app = new Hono<AppEnv>()
    app.use('*', (c, next) => {
      c.set('db', db)
      c.set('runtime', 'deno')
      return next()
    })
    app.use('*', createSessionMiddleware(secrets))
    app.get('/protected', (c) => {
      const session = c.get('session')
      if (!session) throw new TypeError('expected session')
      return c.json({ ok: true, userId: session.userId })
    })

    const cookie = await signedCookieForUser(db, secrets, userId)
    const res = await app.request('http://localhost/protected', {
      headers: { Cookie: `${HTTP_SESSION_COOKIE_NAME}=${cookie}` },
    })
    assertEquals(res.status, 200)
    const body = await readJsonBody<{ userId: string }>(res)
    assertEquals(body.userId, userId)
  })
})

test('createRootOnlyMiddleware allows superadmin and rejects regular users', async () => {
  await withRoleUser('superadmin', async ({ db, userId, secrets }) => {
    const app = new Hono<AppEnv>()
    app.use('*', (c, next) => {
      c.set('db', db)
      c.set('runtime', 'deno')
      return next()
    })
    app.use('*', createRootOnlyMiddleware(secrets))
    app.get('/root', (c) => c.json({ ok: true }))

    const cookie = await signedCookieForUser(db, secrets, userId)
    const res = await app.request('http://localhost/root', {
      headers: { Cookie: `${HTTP_SESSION_COOKIE_NAME}=${cookie}` },
    })
    assertEquals(res.status, 200)
  })

  await withRoleUser('user', async ({ db, userId, secrets }) => {
    const app = new Hono<AppEnv>()
    app.use('*', (c, next) => {
      c.set('db', db)
      c.set('runtime', 'deno')
      return next()
    })
    app.use('*', createRootOnlyMiddleware(secrets))
    app.get('/root', (c) => c.json({ ok: true }))

    const cookie = await signedCookieForUser(db, secrets, userId)
    const res = await app.request('http://localhost/root', {
      headers: { Cookie: `${HTTP_SESSION_COOKIE_NAME}=${cookie}` },
    })
    assertEquals(res.status, 403)
  })
})

test('createAdminAccessMiddleware accepts admin and rejects regular users', async () => {
  await withRoleUser('admin', async ({ db, userId, secrets }) => {
    const app = new Hono<AppEnv>()
    app.use('*', (c, next) => {
      c.set('db', db)
      c.set('runtime', 'deno')
      return next()
    })
    app.use('*', createAdminAccessMiddleware(secrets))
    app.get('/admin', (c) => c.json({ ok: true }))

    const cookie = await signedCookieForUser(db, secrets, userId)
    const res = await app.request('http://localhost/admin', {
      headers: { Cookie: `${HTTP_SESSION_COOKIE_NAME}=${cookie}` },
    })
    assertEquals(res.status, 200)
  })

  await withRoleUser('user', async ({ db, userId, secrets }) => {
    const app = new Hono<AppEnv>()
    app.use('*', (c, next) => {
      c.set('db', db)
      c.set('runtime', 'deno')
      return next()
    })
    app.use('*', createAdminAccessMiddleware(secrets))
    app.get('/admin', (c) => c.json({ ok: true }))

    const cookie = await signedCookieForUser(db, secrets, userId)
    const res = await app.request('http://localhost/admin', {
      headers: { Cookie: `${HTTP_SESSION_COOKIE_NAME}=${cookie}` },
    })
    assertEquals(res.status, 403)
  })
})

test('resolveSession rotates cookies signed with a fallback key', async () => {
  await withRoleUser('user', async ({ db, userId, secrets }) => {
    const app = new Hono<AppEnv>()
    app.use('*', (c, next) => {
      c.set('db', db)
      c.set('runtime', 'deno')
      return next()
    })
    app.get('/session', async (c) => {
      const resolved = await resolveSession(c, secrets, db)
      return c.json({ ok: Boolean(resolved), rotated: resolved?.rotated ?? false })
    })

    const cookie = await signedCookieForUser(db, secrets, userId, false)
    const res = await app.request('http://localhost/session', {
      headers: { Cookie: `${HTTP_SESSION_COOKIE_NAME}=${cookie}` },
    })
    assertEquals(res.status, 200)
    const body = await readJsonBody<{ ok: boolean; rotated: boolean }>(res)
    assertEquals(body.ok, true)
    assertEquals(body.rotated, true)
    assertEquals(res.headers.get('Set-Cookie')?.includes('Max-Age='), true)
  })
})

async function mockSessionApp(
  secrets: DerivedSecretsConfig,
  sessionRow: SessionData,
  token: string,
) {
  const state = createEmptyMockAuthState()
  seedMockSession(state, token, sessionRow)
  const db = createMockAuthDb(state)
  const signed = await buildSignedCookie(token, secrets)
  return { db, signed, secrets }
}

test('resolveRootSession returns null for non-superadmin mock session', async () => {
  const secrets = await sessionSigningSecrets()
  const token = crypto.randomUUID()
  const { db, signed } = await mockSessionApp(secrets, {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    email: 'admin@example.com',
    role: 'admin',
  }, token)

  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('runtime', 'deno')
    return next()
  })
  app.get('/root', async (c) => {
    const root = await resolveRootSession(c, secrets, db)
    return c.json({ root: root?.email ?? null })
  })

  const res = await app.request('http://localhost/root', {
    headers: { Cookie: `${HTTP_SESSION_COOKIE_NAME}=${signed}` },
  })
  const body = await readJsonBody<{ root: string | null }>(res)
  assertEquals(body.root, null)
})

test('createDeveloperAccessMiddleware rejects non-superadmin sessions', async () => {
  const secrets = await sessionSigningSecrets()
  const token = crypto.randomUUID()
  const { db, signed } = await mockSessionApp(secrets, {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    email: 'user@example.com',
    role: 'user',
  }, token)

  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('runtime', 'deno')
    return next()
  })
  app.use('*', createDeveloperAccessMiddleware(secrets))
  app.get('/dev', (c) => c.json({ ok: true }))

  const res = await app.request('http://localhost/dev', {
    headers: { Cookie: `${HTTP_SESSION_COOKIE_NAME}=${signed}` },
  })
  assertEquals(res.status, 403)
})

test('createDeveloperAccessMiddleware allows superadmin mock session', async () => {
  const secrets = await sessionSigningSecrets()
  const token = crypto.randomUUID()
  const { db, signed } = await mockSessionApp(secrets, {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    email: 'root@example.com',
    role: 'superadmin',
  }, token)

  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('runtime', 'deno')
    return next()
  })
  app.use('*', createDeveloperAccessMiddleware(secrets))
  app.get('/dev', (c) => c.json({ ok: true }))

  const res = await app.request('http://localhost/dev', {
    headers: { Cookie: `${HTTP_SESSION_COOKIE_NAME}=${signed}` },
  })
  assertEquals(res.status, 200)
})

test('createDeveloperAccessMiddleware returns 401 without credentials', async () => {
  const secrets = await sessionSigningSecrets()
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('runtime', 'deno')
    return next()
  })
  app.use('*', createDeveloperAccessMiddleware(secrets))
  app.get('/dev', (c) => c.json({ ok: true }))

  const res = await app.request('http://localhost/dev')
  assertEquals(res.status, 401)
})

test('createSessionMiddleware accepts mock superadmin session without postgres', async () => {
  const secrets = await sessionSigningSecrets()
  const token = crypto.randomUUID()
  const userId = crypto.randomUUID()
  const { db, signed } = await mockSessionApp(secrets, {
    sessionId: crypto.randomUUID(),
    userId,
    email: 'root@example.com',
    role: 'superadmin',
  }, token)

  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('runtime', 'deno')
    return next()
  })
  app.use('*', createSessionMiddleware(secrets))
  app.get('/protected', (c) => {
    const session = c.get('session')
    if (!session) throw new TypeError('expected session')
    return c.json({ userId: session.userId })
  })

  const res = await app.request('http://localhost/protected', {
    headers: { Cookie: `${HTTP_SESSION_COOKIE_NAME}=${signed}` },
  })
  assertEquals(res.status, 200)
  const body = await readJsonBody<{ userId: string }>(res)
  assertEquals(body.userId, userId)
})

test('createAdminAccessMiddleware accepts mock admin and rejects users', async () => {
  const secrets = await sessionSigningSecrets()
  const token = crypto.randomUUID()

  const adminState = createEmptyMockAuthState()
  seedMockSession(adminState, token, {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    email: 'admin@example.com',
    role: 'admin',
  })
  const adminDb = createMockAuthDb(adminState)
  const adminSigned = await buildSignedCookie(token, secrets)
  const adminApp = new Hono<AppEnv>()
  adminApp.use('*', (c, next) => {
    c.set('db', adminDb)
    c.set('runtime', 'deno')
    return next()
  })
  adminApp.use('*', createAdminAccessMiddleware(secrets))
  adminApp.get('/admin', (c) => c.json({ ok: true }))
  assertEquals(
    (await adminApp.request('http://localhost/admin', {
      headers: { Cookie: `${HTTP_SESSION_COOKIE_NAME}=${adminSigned}` },
    })).status,
    200,
  )

  const userToken = crypto.randomUUID()
  const userState = createEmptyMockAuthState()
  seedMockSession(userState, userToken, {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    email: 'user@example.com',
    role: 'user',
  })
  const userDb = createMockAuthDb(userState)
  const userSigned = await buildSignedCookie(userToken, secrets)
  const userApp = new Hono<AppEnv>()
  userApp.use('*', (c, next) => {
    c.set('db', userDb)
    c.set('runtime', 'deno')
    return next()
  })
  userApp.use('*', createAdminAccessMiddleware(secrets))
  userApp.get('/admin', (c) => c.json({ ok: true }))
  assertEquals(
    (await userApp.request('http://localhost/admin', {
      headers: { Cookie: `${HTTP_SESSION_COOKIE_NAME}=${userSigned}` },
    })).status,
    403,
  )
})

test('createRootOnlyMiddleware accepts mock superadmin and rejects users', async () => {
  const secrets = await sessionSigningSecrets()
  const token = crypto.randomUUID()
  const state = createEmptyMockAuthState()
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    email: 'root@example.com',
    role: 'superadmin',
  })
  const db = createMockAuthDb(state)
  const signed = await buildSignedCookie(token, secrets)

  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('runtime', 'deno')
    return next()
  })
  app.use('*', createRootOnlyMiddleware(secrets))
  app.get('/root', (c) => c.json({ ok: true }))
  assertEquals(
    (await app.request('http://localhost/root', {
      headers: { Cookie: `${HTTP_SESSION_COOKIE_NAME}=${signed}` },
    })).status,
    200,
  )

  const userToken = crypto.randomUUID()
  const userState = createEmptyMockAuthState()
  seedMockSession(userState, userToken, {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    email: 'user@example.com',
    role: 'user',
  })
  const userDb = createMockAuthDb(userState)
  const userSigned = await buildSignedCookie(userToken, secrets)
  const userApp = new Hono<AppEnv>()
  userApp.use('*', (c, next) => {
    c.set('db', userDb)
    c.set('runtime', 'deno')
    return next()
  })
  userApp.use('*', createRootOnlyMiddleware(secrets))
  userApp.get('/root', (c) => c.json({ ok: true }))
  assertEquals(
    (await userApp.request('http://localhost/root', {
      headers: { Cookie: `${HTTP_SESSION_COOKIE_NAME}=${userSigned}` },
    })).status,
    403,
  )
})

test('resolveSession rotates fallback-signed cookies with mock db', async () => {
  const secrets = await sessionSigningSecrets()
  const legacySecrets = await deriveSecretsConfig(
    parseTestSecretsConfig('deno'),
    'session-signing',
  )
  const token = crypto.randomUUID()
  const state = createEmptyMockAuthState()
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    email: 'user@example.com',
    role: 'user',
  })
  const db = createMockAuthDb(state)
  const signed = await buildSignedCookie(token, legacySecrets)

  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('runtime', 'deno')
    return next()
  })
  app.get('/session', async (c) => {
    const resolved = await resolveSession(c, secrets, db)
    return c.json({ ok: Boolean(resolved), rotated: resolved?.rotated ?? false })
  })

  const res = await app.request('http://localhost/session', {
    headers: { Cookie: `${HTTP_SESSION_COOKIE_NAME}=${signed}` },
  })
  assertEquals(res.status, 200)
  const body = await readJsonBody<{ ok: boolean; rotated: boolean }>(res)
  assertEquals(body.ok, true)
  assertEquals(body.rotated, true)
  assertEquals(res.headers.get('Set-Cookie')?.includes('Max-Age='), true)
})
