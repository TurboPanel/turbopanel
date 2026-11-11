import { assertEquals } from '@std/assert'
import {
  addAdminToolNameSuffix,
  adminToolLoginName,
  adminToolProjectName,
  parseAdminToolBody,
} from './names.ts'
import { adminToolMetadata, parseAdminToolMetadata } from './projects.ts'

/** Jest/Mocha-shaped alias so Sonar sees real tests. */
const test = Deno.test.bind(Deno)

test('the body defaults to Database Admin and lowercases the hostname', () => {
  const parsed = parseAdminToolBody({ tool: 'adminer', hostname: ' DB.Example.com ' })
  assertEquals(parsed, {
    ok: true,
    body: { tool: 'adminer', hostname: 'db.example.com', access: 'admin' },
  })
})

test('an unknown tool, a missing hostname and a bad access are refused', () => {
  const codes = [
    parseAdminToolBody({ tool: 'nope', hostname: 'a.example.com' }),
    parseAdminToolBody({ tool: 'adminer', hostname: '' }),
    parseAdminToolBody({ tool: 'adminer', hostname: 'a.example.com', access: 'owner' }),
  ].map((result) => (result.ok ? 'ok' : result.error))
  assertEquals(codes, ['admin_tool_unknown', 'invalid_hostname', 'admin_tool_access_invalid'])
})

test('the login name is the tool and six fixed characters when the random source is fixed', () => {
  assertEquals(
    adminToolLoginName('pgadmin', () => 0),
    'pgadmin_aaaaaa'
  )
  assertEquals(
    adminToolLoginName('adminer', () => 35),
    'adminer_999999'
  )
})

test('the project name is the cluster name and the label, with a number when taken', () => {
  assertEquals(adminToolProjectName('Main Database', 'pgAdmin'), 'Main Database pgAdmin')
  assertEquals(adminToolProjectName(null, 'pgAdmin'), 'pgAdmin')
  assertEquals(addAdminToolNameSuffix('X pgAdmin', 1), 'X pgAdmin')
  assertEquals(addAdminToolNameSuffix('X pgAdmin', 3), 'X pgAdmin 3')
})

test('metadata round-trips and a foreign project is not a tool', () => {
  const meta = adminToolMetadata({
    tool: 'pgadmin',
    managedId: 'm1',
    loginId: 'l1',
    loginName: 'pgadmin_aaaaaa',
    hostname: 'a.example.com',
    access: 'read-only',
    revision: 2,
    email: 'me@example.org',
  })
  assertEquals(parseAdminToolMetadata(meta), meta)
  assertEquals(parseAdminToolMetadata({ code: 'postgres' }), null)
  assertEquals(parseAdminToolMetadata(null), null)
})
