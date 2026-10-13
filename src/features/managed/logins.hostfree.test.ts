import { assertEquals } from '@std/assert'
import {
  DATABASE_LOGIN_ROLES,
  legacyPrincipalIdOf,
  loginRoleFromMetadata,
  withoutPassword,
} from './logins.ts'

const test = Deno.test.bind(Deno)

test('loginRoleFromMetadata reads the legacy principal flags', () => {
  assertEquals(loginRoleFromMetadata({ managedRoot: true }), 'root')
  assertEquals(loginRoleFromMetadata({ managedReplication: true }), 'replication')
  assertEquals(loginRoleFromMetadata({ engine: 'postgres' }), 'user')
  assertEquals(loginRoleFromMetadata(null), 'user')
  assertEquals(loginRoleFromMetadata('managedRoot'), 'user')
  for (const role of DATABASE_LOGIN_ROLES) {
    assertEquals(typeof role, 'string')
  }
})

test('legacyPrincipalIdOf is the old row of a cluster login, nothing else', () => {
  assertEquals(legacyPrincipalIdOf({ legacyPrincipalId: 'p1' }), 'p1')
  assertEquals(legacyPrincipalIdOf({ legacyPrincipalId: '' }), null)
  assertEquals(legacyPrincipalIdOf({ legacyPrincipalId: 7 }), null)
  assertEquals(legacyPrincipalIdOf({}), null)
  assertEquals(legacyPrincipalIdOf(undefined), null)
})

test('withoutPassword drops the credential and keeps every other field', () => {
  const row = {
    id: 'l1',
    principalId: 'p1',
    managedId: 'm1',
    role: 'user' as const,
    username: 'app',
    appliedUsername: 'app',
    metadata: null,
    options: null,
    createdAt: 'now',
    updatedAt: 'now',
    password: 'tpsecret.v1.x',
  }
  const { password: _password, ...rest } = row
  assertEquals(withoutPassword(row), rest)
  assertEquals('password' in withoutPassword(row), false)
})
