import { assertEquals } from '@std/assert'
import {
  blockedDatabaseForgetMessage,
  blockedDatabaseReason,
  canForgetServerResources,
  capPreviewList,
} from './delete-guards.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('blockedDatabaseReason is only_member unless another member exists', () => {
  assertEquals(blockedDatabaseReason(false), 'only_member')
  assertEquals(blockedDatabaseReason(true), 'primary_here')
})

test('blockedDatabaseForgetMessage names the database in plain words', () => {
  assertEquals(
    blockedDatabaseForgetMessage('orders', 'only_member'),
    'Database "orders" has its only copy on this server. Delete the database first.'
  )
  assertEquals(
    blockedDatabaseForgetMessage('orders', 'primary_here'),
    'Database "orders" has its primary copy on this server. Promote another member or delete the database first.'
  )
})

test('canForgetServerResources is false when online, colocated, or a database is blocked', () => {
  assertEquals(
    canForgetServerResources({ online: false, colocated: false, blockedDatabaseCount: 0 }),
    true
  )
  assertEquals(
    canForgetServerResources({ online: true, colocated: false, blockedDatabaseCount: 0 }),
    false
  )
  assertEquals(
    canForgetServerResources({ online: false, colocated: true, blockedDatabaseCount: 0 }),
    false
  )
  assertEquals(
    canForgetServerResources({ online: false, colocated: false, blockedDatabaseCount: 2 }),
    false
  )
})

test('capPreviewList reports leftover items beyond 50', () => {
  const items = Array.from({ length: 52 }, (_, i) => i)
  assertEquals(capPreviewList(items), { items: items.slice(0, 50), more: 2 })
  assertEquals(capPreviewList(['a']), { items: ['a'], more: 0 })
})
