import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import type { Alert } from '../../features/alerts/alert-sender.ts'
import { DAEMON_OFFLINE_SWEEP_MS } from '../../contracts/cell-protocol.ts'
import { noticeDisconnectedServers } from './disconnect-notice.ts'

const test = Deno.test.bind(Deno)

const START_MS = Date.parse('2026-06-01T12:00:00.000Z')
const db = {} as unknown as Db

type Outage = {
  id: string
  connected: boolean
  reason: 'disconnect' | 'sweep_stale' | null
  changedAtMs: number
  claimed: boolean
}

/** The claim statement's predicate, over rows kept in memory. */
function fleet(rows: Outage[]) {
  return {
    claim: (_db: Db, opts: { nowMs: number; graceMs: number; windowMs: number }) => {
      const ids: string[] = []
      for (const row of rows) {
        const due =
          !row.connected &&
          row.reason === 'disconnect' &&
          !row.claimed &&
          row.changedAtMs <= opts.nowMs - opts.graceMs &&
          row.changedAtMs >= opts.nowMs - opts.windowMs
        if (due) {
          row.claimed = true
          ids.push(row.id)
        }
      }
      return Promise.resolve(ids)
    },
    countConnected: () => Promise.resolve(rows.filter((row) => row.connected).length),
    reconnect: (id: string) => {
      const row = rows.find((r) => r.id === id)
      if (row) Object.assign(row, { connected: true, reason: null, claimed: false })
    },
  }
}

function dropped(id: string, agoMs: number, reason: Outage['reason'] = 'disconnect'): Outage {
  return { id, connected: false, reason, changedAtMs: START_MS - agoMs, claimed: false }
}

function pass(f: ReturnType<typeof fleet>, sent: Alert[], nowMs = START_MS) {
  return noticeDisconnectedServers(db, {
    graceMs: DAEMON_OFFLINE_SWEEP_MS,
    nowMs,
    awaitDelivery: true,
    resolveSender: () =>
      Promise.resolve((alert: Alert) => {
        sent.push(alert)
        return Promise.resolve()
      }),
    claim: f.claim,
    countConnected: f.countConnected,
  })
}

test('a disconnect past the grace raises one server.offline, once per outage', async () => {
  const f = fleet([dropped('srv-a', DAEMON_OFFLINE_SWEEP_MS + 1_000)])
  const sent: Alert[] = []

  await pass(f, sent)
  await pass(f, sent, START_MS + 60_000)

  assertEquals(
    sent.map((a) => a.kind),
    ['server.offline']
  )
  assertEquals(sent[0]?.detail, { serverId: 'srv-a' })
})

test('a reconnect inside the grace raises nothing, and a second outage notifies again', async () => {
  const rows = [dropped('srv-a', 30_000)]
  const f = fleet(rows)
  const sent: Alert[] = []

  await pass(f, sent)
  f.reconnect('srv-a')
  await pass(f, sent, START_MS + 3 * DAEMON_OFFLINE_SWEEP_MS)
  assertEquals(sent.length, 0)

  Object.assign(rows[0], { connected: false, reason: 'disconnect', changedAtMs: START_MS })
  await pass(f, sent, START_MS + DAEMON_OFFLINE_SWEEP_MS + 1)
  assertEquals(sent.length, 1)
})

test('a stale-sweep demotion is not announced a second time by the disconnect pass', async () => {
  const f = fleet([dropped('srv-stale', DAEMON_OFFLINE_SWEEP_MS * 2, 'sweep_stale')])
  const sent: Alert[] = []

  const claimed = await pass(f, sent)

  assertEquals(claimed, 0)
  assertEquals(sent.length, 0)
})

test('an outage older than the window is left alone', async () => {
  const f = fleet([dropped('srv-old', 24 * 3_600_000)])
  const sent: Alert[] = []

  await pass(f, sent)

  assertEquals(sent.length, 0)
})

test('many servers dropping together send the aggregate first, then the lines', async () => {
  const rows = [
    dropped('srv-1', 200_000),
    dropped('srv-2', 200_000),
    dropped('srv-3', 200_000),
    { id: 'srv-up', connected: true, reason: null, changedAtMs: START_MS, claimed: false },
  ] satisfies Outage[]
  const f = fleet(rows)
  const sent: Alert[] = []

  await pass(f, sent)

  assertEquals(
    sent.map((a) => a.kind),
    ['fleet.mass_disconnect', 'server.offline', 'server.offline', 'server.offline']
  )
  assertEquals(sent[0]?.detail, { staleCount: 3, connectedBefore: 4 })
})

test('nothing claimed means the sender is never resolved', async () => {
  const f = fleet([])
  let resolved = 0

  await noticeDisconnectedServers(db, {
    graceMs: DAEMON_OFFLINE_SWEEP_MS,
    nowMs: START_MS,
    awaitDelivery: true,
    resolveSender: () => {
      resolved += 1
      return Promise.resolve(() => Promise.resolve())
    },
    claim: f.claim,
  })

  assertEquals(resolved, 0)
})
