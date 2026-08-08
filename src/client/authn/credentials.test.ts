import { and, eq } from 'drizzle-orm'
import { assertEquals } from '@std/assert'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import { account, user } from '../../lib/db/schema.ts'
import {
  createEmptyMockAuthState,
  createMockAuthDb,
  seedMockCredentialUser,
  seedMockInstalledInstance,
  withMockLogin,
} from './authn-hostfree-doubles.ts'
import {
  PAM_ROOT_USERNAME,
  verifyCredentials,
} from './credentials.ts'
import { hashPassword } from './password.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

test('verifyCredentials returns false when db is undefined for non-root logins', async () => {
  const result = await verifyCredentials(
    'someone@example.com',
    'password',
    'workers',
  )
  assertEquals(result.ok, false)
})

test('verifyCredentials rejects unverified email addresses', async () => {
  if (!dbUrl) {
    console.warn('Skipping credentials DB test: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const email = `creds-unverified-${crypto.randomUUID()}@example.com`
  const password = 'Sup3r-secret!'
  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: false, role: 'user' })
    .returning({ id: user.id })
  const userId = insertedUser!.id

  try {
    await db.insert(account).values({
      userId,
      providerId: 'credential',
      providerUserId: userId,
      password: await hashPassword(password),
    })

    const result = await verifyCredentials(email, password, 'workers', db)
    assertEquals(result.ok, false)
    if (result.ok || result.reason !== 'email_not_verified') {
      throw new TypeError('expected email_not_verified rejection')
    }
  } finally {
    await db.delete(account).where(eq(account.userId, userId))
    await db.delete(user).where(eq(user.id, userId))
  }
})

test('verifyCredentials accepts verified credential users by email', async () => {
  if (!dbUrl) {
    console.warn('Skipping credentials DB test: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const email = `creds-verified-${crypto.randomUUID()}@example.com`
  const password = 'Sup3r-secret!'
  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })
  const userId = insertedUser!.id

  try {
    await db.insert(account).values({
      userId,
      providerId: 'credential',
      providerUserId: userId,
      password: await hashPassword(password),
    })

    const result = await verifyCredentials(email, password, 'workers', db)
    if (!result.ok || result.isRoot) {
      throw new TypeError('expected successful credential verification')
    }
    assertEquals(result.userId, userId)
    assertEquals(result.email, email)
  } finally {
    await db.delete(account).where(eq(account.userId, userId))
    await db.delete(user).where(eq(user.id, userId))
  }
})

test('verifyCredentials rejects disabled users and wrong passwords', async () => {
  if (!dbUrl) {
    console.warn('Skipping credentials DB test: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const email = `creds-disabled-${crypto.randomUUID()}@example.com`
  const password = 'Sup3r-secret!'
  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: 'user', isDisabled: true })
    .returning({ id: user.id })
  const userId = insertedUser!.id

  try {
    await db.insert(account).values({
      userId,
      providerId: 'credential',
      providerUserId: userId,
      password: await hashPassword(password),
    })

    const disabled = await verifyCredentials(email, password, 'workers', db)
    assertEquals(disabled.ok, false)

    await db
      .update(user)
      .set({ isDisabled: false })
      .where(eq(user.id, userId))

    const wrongPassword = await verifyCredentials(email, 'wrong-password', 'workers', db)
    assertEquals(wrongPassword.ok, false)
  } finally {
    await db.delete(account).where(and(eq(account.userId, userId)))
    await db.delete(user).where(eq(user.id, userId))
  }
})

test('verifyCredentials rejects root on Workers', async () => {
  const result = await verifyCredentials(
    PAM_ROOT_USERNAME,
    'any-password',
    'workers',
  )
  assertEquals(result.ok, false)
})

test('verifyCredentials accepts verified mock db user by email', async () => {
  const state = createEmptyMockAuthState()
  const userId = crypto.randomUUID()
  const email = 'mock-verified@example.com'
  const password = 'Sup3r-secret!'
  seedMockCredentialUser(state, {
    id: userId,
    email,
    password: await hashPassword(password),
    isEmailVerified: true,
  })
  const db = createMockAuthDb(withMockLogin(state, email))

  const result = await verifyCredentials(email, password, 'workers', db)
  if (!result.ok || result.isRoot) {
    throw new TypeError('expected mock credential verification to succeed')
  }
  assertEquals(result.userId, userId)
  assertEquals(result.email, email)
})

test('verifyCredentials rejects disabled mock db users', async () => {
  const state = createEmptyMockAuthState()
  const email = 'mock-disabled@example.com'
  seedMockCredentialUser(state, {
    id: crypto.randomUUID(),
    email,
    password: await hashPassword('Sup3r-secret!'),
    isDisabled: true,
  })
  const db = createMockAuthDb(withMockLogin(state, email))

  const result = await verifyCredentials(email, 'Sup3r-secret!', 'workers', db)
  assertEquals(result.ok, false)
})

test('verifyCredentials rejects wrong password against mock db user', async () => {
  const state = createEmptyMockAuthState()
  const email = 'mock-wrong-pass@example.com'
  seedMockCredentialUser(state, {
    id: crypto.randomUUID(),
    email,
    password: await hashPassword('Sup3r-secret!'),
  })
  const db = createMockAuthDb(withMockLogin(state, email))

  const result = await verifyCredentials(email, 'wrong-password', 'workers', db)
  assertEquals(result.ok, false)
})

test('verifyCredentials accepts root on Deno before install in dev group-only mode', async () => {
  const saved = new Map<string, string | undefined>()
  for (const key of [
    'TURBOPANEL_DEV_HOST_AUTH',
    'TURBOPANEL_DEV_SURFACE',
    'TURBOPANEL_MODE',
    'TURBOPANEL_UI_MODE',
  ] as const) {
    saved.set(key, Deno.env.get(key))
  }
  try {
    Deno.env.set('TURBOPANEL_DEV_HOST_AUTH', 'group-only')
    Deno.env.set('TURBOPANEL_MODE', 'development')
    Deno.env.set('TURBOPANEL_UI_MODE', 'dev')

    const db = createMockAuthDb(createEmptyMockAuthState())
    const result = await verifyCredentials(PAM_ROOT_USERNAME, 'any-password', 'deno', db)
    if (!result.ok || !result.isRoot) {
      throw new TypeError('expected root credential verification to succeed before install')
    }
    assertEquals(result.username, PAM_ROOT_USERNAME)
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) Deno.env.delete(key)
      else Deno.env.set(key, value)
    }
  }
})

test('verifyCredentials rejects root on Deno after mock install', async () => {
  const state = createEmptyMockAuthState()
  seedMockInstalledInstance(state)
  const db = createMockAuthDb(state)
  const result = await verifyCredentials(PAM_ROOT_USERNAME, 'any-password', 'deno', db)
  assertEquals(result.ok, false)
})
