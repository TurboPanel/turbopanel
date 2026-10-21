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
  manifestGeneration,
  predatesBaseline,
  seedErrorFromRename,
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

test('a breaking-ok column dropped and re-added is compared, not excused', () => {
  const allowance = addBreakingOkAllowance(CONTRACT)
  const before = new Map([['ip(1)', { id: '1', description: 'a' }]])
  assertEquals(diffRows(before, new Map([['ip(1)', { id: '1', description: 'a' }]]), allowance), [])
  assertEquals(diffRows(before, new Map([['ip(1)', { id: '1', description: null }]]), allowance), [
    'ip(1): description was "a", now null',
  ])
})

test('a breaking-ok table dropped and re-added is compared, not excused', () => {
  const allowance = addBreakingOkAllowance(CONTRACT)
  const before = new Map([['subnet(3)', { id: '3', cidr: '172.30.1.0/24' }]])
  // The table exists again after the upgrade but lost the row.
  assertEquals(diffRows(before, new Map(), allowance, new Set(['subnet'])), [
    'subnet(3): row missing after upgrade',
  ])
  assertEquals(
    diffRows(before, new Map([['subnet(3)', { id: '3', cidr: '10.0.0.0/24' }]]), allowance),
    ['subnet(3): cidr was "172.30.1.0/24", now "10.0.0.0/24"']
  )
  assertEquals(diffRows(before, new Map(), allowance, new Set()), [])
})

test('the swap pattern (add new, backfill, drop old, rename new to old) checks the backfill', () => {
  const swap = addBreakingOkAllowance(`-- breaking-ok: swap ip.scope for a rebuilt column
ALTER TABLE "ip" ADD COLUMN "scope_new" text;--> statement-breakpoint
UPDATE "ip" SET "scope_new" = "scope";--> statement-breakpoint
ALTER TABLE "ip" DROP COLUMN "scope";--> statement-breakpoint
ALTER TABLE "ip" RENAME COLUMN "scope_new" TO "scope";`)
  const before = new Map([['ip(1)', { id: '1', scope: 'public' }]])
  assertEquals(diffRows(before, new Map([['ip(1)', { id: '1', scope: 'public' }]]), swap), [])
  assertEquals(diffRows(before, new Map([['ip(1)', { id: '1', scope: null }]]), swap), [
    'ip(1): scope was "public", now null',
  ])
})

test('a pending rename only excuses seed errors that name the old names', () => {
  const allowance = addBreakingOkAllowance(CONTRACT)
  assertEquals(seedErrorFromRename('relation "login" does not exist', allowance), true)
  assertEquals(
    seedErrorFromRename('column "scope" of relation "ip" does not exist', allowance),
    true
  )
  assertEquals(
    seedErrorFromRename('null value in column "kind" of relation "network"', allowance),
    false
  )
})

test('a pending drop or added column excuses seed errors that name it', () => {
  const allowance = addBreakingOkAllowance(`-- breaking-ok: split a column
ALTER TABLE "login" ADD COLUMN "username" varchar(255);--> statement-breakpoint
ALTER TABLE "principal" DROP COLUMN "managed_id";`)
  assertEquals(
    seedErrorFromRename('column "managed_id" of relation "principal" does not exist', allowance),
    true
  )
  assertEquals(
    seedErrorFromRename('null value in column "username" of relation "login"', allowance),
    true
  )
  assertEquals(
    seedErrorFromRename('null value in column "role" of relation "login"', allowance),
    false
  )
})

test('a release from before the baseline is skipped; one from the baseline is compared', () => {
  assertEquals(predatesBaseline(9, 10), true)
  assertEquals(predatesBaseline(10, 10), false)
  assertEquals(predatesBaseline(11, 10), false)
})

test('manifestGeneration reads the generation and treats a missing manifest as 0', () => {
  const dir = Deno.makeTempDirSync()
  try {
    assertEquals(manifestGeneration(dir), 0)
    Deno.writeTextFileSync(`${dir}/manifest.json`, JSON.stringify({ version: 1, generation: 10 }))
    assertEquals(manifestGeneration(dir), 10)
  } finally {
    Deno.removeSync(dir, { recursive: true })
  }
})

test('schema diff reports objects on either side only', () => {
  const fresh = { indexes: ['a', 'b'], history: ['h1'] }
  assertEquals(diffSchemas({ indexes: ['a', 'b'], history: ['h1'] }, fresh), [])
  assertEquals(diffSchemas({ indexes: ['a', 'c'], history: ['h1'] }, fresh), [
    'indexes only after upgrade: c',
    'indexes only on fresh apply: b',
  ])
})
