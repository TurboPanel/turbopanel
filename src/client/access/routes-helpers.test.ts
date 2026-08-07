import { assertEquals } from 'jsr:@std/assert'
import { isUuid, ownerRemovalConflictMessage } from './routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('isUuid accepts canonical lowercase UUIDs', () => {
  assertEquals(
    isUuid('00000000-0000-4000-8000-000000000001'),
    true,
  )
  assertEquals(isUuid('00000000-0000-4000-8000-00000000000G'), false)
  assertEquals(isUuid('not-a-uuid'), false)
})

test('ownerRemovalConflictMessage maps last-owner errors', () => {
  assertEquals(
    ownerRemovalConflictMessage(
      new Error('Cannot remove the last owner of an organization'),
    ),
    'Cannot remove the last owner of an organization',
  )
  assertEquals(
    ownerRemovalConflictMessage(
      new Error('Cannot remove the last owner of a team'),
    ),
    'Cannot remove the last owner of a team',
  )
  assertEquals(ownerRemovalConflictMessage(new Error('other')), null)
  assertEquals(ownerRemovalConflictMessage('bad'), null)
})
