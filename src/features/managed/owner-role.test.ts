import { assertEquals } from '@std/assert'
import {
  DATABASE_ADMIN_PRIVILEGE,
  evaluateDatabaseAdminGrant,
  OWNER_ROLE_MAX_DATABASE_NAME,
  OWNER_ROLE_NEEDS_DAEMON_ERROR,
  READWRITE_NEEDS_DAEMON_ERROR,
  refuseAdminGrantOnOldDaemon,
  refuseReadWriteOnOldDaemon,
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

test('a Database admin login needs an owner role on Postgres and is never read-only', () => {
  const grant = (over: Record<string, unknown> = {}) => ({
    privileges: [DATABASE_ADMIN_PRIVILEGE],
    databases: ['shop'],
    connectionRole: 'read-write' as const,
    ownerRoleDatabases: ['shop'],
    ...over,
  })
  assertEquals(evaluateDatabaseAdminGrant('postgres', grant()), null)
  const none = evaluateDatabaseAdminGrant('postgres', grant({ ownerRoleDatabases: undefined }))
  assertEquals(none?.error, 'managed_admin_needs_owner_role')
  assertEquals(none?.status, 422)
  const ro = evaluateDatabaseAdminGrant('postgres', grant({ connectionRole: 'read-only' }))
  assertEquals(ro?.error, 'managed_admin_login_not_read_only')
  // MySQL and MariaDB have no owner roles: admin is ALL on the listed databases.
  assertEquals(evaluateDatabaseAdminGrant('mysql', grant({ ownerRoleDatabases: [] })), null)
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

test('a Database admin login on a Postgres primary needs the owner-role feature', () => {
  const refused = refuseAdminGrantOnOldDaemon('postgres', [DATABASE_ADMIN_PRIVILEGE], false)
  assertEquals(refused?.status, 409)
  assertEquals(refused?.error, OWNER_ROLE_NEEDS_DAEMON_ERROR)
  assertEquals(refuseAdminGrantOnOldDaemon('postgres', [DATABASE_ADMIN_PRIVILEGE], true), null)
  assertEquals(refuseAdminGrantOnOldDaemon('postgres', ['select'], false), null)
  assertEquals(refuseAdminGrantOnOldDaemon('mysql', [DATABASE_ADMIN_PRIVILEGE], false), null)
})

const rw = { privileges: ['read-write'], grantMode: 'recipe' }

test('a new MySQL or MariaDB read/write login needs the data-only daemon', () => {
  for (const engine of ['mysql', 'mariadb']) {
    const refused = refuseReadWriteOnOldDaemon(engine, rw, null, false)
    assertEquals(refused?.error, READWRITE_NEEDS_DAEMON_ERROR)
    assertEquals(refused?.status, 409)
    assertEquals(refuseReadWriteOnOldDaemon(engine, rw, null, true), null)
  }
})

test('the data-only daemon rule leaves other levels, modes, engines and held logins alone', () => {
  assertEquals(refuseReadWriteOnOldDaemon('postgres', rw, null, false), null)
  for (const privileges of [['read-only'], ['owner'], ['admin']]) {
    assertEquals(
      refuseReadWriteOnOldDaemon('mysql', { privileges, grantMode: 'recipe' }, null, false),
      null
    )
  }
  // A manage-myself login is never written by the panel.
  assertEquals(refuseReadWriteOnOldDaemon('mysql', { ...rw, grantMode: 'self' }, null, false), null)
  // Already panel-managed read/write: nothing new is asked of the daemon.
  assertEquals(refuseReadWriteOnOldDaemon('mysql', rw, rw, false), null)
  assertEquals(refuseReadWriteOnOldDaemon('mysql', rw, { ...rw, grantMode: 'preset' }, false), null)
  // A database it did not reach before is new to an older daemon.
  assertEquals(
    refuseReadWriteOnOldDaemon(
      'mysql',
      { ...rw, databases: ['a', 'b'] },
      { ...rw, databases: ['a'] },
      false
    )?.error,
    READWRITE_NEEDS_DAEMON_ERROR
  )
  assertEquals(
    refuseReadWriteOnOldDaemon(
      'mysql',
      { ...rw, databases: ['a'] },
      { ...rw, databases: ['a', 'b'] },
      false
    ),
    null
  )
  // Moving a manage-myself login back to panel-set read/write, or adding the level, is new.
  assertEquals(
    refuseReadWriteOnOldDaemon('mysql', rw, { ...rw, grantMode: 'self' }, false)?.error,
    READWRITE_NEEDS_DAEMON_ERROR
  )
  assertEquals(
    refuseReadWriteOnOldDaemon(
      'mysql',
      rw,
      { privileges: ['read-only'], grantMode: 'recipe' },
      false
    )?.error,
    READWRITE_NEEDS_DAEMON_ERROR
  )
})
