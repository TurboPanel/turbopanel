import { assertEquals } from '@std/assert'
import {
  SKIPPED_PAUSED_MESSAGE,
  UPGRADE_DEVELOPMENT,
  UPGRADE_PAUSED,
  UPGRADE_PAUSED_MESSAGE,
  UPGRADE_RELEASE_UNREACHABLE,
  UPGRADE_RETRY_LATER,
  UPGRADE_RUN_ACTIVE,
  UPGRADE_TOO_SOON,
} from './coordinator.ts'
import type { UpdateChannel } from '../../contracts/update-channel.ts'
import type { UpgradeTarget } from './target.ts'
import {
  checkNowRefresh,
  releaseUnreachableAnswer,
  UPDATE_NOW_PAUSED_MESSAGE,
  UPDATE_NOW_UNREACHABLE_MESSAGE,
  updateNowAnswer,
} from './update-now.ts'

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

test('a press too soon answers 429 check_too_soon with the wait, like Check Now', () => {
  assertEquals(updateNowAnswer({ ok: false, error: UPGRADE_TOO_SOON }, 42), {
    status: 429,
    body: {
      ok: false,
      error: 'check_too_soon',
      message: 'Pressed a moment ago. Try again in 42 seconds.',
      retryAfterSeconds: 42,
    },
  })
  const one = updateNowAnswer({ ok: false, error: UPGRADE_TOO_SOON }, 0.2)
  if (!one.body.ok) {
    assertEquals(one.body.retryAfterSeconds, 1)
    assertEquals(one.body.message, 'Pressed a moment ago. Try again in 1 second.')
  }
  const fallback = updateNowAnswer({ ok: false, error: UPGRADE_TOO_SOON })
  if (!fallback.body.ok) assertEquals(fallback.body.retryAfterSeconds, 60)
})

test('an unreachable release server answers 503 release_unreachable, never up to date', () => {
  assertEquals(updateNowAnswer({ ok: false, error: UPGRADE_RELEASE_UNREACHABLE }), {
    status: 503,
    body: { ok: false, error: 'release_unreachable', message: UPDATE_NOW_UNREACHABLE_MESSAGE },
  })
})

test('the paused messages name the Pause All Updates switch and never say resume', () => {
  assertEquals(
    UPGRADE_PAUSED_MESSAGE,
    'Updates are paused. Turn off Pause All Updates in Admin > Updates.'
  )
  assertEquals(
    SKIPPED_PAUSED_MESSAGE,
    'Updates were paused before this server started. It updates after Pause All Updates is turned off.'
  )
  assertEquals(
    UPDATE_NOW_PAUSED_MESSAGE,
    'Updates are paused. Turn off Pause All Updates to update now.'
  )
  for (const message of [
    UPGRADE_PAUSED_MESSAGE,
    SKIPPED_PAUSED_MESSAGE,
    UPDATE_NOW_PAUSED_MESSAGE,
  ]) {
    assertEquals(/resume/i.test(message), false)
  }
})

const NONE: UpgradeTarget = { daemon: null, instance: null, ui: null }

const DAEMON_ONLY: UpgradeTarget = {
  daemon: {
    version: '1.2.3',
    commit: 'new-daemon',
    buildId: 'b1',
    builtAt: '2026-11-01T00:00:00.000Z',
    manifestUrl: 'https://example.com/daemon/manifest.json',
  },
  instance: null,
  ui: null,
}

/** Check Now with recording fakes: which steps ran, and the answer. */
async function pressCheckNow(channel: UpdateChannel, target: UpgradeTarget) {
  const saved: UpgradeTarget[] = []
  let statusReads = 0
  const answer = await checkNowRefresh({
    channel,
    resolveTarget: () => Promise.resolve(target),
    saveLatest: (next) => {
      saved.push(next)
      return Promise.resolve()
    },
    readStatus: () => {
      statusReads += 1
      return Promise.resolve({ ok: true as const, latest: 'status' })
    },
  })
  return { answer, saved, statusReads }
}

test('Check Now with the release server down answers 503 like Update Now and keeps the saved build', async () => {
  const { answer, saved, statusReads } = await pressCheckNow('release', NONE)
  assertEquals(answer, releaseUnreachableAnswer())
  assertEquals<unknown>(answer, updateNowAnswer({ ok: false, error: UPGRADE_RELEASE_UNREACHABLE }))
  assertEquals(saved, [])
  // No second read: the status read would ask the release server again.
  assertEquals(statusReads, 0)
})

test('Check Now saves a partial answer and reads the status once', async () => {
  const { answer, saved, statusReads } = await pressCheckNow('release', DAEMON_ONLY)
  assertEquals(answer, { status: 200, body: { ok: true, latest: 'status' } })
  assertEquals(saved, [DAEMON_ONLY])
  assertEquals(statusReads, 1)
})

test('Check Now on a channel that publishes no manifests is a normal refresh', async () => {
  const { answer, saved, statusReads } = await pressCheckNow('trunk', NONE)
  assertEquals(answer.status, 200)
  assertEquals(saved, [NONE])
  assertEquals(statusReads, 1)
})
