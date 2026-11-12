import { assertEquals } from '@std/assert'
import { lastSendIsSettled, TUNNEL_ROUTES_STALE_MS } from './sync.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const NOW = Date.parse('2026-10-28T12:00:00.000Z')
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
