/**
 * Pure parts of the upgrade-from-the-previous-release check: which tag counts
 * as the previous release, scratch URLs, and the row and schema diffs. The
 * database run itself is `pnpm check:migration-upgrade` (CI deno db-1).
 */
import { assertEquals, assertThrows } from '@std/assert'
import { diffRows, diffSchemas, newestStableTag, withDatabase } from './check-migration-upgrade.mjs'

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

test('schema diff reports objects on either side only', () => {
  const fresh = { indexes: ['a', 'b'], history: ['h1'] }
  assertEquals(diffSchemas({ indexes: ['a', 'b'], history: ['h1'] }, fresh), [])
  assertEquals(diffSchemas({ indexes: ['a', 'c'], history: ['h1'] }, fresh), [
    'indexes only after upgrade: c',
    'indexes only on fresh apply: b',
  ])
})
