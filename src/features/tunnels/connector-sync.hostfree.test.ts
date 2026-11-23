import { assertEquals } from '@std/assert'
import {
  isAlreadyCurrent,
  TUNNEL_CONNECTORS_RESEND_GAP_MS,
  TUNNEL_CONNECTORS_STALE_MS,
} from './connector-sync.ts'

const test = Deno.test.bind(Deno)

const NOW = Date.parse('2026-10-28T12:00:00.000Z')
const SLACK_MS = 15_000
const sent = (ageMs: number) => ({
  stateHash: 'h',
  commandId: 'c',
  sentAt: new Date(NOW - ageMs).toISOString(),
  installed: ['a'],
  removing: [] as string[],
})

test('a list that did not finish is sent again at the ten minute slot, not before the gap is nearly up', () => {
  const failed = { status: 'failed' }
  assertEquals(
    isAlreadyCurrent(sent(TUNNEL_CONNECTORS_RESEND_GAP_MS - SLACK_MS), failed, 'h', [], false, NOW),
    false
  )
  assertEquals(isAlreadyCurrent(sent(5 * 60_000), failed, 'h', [], false, NOW), true)
})

test('a list still moving is waited for until its stale mark, not cut short by the slot slack', () => {
  const running = { status: 'running' }
  assertEquals(
    isAlreadyCurrent(sent(TUNNEL_CONNECTORS_STALE_MS - SLACK_MS), running, 'h', [], false, NOW),
    true
  )
  assertEquals(
    isAlreadyCurrent(sent(TUNNEL_CONNECTORS_STALE_MS + 1), running, 'h', [], false, NOW),
    false
  )
})
