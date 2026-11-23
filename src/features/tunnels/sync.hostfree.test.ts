import { assertEquals } from '@std/assert'
import {
  lastSendIsSettled,
  resendGapAfter,
  resendIsWaiting,
  TUNNEL_ROUTES_RESEND_GAP_MS,
  TUNNEL_ROUTES_STALE_MS,
} from './sync.ts'
import { TUNNEL_GENERATION_BUMP_GAP_MS } from './table-generation.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const NOW = Date.parse('2026-10-28T12:00:00.000Z')
const SLACK_MS = 15_000
const sent = (ageMs: number, forwarded = 2) => ({
  stateHash: 'a'.repeat(64),
  commandId: 'c',
  sentAt: new Date(NOW - ageMs).toISOString(),
  forwarded,
})

test('a table that was applied in full is settled', () => {
  const row = { status: 'succeeded', resultSummary: { routeCount: 2, warnings: [] } }
  assertEquals(lastSendIsSettled(row, sent(1000), NOW), true)
  assertEquals(
    lastSendIsSettled({ status: 'succeeded', resultSummary: null }, sent(1000), NOW),
    true
  )
})

test('a table the daemon trimmed or warned about is sent again', () => {
  const trimmed = { status: 'succeeded', resultSummary: { routeCount: 0, warnings: [] } }
  assertEquals(lastSendIsSettled(trimmed, sent(1000), NOW), false)
  const warned = { status: 'succeeded', resultSummary: { routeCount: 2, warnings: ['x'] } }
  assertEquals(lastSendIsSettled(warned, sent(1000), NOW), false)
})

test('a failed, expired or missing command is sent again; a moving one is waited for until it is stale', () => {
  assertEquals(lastSendIsSettled({ status: 'failed', resultSummary: null }, sent(1000), NOW), false)
  assertEquals(
    lastSendIsSettled({ status: 'expired', resultSummary: null }, sent(1000), NOW),
    false
  )
  assertEquals(lastSendIsSettled(undefined, sent(1000), NOW), false)
  assertEquals(lastSendIsSettled({ status: 'queued', resultSummary: null }, sent(1000), NOW), true)
  assertEquals(
    lastSendIsSettled(
      { status: 'running', resultSummary: null },
      sent(TUNNEL_ROUTES_STALE_MS + 1),
      NOW
    ),
    false
  )
})

test("a table refused as older than the daemon's own is sent again after the bump gap, others after the long gap", () => {
  const refused = {
    status: 'succeeded',
    resultSummary: {
      applied: false,
      warnings: ['ignored: a newer forwarding table is already in place'],
    },
  }
  assertEquals(resendGapAfter(refused), TUNNEL_GENERATION_BUMP_GAP_MS)
  const other = { status: 'succeeded', resultSummary: { applied: true, warnings: ['x'] } }
  assertEquals(resendGapAfter(other), TUNNEL_ROUTES_RESEND_GAP_MS)
  assertEquals(resendGapAfter(undefined), TUNNEL_ROUTES_RESEND_GAP_MS)
  assertEquals(
    resendGapAfter({ status: 'failed', resultSummary: null }),
    TUNNEL_ROUTES_RESEND_GAP_MS
  )
})

test('a table that did not finish is sent again at the ten minute slot, but a moving command is not cut short', () => {
  const failed = { status: 'failed', resultSummary: null }
  const sentAt = NOW - TUNNEL_ROUTES_RESEND_GAP_MS + SLACK_MS
  assertEquals(resendIsWaiting(failed, sentAt, NOW), false)
  assertEquals(resendIsWaiting(failed, NOW - 5 * 60_000, NOW), true)
  // Still moving at the stale mark minus 15 s: waited for, so no second table (or leaf) goes out.
  const running = { status: 'running', resultSummary: null }
  assertEquals(lastSendIsSettled(running, sent(TUNNEL_ROUTES_STALE_MS - SLACK_MS), NOW), true)
})
