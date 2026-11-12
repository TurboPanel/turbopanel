import { assert, assertEquals } from '@std/assert'
import type { Db } from '../../../db/connection.ts'
import { parseCreateProjectMetadata } from '../../../client/projects/routes-helpers.ts'
import { ADMIN_TOOL_LOGIN_SOURCES, adminToolLoginGrants } from './login-settings.ts'
import { addDatabasesToAdminToolLogins } from './projects.ts'
import { unlistFromLogins } from './unlist.ts'

/** Jest/Mocha-shaped alias so Sonar sees real tests. */
const test = Deno.test.bind(Deno)

type Inserted = { loginId: string; databaseId: string }

/** A drizzle stand-in: the tool-login select answers `toolLoginIds`; inserts are recorded. */
function fakeDb(toolLoginIds: string[]) {
  const inserted: Inserted[][] = []
  const conflictGuarded: boolean[] = []
  const chain = {
    select: () => chain,
    from: () => chain,
    innerJoin: () => chain,
    where: () => Promise.resolve(toolLoginIds.map((loginId) => ({ loginId }))),
    insert: () => ({
      values: (rows: Inserted[]) => {
        inserted.push(rows)
        return {
          onConflictDoNothing: () => {
            conflictGuarded.push(true)
            return Promise.resolve()
          },
        }
      },
    }),
  }
  return { db: chain as unknown as Db, inserted, conflictGuarded }
}

// 8. The scope sync

test('a new database is listed on every tool login and only on them, once each', async () => {
  const { db, inserted, conflictGuarded } = fakeDb(['tool-a', 'tool-b', 'tool-a'])
  await addDatabasesToAdminToolLogins(db, 'm1', ['db-1', 'db-2'])
  assertEquals(inserted.length, 1)
  assertEquals(inserted[0], [
    { loginId: 'tool-a', databaseId: 'db-1' },
    { loginId: 'tool-a', databaseId: 'db-2' },
    { loginId: 'tool-b', databaseId: 'db-1' },
    { loginId: 'tool-b', databaseId: 'db-2' },
  ])
  // A repeat is a no-op because the insert ignores a row that exists.
  assertEquals(conflictGuarded, [true])
})

test('nothing is written when there is no tool login or no new database', async () => {
  const none = fakeDb([])
  await addDatabasesToAdminToolLogins(none.db, 'm1', ['db-1'])
  const noDatabases = fakeDb(['tool-a'])
  await addDatabasesToAdminToolLogins(noDatabases.db, 'm1', [])
  assertEquals(none.inserted, [])
  assertEquals(noDatabases.inserted, [])
})

// 9. The drop

test('the drop unlists the database from every tool login and can put it back', async () => {
  const events: string[] = []
  const unlisting = await unlistFromLogins(['a', 'b'], (id) => {
    events.push(`unlist ${id}`)
    return Promise.resolve({
      restore: () => {
        events.push(`restore ${id}`)
        return Promise.resolve()
      },
    })
  })
  assertEquals(events, ['unlist a', 'unlist b'])
  await unlisting.restore()
  assertEquals(events.slice(2), ['restore a', 'restore b'])
})

test('a login that is gone is skipped when restoring', async () => {
  const unlisting = await unlistFromLogins(['a'], () => Promise.resolve(null))
  await unlisting.restore()
})

// The fixed settings of a tool login

test('a tool login is a tool login with explicit grants on every non-reserved database', () => {
  const admin = adminToolLoginGrants({
    access: 'admin',
    engine: 'postgres',
    clusterDatabases: ['app', 'shop'],
  })
  assertEquals(admin, {
    privileges: ['admin'],
    connectionRole: 'read-write',
    databases: ['app', 'shop'],
    tool: true,
    allDatabases: false,
    grantMode: 'recipe',
  })
  const readOnly = adminToolLoginGrants({
    access: 'read-only',
    engine: 'mysql',
    clusterDatabases: ['mysql', 'app'],
  })
  assertEquals(readOnly.privileges, ['read-only'])
  assertEquals(readOnly.connectionRole, 'read-only')
  assertEquals(readOnly.databases, ['app'])
  assertEquals([...ADMIN_TOOL_LOGIN_SOURCES], ['internal'])
})

// The marker stays trustworthy

test('a caller cannot set the admin tool marker through project create', () => {
  const parsed = parseCreateProjectMetadata({
    metadata: { code: 'admin-tool', managedId: 'm1', loginId: 'l1', note: 'kept' },
  })
  assert(parsed.ok)
  assertEquals(parsed.metadata?.code, undefined)
  assertEquals(parsed.metadata?.note, 'kept')
})
