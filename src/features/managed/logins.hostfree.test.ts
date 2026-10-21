import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import {
  applySettingsPatch,
  DATABASE_LOGIN_ROLES,
  isLoginGrantMode,
  isManagedLoginNameTakenInFamily,
  managedProtocolFamilyEngines,
  withoutPassword,
} from './logins.ts'

const test = Deno.test.bind(Deno)

test('the login roles are the three the table allows', () => {
  assertEquals([...DATABASE_LOGIN_ROLES], ['root', 'replication', 'user'])
})

test('withoutPassword drops the credential and keeps every other field', () => {
  const row = {
    id: 'l1',
    principalId: 'p1',
    managedId: 'm1',
    role: 'user' as const,
    username: 'app',
    appliedUsername: 'app',
    nameScheme: 'plain' as const,
    grantMode: 'preset' as const,
    tool: false,
    databases: ['app'],
    privileges: ['read-write'],
    connectionRole: 'read-write' as const,
    allowedSources: undefined,
    maxConnections: undefined,
    createdAt: 'now',
    updatedAt: 'now',
    password: 'tpsecret.v1.x',
  }
  const { password: _password, ...rest } = row
  assertEquals(withoutPassword(row), rest)
  assertEquals('password' in withoutPassword(row), false)
})

test('applySettingsPatch keeps unset settings and clears limits on null', () => {
  const before = {
    grantMode: 'recipe' as const,
    tool: false,
    databases: ['a'],
    privileges: ['read-write'],
    connectionRole: 'read-write' as const,
    allowedSources: ['internal'],
    maxConnections: 5,
    straightThrough: true,
  }
  assertEquals(applySettingsPatch(before, {}), before)
  assertEquals(applySettingsPatch(before, { straightThrough: null }).straightThrough, undefined)
  assertEquals(applySettingsPatch(before, { straightThrough: false }).straightThrough, false)
  assertEquals(
    applySettingsPatch(before, { allowedSources: null, maxConnections: null, tool: true }),
    { ...before, allowedSources: undefined, maxConnections: undefined, tool: true }
  )
  assertEquals(isLoginGrantMode('self'), true)
  assertEquals(isLoginGrantMode('bogus'), false)
})

test('managedProtocolFamilyEngines: mysql and mariadb share a family, postgres is apart', () => {
  assertEquals(managedProtocolFamilyEngines('mysql'), ['mysql', 'mariadb'])
  assertEquals(managedProtocolFamilyEngines('mariadb'), ['mysql', 'mariadb'])
  assertEquals(managedProtocolFamilyEngines('postgres'), ['postgres'])
  assertEquals(managedProtocolFamilyEngines('redis'), [])
})

test('isManagedLoginNameTakenInFamily skips the query for blank names and non-frontend engines', async () => {
  assertEquals(await isManagedLoginNameTakenInFamily({} as Db, 'm1', 'postgres', '  '), false)
  assertEquals(await isManagedLoginNameTakenInFamily({} as Db, 'm1', 'redis', 'app'), false)
})
