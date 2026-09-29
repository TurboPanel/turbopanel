import { assertEquals } from '@std/assert'
import type { Alert, AlertSender } from './alert-sender.ts'
import { notifyDemotions } from './notify-demotions.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const MASS_DISCONNECT = { staleCount: 3, connectedBefore: 4 }

function recordingSender(delayMs = 0): { send: AlertSender; events: string[] } {
  const events: string[] = []
  return {
    events,
    send: async (alert: Alert) => {
      const id = String(alert.detail?.serverId ?? alert.kind)
      events.push(`start:${id}`)
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
      events.push(`end:${id}`)
    },
  }
}

test('notifyDemotions sends the aggregate first, then one alert per server in order', async () => {
  const { send, events } = recordingSender(5)
  await notifyDemotions(['a', 'b'], MASS_DISCONNECT, send)
  assertEquals(events, [
    'start:fleet.mass_disconnect',
    'end:fleet.mass_disconnect',
    'start:a',
    'end:a',
    'start:b',
    'end:b',
  ])
})

test('notifyDemotions does nothing when there is nothing to report', async () => {
  const { send, events } = recordingSender()
  await notifyDemotions([], null, send)
  assertEquals(events, [])
})

test('notifyDemotions skips everything when the budget is already spent', async () => {
  const { send, events } = recordingSender()
  const traces: string[] = []
  await notifyDemotions(['a'], null, send, 0, (name) => traces.push(name))
  assertEquals(events, [])
  assertEquals(traces, ['alerts-skipped'])
})

test('notifyDemotions stops sending once the delivery budget runs out', async () => {
  const { send, events } = recordingSender(30)
  const traces: Array<[string, unknown]> = []
  await notifyDemotions(['a', 'b', 'c', 'd'], null, send, 50, (name, data) =>
    traces.push([name, data])
  )
  // Let the delivery that was in flight at the deadline finish.
  await new Promise((resolve) => setTimeout(resolve, 80))
  // `a` and `b` started inside the budget; `c` would start after it, so neither
  // `c` nor `d` is ever contacted.
  assertEquals(events, ['start:a', 'end:a', 'start:b', 'end:b'])
  assertEquals(traces, [
    ['alerts-deadline-reached', {}],
    ['alerts-truncated', { remaining: 2 }],
  ])
})
