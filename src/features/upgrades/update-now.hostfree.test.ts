import { assertEquals } from '@std/assert'
import {
  UPGRADE_DEVELOPMENT,
  UPGRADE_PAUSED,
  UPGRADE_RETRY_LATER,
  UPGRADE_RUN_ACTIVE,
} from './coordinator.ts'
import { UPDATE_NOW_PAUSED_MESSAGE, updateNowAnswer } from './update-now.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('a started run answers 202 with its id', () => {
  assertEquals(updateNowAnswer({ ok: true, runId: 'run-1' }), {
    status: 202,
    body: { ok: true, runId: 'run-1' },
  })
})

test('nothing to update answers 200 up to date', () => {
  assertEquals(updateNowAnswer({ ok: true, upToDate: true }), {
    status: 200,
    body: { ok: true, upToDate: true },
  })
})

test('an open run answers 409 run_active with its id', () => {
  const answer = updateNowAnswer({ ok: false, error: UPGRADE_RUN_ACTIVE, activeRunId: 'run-9' })
  assertEquals(answer.status, 409)
  assertEquals(answer.body.ok, false)
  if (!answer.body.ok) {
    assertEquals(answer.body.error, 'run_active')
    assertEquals(answer.body.activeRunId, 'run-9')
  }
  const bare = updateNowAnswer({ ok: false, error: UPGRADE_RUN_ACTIVE })
  assertEquals('activeRunId' in bare.body, false)
})

test('a pause answers 409 paused', () => {
  assertEquals(updateNowAnswer({ ok: false, error: UPGRADE_PAUSED }), {
    status: 409,
    body: { ok: false, error: 'paused', message: UPDATE_NOW_PAUSED_MESSAGE },
  })
})

test('a development install answers 403 development', () => {
  const answer = updateNowAnswer({ ok: false, error: UPGRADE_DEVELOPMENT })
  assertEquals(answer.status, 403)
  if (!answer.body.ok) assertEquals(answer.body.error, 'development')
})

test('a preflight blocker or a backoff answers 409 update_blocked with the reasons', () => {
  const blocked = updateNowAnswer({
    ok: false,
    error: 'The channel target could not be resolved.',
    blockers: ['The channel target could not be resolved.', 'second'],
  })
  assertEquals(blocked, {
    status: 409,
    body: {
      ok: false,
      error: 'update_blocked',
      message: 'The channel target could not be resolved.',
      blockers: ['The channel target could not be resolved.', 'second'],
    },
  })
  const bare = updateNowAnswer({ ok: false, error: UPGRADE_RETRY_LATER })
  if (!bare.body.ok) {
    assertEquals(bare.body.message, UPGRADE_RETRY_LATER)
    assertEquals(bare.body.blockers, [UPGRADE_RETRY_LATER])
  }
})
