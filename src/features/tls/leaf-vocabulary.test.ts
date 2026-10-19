import { assertEquals } from '@std/assert'
import {
  CA_RETIRE_GRACE_DAYS,
  caRetireByIso,
  clipLeafText,
  LEAF_STALE_OFFLINE_DAYS,
  LEAF_TEXT_MAX,
  leafStaleOfflineReason,
  serverOfflineTooLong,
} from './leaf-vocabulary.ts'

const test = Deno.test.bind(Deno)

const DAY = 86_400_000
const NOW = Date.parse('2026-10-19T12:00:00.000Z')

test('clipLeafText folds whitespace and cuts to the column limit with an ellipsis', () => {
  assertEquals(clipLeafText('  The renewal\n did   not finish. '), 'The renewal did not finish.')
  const clipped = clipLeafText('x'.repeat(LEAF_TEXT_MAX + 50))
  assertEquals(clipped.length, LEAF_TEXT_MAX)
  assertEquals(clipped.endsWith('…'), true)
  assertEquals(clipLeafText('x'.repeat(LEAF_TEXT_MAX)).length, LEAF_TEXT_MAX)
})

test('a server counts as gone only after it has been offline for the whole window', () => {
  const at = (days: number) => new Date(NOW - days * DAY).toISOString()
  assertEquals(
    serverOfflineTooLong({ isConnected: true, statusChangedAt: at(90), nowMs: NOW }),
    false
  )
  assertEquals(
    serverOfflineTooLong({ isConnected: false, statusChangedAt: at(1), nowMs: NOW }),
    false
  )
  assertEquals(
    serverOfflineTooLong({
      isConnected: false,
      statusChangedAt: at(LEAF_STALE_OFFLINE_DAYS),
      nowMs: NOW,
    }),
    true
  )
  // Never seen going offline: not enough to call it gone.
  assertEquals(
    serverOfflineTooLong({ isConnected: false, statusChangedAt: null, nowMs: NOW }),
    false
  )
  assertEquals(
    serverOfflineTooLong({ isConnected: false, statusChangedAt: 'not a date', nowMs: NOW }),
    false
  )
})

test('a server that never connected counts as gone once its leaf is old enough', () => {
  const at = (days: number) => new Date(NOW - days * DAY).toISOString()
  const never = { isConnected: false, statusChangedAt: null, nowMs: NOW }
  assertEquals(serverOfflineTooLong({ ...never, leafIssuedAt: at(1) }), false)
  assertEquals(serverOfflineTooLong({ ...never, leafIssuedAt: at(LEAF_STALE_OFFLINE_DAYS) }), true)
  assertEquals(
    serverOfflineTooLong({ isConnected: true, statusChangedAt: null, leafIssuedAt: at(90) }),
    false
  )
})

test('the offline reason names the day the server went offline', () => {
  assertEquals(
    leafStaleOfflineReason('2026-09-01T08:30:00.000Z'),
    'The server has been offline since 2026-09-01.'
  )
  assertEquals(leafStaleOfflineReason(null), 'The server has been offline for a long time.')
})

test('the retire deadline is the grace period after fan-out finishes', () => {
  assertEquals(caRetireByIso(NOW), new Date(NOW + CA_RETIRE_GRACE_DAYS * DAY).toISOString())
})
