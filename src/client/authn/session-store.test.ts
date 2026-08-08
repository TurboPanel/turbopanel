import { and, eq } from 'drizzle-orm'
import { assertEquals, assertRejects } from '@std/assert'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import { session, user } from '../../lib/db/schema.ts'
import {
  ADMIN_ROLE,
  createSession,
  deleteSession,
  deleteSessionsByUserId,
  getSession,
  isAdminRole,
  isSuperadminRole,
  SUPERADMIN_ROLE,
} from './session-store.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

test('isSuperadminRole recognizes only the superadmin role', () => {
  assertEquals(isSuperadminRole(SUPERADMIN_ROLE), true)
  assertEquals(isSuperadminRole(ADMIN_ROLE), false)
  assertEquals(isSuperadminRole('user'), false)
  assertEquals(isSuperadminRole(null), false)
  assertEquals(isSuperadminRole(undefined), false)
})

test('isAdminRole includes superadmin and admin', () => {
  assertEquals(isAdminRole(SUPERADMIN_ROLE), true)
  assertEquals(isAdminRole(ADMIN_ROLE), true)
  assertEquals(isAdminRole('user'), false)
  assertEquals(isAdminRole(null), false)
})

test('getSession returns null when db is undefined', async () => {
  assertEquals(await getSession(undefined, 'missing-token'), null)
})

test('deleteSession and deleteSessionsByUserId no-op when db is undefined', async () => {
  await deleteSession(undefined, 'token')
  await deleteSessionsByUserId(undefined, crypto.randomUUID())
})

test('createSession rejects undefined db', async () => {
  await assertRejects(
    () => createSession(undefined, crypto.randomUUID(), {}),
    Error,
    'Database unavailable',
  )
})

test('createSession stores a retrievable session with metadata', async () => {
  if (!dbUrl) {
    console.warn('Skipping session-store DB test: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const email = `session-store-${crypto.randomUUID()}@example.com`
  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })
  const userId = insertedUser!.id

  try {
    const { token } = await createSession(db, userId, {
      ipAddress: '203.0.113.1',
      userAgent: 'session-store-test',
    })

    const data = await getSession(db, token)
    if (!data) {
      throw new TypeError('expected session data after createSession')
    }
    assertEquals(data.userId, userId)
    assertEquals(data.email, email)
    assertEquals(data.role, 'user')
  } finally {
    await db.delete(session).where(eq(session.userId, userId))
    await db.delete(user).where(eq(user.id, userId))
  }
})

test('getSession returns null for disabled users', async () => {
  if (!dbUrl) {
    console.warn('Skipping disabled-user session test: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const email = `session-disabled-${crypto.randomUUID()}@example.com`
  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: 'user', isDisabled: true })
    .returning({ id: user.id })
  const userId = insertedUser!.id

  try {
    const { token } = await createSession(db, userId, {})
    assertEquals(await getSession(db, token), null)
  } finally {
    await db.delete(session).where(eq(session.userId, userId))
    await db.delete(user).where(eq(user.id, userId))
  }
})

test('deleteSession removes the row and deleteSessionsByUserId clears all sessions', async () => {
  if (!dbUrl) {
    console.warn('Skipping session delete test: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const email = `session-delete-${crypto.randomUUID()}@example.com`
  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })
  const userId = insertedUser!.id

  try {
    const first = await createSession(db, userId, {})
    const second = await createSession(db, userId, {})
    assertEquals((await getSession(db, first.token))?.userId, userId)

    await deleteSession(db, first.token)
    assertEquals(await getSession(db, first.token), null)
    assertEquals((await getSession(db, second.token))?.userId, userId)

    await deleteSessionsByUserId(db, userId)
    assertEquals(await getSession(db, second.token), null)

    const remaining = await db
      .select({ id: session.id })
      .from(session)
      .where(and(eq(session.userId, userId)))
    assertEquals(remaining.length, 0)
  } finally {
    await db.delete(session).where(eq(session.userId, userId))
    await db.delete(user).where(eq(user.id, userId))
  }
})
