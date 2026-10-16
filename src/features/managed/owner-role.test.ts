import { assertEquals } from '@std/assert'
import {
  DATABASE_ADMIN_PRIVILEGE,
  evaluateDatabaseAdminGrant,
  OWNER_ROLE_MAX_DATABASE_NAME,
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
