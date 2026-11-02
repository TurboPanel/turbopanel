import { assertEquals } from '@std/assert'
import type { NotificationContext } from '../../../../features/notifications/events.ts'
import { alertOnExpiry, alertOnFailure, crossedThreshold } from './alerts.ts'
import { fallbackRenewAt, pickInWindow } from './renewal.ts'
import { IDLE_STATE, readDns01State, withStage } from './state.ts'
import { needsWork } from './tick.ts'

const test = Deno.test.bind(Deno)

const NOW = new Date('2026-11-01T00:00:00.000Z')
const DAY = 24 * 60 * 60_000

function recorder(): {
  sent: NotificationContext[]
  notify: (ctx: NotificationContext) => Promise<void>
} {
  const sent: NotificationContext[] = []
  return { sent, notify: (ctx) => Promise.resolve(void sent.push(ctx)) }
}

test('the first failure alerts once; the same cause again stays quiet', async () => {
  const { sent, notify } = recorder()
  const failure = { cause: 'scope-missing' as const, detail: 'no scope' }
  const once = await alertOnFailure(IDLE_STATE, 'panel.example.com', failure, null, notify)
  await alertOnFailure(once, 'panel.example.com', failure, null, notify)
  assertEquals(sent.length, 1)
  assertEquals(sent[0]?.kind, 'failed')
})

test('the countdown alerts at 7, then 3, then 1 day, each once', async () => {
  const { sent, notify } = recorder()
  const notAfter = new Date(NOW.getTime() + 20 * DAY)
  let state = withStage(IDLE_STATE, 'backoff')
  for (const daysLeft of [13, 6.5, 6, 2.5, 0.5]) {
    const now = new Date(notAfter.getTime() - daysLeft * DAY)
    state = await alertOnExpiry(state, 'panel.example.com', notAfter, now, notify)
  }
  assertEquals(
    sent.map((ctx) => ctx.daysLeft),
    [14, 7, 3, 1]
  )
})

test('a renewing name with a healthy order sends no countdown', async () => {
  const { sent, notify } = recorder()
  const notAfter = new Date(NOW.getTime() + 2 * DAY)
  await alertOnExpiry(withStage(IDLE_STATE, 'issued'), 'x', notAfter, NOW, notify)
  assertEquals(sent.length, 0)
  assertEquals(crossedThreshold(new Date(NOW.getTime() - DAY), NOW), null)
})

test('readDns01State starts unknown or empty state from idle', () => {
  assertEquals(readDns01State(null), IDLE_STATE)
  assertEquals(readDns01State({ v: 1, stage: 'bogus' }).stage, 'idle')
  assertEquals(readDns01State({ v: 2, stage: 'issued' }).stage, 'idle')
})

test('renewal falls back to a third of the lifetime, at least a week before expiry', () => {
  const issued = NOW
  assertEquals(
    fallbackRenewAt(issued, new Date(NOW.getTime() + 90 * DAY)).toISOString(),
    new Date(NOW.getTime() + 60 * DAY).toISOString()
  )
  assertEquals(
    fallbackRenewAt(issued, new Date(NOW.getTime() + 9 * DAY)).toISOString(),
    new Date(NOW.getTime() + 2 * DAY).toISOString()
  )
  const picked = pickInWindow(NOW, new Date(NOW.getTime() + DAY), () => 0.5)
  assertEquals(picked.toISOString(), new Date(NOW.getTime() + DAY / 2).toISOString())
})

test('the tick works idle, open, due back-off and due renewal rows only', () => {
  const past = new Date(NOW.getTime() - 1000).toISOString()
  const future = new Date(NOW.getTime() + 1000).toISOString()
  assertEquals(needsWork({ state: IDLE_STATE }, NOW), true)
  assertEquals(needsWork({ state: withStage(IDLE_STATE, 'waiting-dns') }, NOW), true)
  assertEquals(
    needsWork({ state: withStage(IDLE_STATE, 'backoff', { nextAttemptAt: future }) }, NOW),
    false
  )
  assertEquals(
    needsWork({ state: withStage(IDLE_STATE, 'backoff', { nextAttemptAt: past }) }, NOW),
    true
  )
  assertEquals(needsWork({ state: withStage(IDLE_STATE, 'issued', { renewAt: past }) }, NOW), true)
  assertEquals(needsWork({ state: withStage(IDLE_STATE, 'failed') }, NOW), false)
})
