import { assertEquals } from '@std/assert'
import { blockingReason } from './records.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('a removing folder says where it waits, and what the host said when it kept it', () => {
  assertEquals(blockingReason('removing', 'Alpha', true), 'being removed from server Alpha')
  assertEquals(
    blockingReason('removing', 'Alpha', false),
    'being removed, waiting for server Alpha to come back'
  )
  assertEquals(
    blockingReason('removing', 'Alpha', true, 'a container still has the folder open'),
    'being removed from server Alpha; the server could not remove it yet: a container still has the folder open'
  )
  assertEquals(blockingReason('removing', null, null), 'being removed from its server')
})

test('an orphan says nothing owns it, and other states say nothing', () => {
  assertEquals(
    blockingReason('orphan', 'Alpha', true),
    'no service or volume owns this folder on server Alpha'
  )
  for (const state of ['planned', 'present', 'missing']) {
    assertEquals(blockingReason(state, 'Alpha', true, 'ignored'), null)
  }
})
