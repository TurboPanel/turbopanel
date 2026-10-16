import { assertEquals } from '@std/assert'
import { describeDatabaseOwners } from './database-owners.ts'

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
