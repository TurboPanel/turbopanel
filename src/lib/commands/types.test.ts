import { assertEquals } from '@std/assert'
import {
  COMMAND_STATUSES,
  COMMAND_TYPES,
  TERMINAL_COMMAND_STATUSES,
  isCommandStatus,
  isCommandType,
} from './types.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('isCommandType accepts canonical command types', () => {
  for (const type of COMMAND_TYPES) {
    assertEquals(isCommandType(type), true)
  }
  assertEquals(isCommandType('daemon.ping'), true)
  assertEquals(isCommandType('not-a-command'), false)
  assertEquals(isCommandType(null), false)
})

test('isCommandStatus accepts canonical statuses', () => {
  for (const status of COMMAND_STATUSES) {
    assertEquals(isCommandStatus(status), true)
  }
  assertEquals(isCommandStatus('queued'), true)
  assertEquals(isCommandStatus('bogus'), false)
  assertEquals(isCommandStatus(undefined), false)
})

test('TERMINAL_COMMAND_STATUSES marks only terminal rows', () => {
  assertEquals(TERMINAL_COMMAND_STATUSES.has('succeeded'), true)
  assertEquals(TERMINAL_COMMAND_STATUSES.has('failed'), true)
  assertEquals(TERMINAL_COMMAND_STATUSES.has('timed_out'), true)
  assertEquals(TERMINAL_COMMAND_STATUSES.has('cancelled'), true)
  assertEquals(TERMINAL_COMMAND_STATUSES.has('queued'), false)
  assertEquals(TERMINAL_COMMAND_STATUSES.has('running'), false)
})
