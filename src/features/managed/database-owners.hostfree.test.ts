import { assertEquals } from '@std/assert'
import {
  describeDatabaseOwners,
  handedBackNotes,
  loginPatchOwnerChecks,
  ownerChoiceConflict,
  ownersAfterCreate,
  ownedDatabasesRefusal,
  ownersWithoutDatabase,
  ownersWithoutLogin,
  restoringOnFailure,
  withDatabaseListed,
  withoutDatabaseListed,
} from './database-owners.ts'

const test = Deno.test.bind(Deno)

test('describeDatabaseOwners names the owner of each owner-role database only', () => {
  assertEquals(
    describeDatabaseOwners({
      databases: ['legacy', 'shop', 'blog'],
      ownerRoleDatabases: ['shop', 'blog', 'gone'],
      databaseOwners: { shop: { loginId: 'l1', username: 'app_x' } },
    }),
    {
      shop: { kind: 'login', loginId: 'l1', username: 'app_x' },
      blog: { kind: 'role', role: 'tp_blog_owner' },
    }
  )
  assertEquals(describeDatabaseOwners({ databases: ['legacy'] }), {})
})

test('database lists and owner entries change one thing at a time', () => {
  const settings = { databases: ['a', 'b'] }
  assertEquals(withDatabaseListed(settings, 'c'), ['a', 'b', 'c'])
  assertEquals(withDatabaseListed(settings, 'a'), ['a', 'b'])
  assertEquals(withoutDatabaseListed(settings, 'a'), ['b'])
  assertEquals(withoutDatabaseListed({ databases: [] }, 'a'), [])
  const owners = { x: { loginId: 'l1', username: 'u1' }, y: { loginId: 'l2', username: 'u2' } }
  assertEquals(ownersWithoutLogin(owners, 'l1'), { y: owners.y })
  assertEquals(ownersWithoutDatabase(owners, 'y'), { x: owners.x })
  assertEquals(ownersWithoutDatabase(undefined, 'y'), {})
})

test('ownedDatabasesRefusal reads the login after the change', () => {
  const options = { databaseOwners: { shop: { loginId: 'l1', username: 'u1' } } }
  const ok = {
    databases: ['shop'],
    privileges: ['owner'],
    connectionRole: 'read-write' as const,
  }
  assertEquals(ownedDatabasesRefusal(options, 'l1', ok, 'recipe'), null)
  assertEquals(ownedDatabasesRefusal(options, 'other', { ...ok, databases: [] }, 'recipe'), null)
  assertEquals(
    ownedDatabasesRefusal(options, 'l1', { ...ok, connectionRole: 'read-only' }, 'recipe')?.error,
    'managed_login_owns_databases'
  )
  assertEquals(
    ownedDatabasesRefusal(options, 'l1', { ...ok, databases: [] }, 'recipe')?.status,
    409
  )
})

test('restoringOnFailure restores on a refusal and on a throw, not on success', async () => {
  let restored = 0
  const restore = () => {
    restored++
    return Promise.resolve()
  }
  assertEquals(await restoringOnFailure(restore, () => Promise.resolve(7)), 7)
  assertEquals(restored, 0)
  await restoringOnFailure(restore, () => Promise.resolve(new Response('no', { status: 409 })))
  assertEquals(restored, 1)
  let thrown = false
  try {
    await restoringOnFailure(restore, () => Promise.reject(new Error('x')))
  } catch {
    thrown = true
  }
  assertEquals(thrown, true)
  assertEquals(restored, 2)
})

test('small owner helpers answer the way the routes need', () => {
  assertEquals(handedBackNotes([]), {})
  assertEquals(handedBackNotes(['a', 'b']).notes?.[0]?.includes('a, b'), true)
  assertEquals(ownerChoiceConflict(null, false), null)
  assertEquals(ownerChoiceConflict({}, true), null)
  assertEquals(ownerChoiceConflict({}, false)?.error, 'Invalid request')
  const chosen = { login: { id: 'l1', appliedUsername: 'u1' } }
  assertEquals(ownersAfterCreate(undefined, 'shop', chosen), {
    shop: { loginId: 'l1', username: 'u1' },
  })
  assertEquals(ownersAfterCreate({ a: { loginId: 'x', username: 'y' } }, 'shop', null), {
    a: { loginId: 'x', username: 'y' },
  })
  const checks = loginPatchOwnerChecks(
    'postgres',
    { databaseOwners: { shop: { loginId: 'l1', username: 'u1' } }, ownerRoleDatabases: [] },
    {
      id: 'l1',
      grantMode: 'recipe',
      tool: false,
      databases: ['shop'],
      privileges: ['owner'],
      connectionRole: 'read-write',
      allowedSources: undefined,
      maxConnections: undefined,
    },
    { patch: { privileges: ['admin'] }, grantMode: 'recipe' },
    { ownerRole: true, databaseOwner: true }
  )
  assertEquals(checks.refusal?.error, 'managed_login_owns_databases')
  assertEquals(checks.notes.length, 1)
})
