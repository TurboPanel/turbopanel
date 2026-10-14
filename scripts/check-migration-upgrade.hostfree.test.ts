/**
 * Pure parts of the upgrade-from-the-previous-release check: which tag counts
 * as the previous release, scratch URLs, and the row and schema diffs. The
 * database run itself is `pnpm check:migration-upgrade` (CI deno db-1).
 */
import { assertEquals, assertThrows } from '@std/assert'
import {
  addBreakingOkAllowance,
  diffRows,
  diffSchemas,
  newestStableTag,
  withDatabase,
} from './check-migration-upgrade.mjs'

/** Alias so Sonar recognizes the suite (see check-deploy-env.test.ts). */
const test = Deno.test.bind(Deno)

/** Split so the secret scanner's credentials-in-URL rule does not fire on fixtures. */
const PG = 'postgresql:' + '//'

test('previous release ignores release candidates and sorts numerically', () => {
  assertEquals(
    newestStableTag(['v0.1.13-rc.2', 'v0.1.9', 'v0.1.13', 'v0.1.10', 'v0.1.13-rc.1']),
    'v0.1.13'
  )
  assertEquals(newestStableTag(['v0.2.0', 'v0.10.0', 'v0.9.12']), 'v0.10.0')
  assertEquals(newestStableTag(['v1.0.0-rc.1', 'latest', '']), null)
})

test('scratch URL swaps only the database name', () => {
  assertEquals(
    withDatabase(`${PG}u:p@127.0.0.1:5432/turbopanel?sslmode=disable`, 'tp_upgrade_check_1_up'),
    `${PG}u:p@127.0.0.1:5432/tp_upgrade_check_1_up?sslmode=disable`
  )
  assertEquals(
    withDatabase(`${PG}u:p@/turbopanel?host=/run/turbopanel/postgres`, 'scratch'),
    `${PG}u:p@/scratch?host=/run/turbopanel/postgres`
  )
  assertThrows(() => withDatabase('not a url', 'scratch'))
})

test('row diff allows new columns but not lost rows or rewritten values', () => {
  const before = new Map([
    ['ip(1)', { id: '1', address: '203.0.113.10', description: 'a' }],
    ['ip(2)', { id: '2', address: '2001:db8::20', description: null }],
    ['login(3)', { id: '3', role: 'user' }],
  ])
  const after = new Map([
    ['ip(1)', { id: '1', address: '203.0.113.10', description: 'a', is_primary: true }],
    ['ip(2)', { id: '2', address: '2001:db8::20', description: 'rewritten' }],
  ])
  assertEquals(diffRows(before, after), [
    'ip(2): description was null, now "rewritten"',
    'login(3): row missing after upgrade',
  ])
})

test('row diff reports a dropped column', () => {
  const before = new Map([['ip(1)', { id: '1', description: 'a' }]])
  const after = new Map([['ip(1)', { id: '1' }]])
  assertEquals(diffRows(before, after), ['ip(1): column description gone after upgrade'])
})

const CONTRACT = `-- breaking-ok: contract step for the expand shipped in the previous release
ALTER TABLE "ip" DROP COLUMN "description";--> statement-breakpoint
ALTER TABLE ip RENAME COLUMN scope TO reach;--> statement-breakpoint
ALTER TABLE "public"."login" RENAME TO "dblogin";--> statement-breakpoint
ALTER TABLE "ip" RENAME CONSTRAINT "a" TO "b";--> statement-breakpoint
DROP TABLE IF EXISTS "subnet", hosting CASCADE;`

test('breaking-ok migrations name what they drop or rename', () => {
  const allowance = addBreakingOkAllowance(CONTRACT)
  assertEquals([...allowance.droppedTables], ['subnet', 'hosting'])
  assertEquals([...allowance.droppedColumns], ['ip.description'])
  assertEquals([...allowance.tables], [['login', 'dblogin']])
  assertEquals([...allowance.columns], [['ip.scope', 'reach']])
})

test('without the breaking-ok marker nothing is allowed', () => {
  const allowance = addBreakingOkAllowance(CONTRACT.replace(/^-- breaking-ok.*\n/, ''))
  assertEquals(allowance.droppedTables.size + allowance.droppedColumns.size, 0)
  assertEquals(allowance.tables.size + allowance.columns.size, 0)
})

test('row diff lets a breaking-ok migration drop or rename what it names, nothing else', () => {
  const before = new Map([
    ['ip(1)', { id: '1', description: 'a', scope: 'public', address: '203.0.113.10' }],
    ['login(2)', { id: '2', role: 'user' }],
    ['subnet(3)', { id: '3' }],
    ['server(4)', { id: '4', name: 'a' }],
  ])
  const after = new Map([
    ['ip(1)', { id: '1', reach: 'public', address: '203.0.113.10' }],
    ['dblogin(2)', { id: '2', role: 'user' }],
    ['server(4)', { id: '4' }],
  ])
  assertEquals(diffRows(before, after, addBreakingOkAllowance(CONTRACT)), [
    'server(4): column name gone after upgrade',
  ])
  assertEquals(
    diffRows(
      new Map([['ip(1)', { id: '1', scope: 'public' }]]),
      new Map([['ip(1)', { id: '1', reach: 'datacenter' }]]),
      addBreakingOkAllowance(CONTRACT)
    ),
    ['ip(1): scope was "public", now "datacenter"']
  )
})

test('schema diff reports objects on either side only', () => {
  const fresh = { indexes: ['a', 'b'], history: ['h1'] }
  assertEquals(diffSchemas({ indexes: ['a', 'b'], history: ['h1'] }, fresh), [])
  assertEquals(diffSchemas({ indexes: ['a', 'c'], history: ['h1'] }, fresh), [
    'indexes only after upgrade: c',
    'indexes only on fresh apply: b',
  ])
})
