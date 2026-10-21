import { assertEquals, assertThrows } from '@std/assert'
import { dirname, fromFileUrl, join } from '@std/path'
import { buildGrantStatements, quoteIdent, readRoleNames } from './grant-database-roles.mjs'

/** Alias so Sonar recognizes the suite (see check-deploy-env.test.ts). */
const test = Deno.test.bind(Deno)

test('role names must be plain identifiers and are quoted', () => {
  assertEquals(quoteIdent('production_cached'), '"production_cached"')
  assertThrows(() => quoteIdent('x"; drop table y; --'))
  assertThrows(() => quoteIdent(''))
})

test('role names come from the environment; the runtime role is required', () => {
  assertThrows(() => readRoleNames({}), Error, 'TURBOPANEL_RUNTIME_DB_ROLE is required')
  assertEquals(readRoleNames({ TURBOPANEL_RUNTIME_DB_ROLE: ' app ' }), {
    runtime: 'app',
    cached: null,
  })
  assertThrows(
    () => readRoleNames({ TURBOPANEL_RUNTIME_DB_ROLE: 'a', TURBOPANEL_CACHED_DB_ROLE: 'a' }),
    Error,
    'must differ'
  )
})

test('statements cover schema, tables, default privileges, and the cached tables only', () => {
  const statements = buildGrantStatements({ runtime: 'app', cached: 'app_cached' }, ['server'])
  assertEquals(statements.includes('GRANT USAGE ON SCHEMA public TO "app"'), true)
  assertEquals(
    statements.includes(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "app"'
    ),
    true
  )
  assertEquals(statements.at(-1), 'GRANT SELECT ON public."server" TO "app_cached"')
  assertEquals(buildGrantStatements({ runtime: 'app', cached: null }, []).length, 5)
})

test('the cached table list matches the cached read models', async () => {
  const root = join(dirname(fromFileUrl(import.meta.url)), '..', '..')
  const dir = join(root, 'src', 'query-cache', 'read-models')
  const text: string[] = []
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && !entry.name.includes('.test.')) {
      text.push(await Deno.readTextFile(join(dir, entry.name)))
    }
  }
  const source = text.join('\n')
  for (const table of ['server', 'license', 'project', 'environment', 'workspace']) {
    assertEquals(new RegExp(`\\b${table}\\b`).test(source), true, table)
  }
})
