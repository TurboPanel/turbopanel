import { assertEquals } from '@std/assert'
import {
  fencePhaseFromCommandMetadata,
  firstDatacenterId,
  logRecoveryAdvanceFailure,
  recoveryIdFromCommandMetadata,
} from './ha-recovery.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SERVER_A = '550e8400-e29b-41d4-a716-446655440000'
const DC_A = 'dc-east'
const DC_B = 'dc-west'

test('firstDatacenterId returns the lex-smallest pin or null', () => {
  const sets = new Map<string, Set<string>>([
    [SERVER_A, new Set([DC_B, DC_A])],
  ])
  assertEquals(firstDatacenterId(sets, SERVER_A), DC_A)
  assertEquals(firstDatacenterId(sets, 'missing'), null)
  assertEquals(firstDatacenterId(new Map([[SERVER_A, new Set()]]), SERVER_A), null)
})

test('recoveryIdFromCommandMetadata requires a non-empty string', () => {
  assertEquals(recoveryIdFromCommandMetadata(undefined), null)
  assertEquals(recoveryIdFromCommandMetadata(null), null)
  assertEquals(recoveryIdFromCommandMetadata({}), null)
  assertEquals(recoveryIdFromCommandMetadata({ recoveryId: '' }), null)
  assertEquals(recoveryIdFromCommandMetadata({ recoveryId: 12 }), null)
  assertEquals(recoveryIdFromCommandMetadata({ recoveryId: 'rec-1' }), 'rec-1')
})

test('fencePhaseFromCommandMetadata accepts only drain or stop', () => {
  assertEquals(fencePhaseFromCommandMetadata(undefined), null)
  assertEquals(fencePhaseFromCommandMetadata({ fencePhase: 'promote' }), null)
  assertEquals(fencePhaseFromCommandMetadata({ fencePhase: 'drain' }), 'drain')
  assertEquals(fencePhaseFromCommandMetadata({ fencePhase: 'stop' }), 'stop')
})

test('logRecoveryAdvanceFailure is a warn-only helper', () => {
  logRecoveryAdvanceFailure('cmd-1', 'queue unavailable')
})
