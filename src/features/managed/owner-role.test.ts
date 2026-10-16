import { assertEquals } from '@std/assert'
import {
  adminAccessNotes,
  DATABASE_ADMIN_PRIVILEGE,
  databasesOwnedByLogin,
  evaluateDatabaseAdminGrant,
  evaluateOwnedDatabasesKept,
  evaluateOwnerLogin,
  OWNER_ROLE_MAX_DATABASE_NAME,
  OWNER_ROLE_NEEDS_DAEMON_ERROR,
  resolveDatabaseOwnerRole,
} from './owner-role.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('a new Postgres database gets an owner role unless the name is too long or it is declined', () => {
  assertEquals(resolveDatabaseOwnerRole('postgres', 'shop', undefined), {
    ok: true,
    ownerRole: true,
  })
  assertEquals(resolveDatabaseOwnerRole('postgres', 'shop', true), {
    ok: true,
    ownerRole: true,
  })
  assertEquals(resolveDatabaseOwnerRole('postgres', 'shop', false), {
    ok: true,
    ownerRole: false,
  })
  const long = 'a'.repeat(OWNER_ROLE_MAX_DATABASE_NAME + 1)
  assertEquals(resolveDatabaseOwnerRole('postgres', long, undefined), {
    ok: true,
    ownerRole: false,
  })
  const asked = resolveDatabaseOwnerRole('postgres', long, true)
  assertEquals(!asked.ok && asked.error, 'managed_owner_role_name_too_long')
  const exact = 'a'.repeat(OWNER_ROLE_MAX_DATABASE_NAME)
  assertEquals(resolveDatabaseOwnerRole('postgres', exact, undefined), {
    ok: true,
    ownerRole: true,
  })
})

test('MySQL and MariaDB databases never get an owner role and refuse a request for one', () => {
  for (const engine of ['mysql', 'mariadb']) {
    assertEquals(resolveDatabaseOwnerRole(engine, 'shop', undefined), {
      ok: true,
      ownerRole: false,
    })
    const asked = resolveDatabaseOwnerRole(engine, 'shop', true)
    assertEquals(!asked.ok && asked.error, 'managed_owner_role_unsupported')
  }
  const bad = resolveDatabaseOwnerRole('postgres', 'shop', 'yes')
  assertEquals(!bad.ok && bad.status, 400)
})

test('a Database admin login is never read-only and is never refused over owner roles', () => {
  const grant = (over: Record<string, unknown> = {}) => ({
    privileges: [DATABASE_ADMIN_PRIVILEGE],
    connectionRole: 'read-write' as const,
    ...over,
  })
  assertEquals(evaluateDatabaseAdminGrant('postgres', grant()), null)
  const ro = evaluateDatabaseAdminGrant('postgres', grant({ connectionRole: 'read-only' }))
  assertEquals(ro?.error, 'managed_admin_login_not_read_only')
  assertEquals(ro?.status, 400)
  assertEquals(evaluateDatabaseAdminGrant('mysql', grant()), null)
  // Other privileges are not this rule's business.
  assertEquals(evaluateDatabaseAdminGrant('postgres', grant({ privileges: ['owner'] })), null)
})

test('an old daemon gets no owner role by default and a 409 when one is asked for', () => {
  assertEquals(resolveDatabaseOwnerRole('postgres', 'shop', undefined, false), {
    ok: true,
    ownerRole: false,
  })
  assertEquals(resolveDatabaseOwnerRole('postgres', 'shop', false, false), {
    ok: true,
    ownerRole: false,
  })
  const asked = resolveDatabaseOwnerRole('postgres', 'shop', true, false)
  assertEquals(asked.ok, false)
  if (!asked.ok) {
    assertEquals(asked.status, 409)
    assertEquals(asked.error, OWNER_ROLE_NEEDS_DAEMON_ERROR)
  }
  // MySQL never has one, whatever the daemon.
  assertEquals(resolveDatabaseOwnerRole('mysql', 'shop', undefined, false), {
    ok: true,
    ownerRole: false,
  })
})

test('admin access notes say what a Database admin login got and never refuse', () => {
  const grant = {
    privileges: [DATABASE_ADMIN_PRIVILEGE],
    databases: ['old', 'new'],
    ownerRoleDatabases: ['new'],
  }
  const full = { ownerRole: true, databaseOwner: true }
  // Databases made before owner roles: read and write there, said in plain words.
  const notes = adminAccessNotes('postgres', grant, full)
  assertEquals(notes.length, 1)
  assertEquals(notes[0]!.includes('old'), true)
  assertEquals(notes[0]!.includes('new'), false)
  assertEquals(notes[0]!.includes('read and write'), true)
  // A daemon with owner roles but not the fallback: connect only, said so.
  assertEquals(
    adminAccessNotes('postgres', grant, { ownerRole: true, databaseOwner: false })[0]!.includes(
      'connect only'
    ),
    true
  )
  // A daemon older than owner roles: the login is added as read/write.
  assertEquals(
    adminAccessNotes('postgres', grant, { ownerRole: false, databaseOwner: false })[0]!.includes(
      'older than owner roles'
    ),
    true
  )
  // Nothing to say when every database has an owner role, or it is not an admin login.
  assertEquals(
    adminAccessNotes('postgres', { ...grant, ownerRoleDatabases: ['old', 'new'] }, full),
    []
  )
  assertEquals(adminAccessNotes('postgres', { ...grant, privileges: ['owner'] }, full), [])
  assertEquals(adminAccessNotes('mysql', grant, full), [])
})

test('only a login that can change things, that the panel manages, may be chosen as the owner', () => {
  const login = (over: Record<string, unknown> = {}) => ({
    role: 'user',
    privileges: ['owner'],
    connectionRole: 'read-write' as const,
    grantMode: 'preset',
    ...over,
  })
  assertEquals(evaluateOwnerLogin(login()), null)
  assertEquals(evaluateOwnerLogin(login({ privileges: ['read-write'] })), null)
  for (const bad of [
    login({ role: 'root' }),
    login({ privileges: [DATABASE_ADMIN_PRIVILEGE] }),
    login({ privileges: ['read-only'] }),
    login({ connectionRole: 'read-only' }),
    login({ grantMode: 'self' }),
  ]) {
    const refusal = evaluateOwnerLogin(bad)
    assertEquals(refusal?.error, 'managed_owner_login_invalid')
    assertEquals(refusal?.status, 400)
  }
})

test('a login that owns databases has to stay able to own them', () => {
  const owners = { shop: { loginId: 'l1' }, blog: { loginId: 'l2' }, crm: { loginId: 'l1' } }
  assertEquals(databasesOwnedByLogin(owners, 'l1'), ['crm', 'shop'])
  assertEquals(databasesOwnedByLogin(undefined, 'l1'), [])
  const after = {
    databases: ['crm', 'shop'],
    privileges: ['owner'],
    connectionRole: 'read-write' as const,
    grantMode: 'preset',
  }
  assertEquals(evaluateOwnedDatabasesKept(['crm', 'shop'], after), null)
  assertEquals(evaluateOwnedDatabasesKept([], { ...after, privileges: ['read-only'] }), null)
  for (const change of [
    { databases: ['crm'] },
    { privileges: ['read-only'] },
    { connectionRole: 'read-only' as const },
    { grantMode: 'self' },
  ]) {
    const refusal = evaluateOwnedDatabasesKept(['crm', 'shop'], { ...after, ...change })
    assertEquals(refusal?.status, 409)
    assertEquals(refusal?.error, 'managed_login_owns_databases')
  }
})
