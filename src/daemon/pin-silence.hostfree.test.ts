import { assertEquals } from '@std/assert'
import type { Db } from '../db/connection.ts'
import {
  decidePinSilence,
  peerEvidence,
  PIN_MISSING_MIN_MS,
  PIN_SILENT_MIN_MS,
  type PinSilenceDeps,
  sweepPinSilence,
} from './pin-silence.ts'

const test = Deno.test.bind(Deno)

const NOW = Date.parse('2026-11-05T12:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const KEY_S = 'key-silent'
const KEY_P = 'key-peer'

/** A peer relay in fabric `f1` whose fresh reading shows a handshake with `key` `ageMs` ago. */
function peerRelay(serverId: string, key: string, ageMs: number | null, readingAgeMs = 60_000) {
  return {
    serverId,
    fabricId: 'f1',
    publicKey: KEY_P,
    metadata: {
      observed: {
        at: iso(NOW - readingAgeMs),
        peers:
          ageMs === null
            ? []
            : [{ publicKey: key, lastHandshakeAt: iso(NOW - readingAgeMs - ageMs) }],
      },
    },
  }
}
const ownRelay = { serverId: 's1', fabricId: 'f1', publicKey: KEY_S, metadata: null }

test('the stages climb only on continued healthy readings, B before C, once each', () => {
  const at = (aliveForMs: number | null, raisedStage: 0 | 1 | 2 = 0) =>
    decidePinSilence({ aliveForMs, massOutage: false, raisedStage })
  assertEquals(at(PIN_SILENT_MIN_MS - 1), { stage: 0, raise: null })
  assertEquals(at(PIN_SILENT_MIN_MS), { stage: 1, raise: 'server.pin_silent' })
  assertEquals(at(PIN_SILENT_MIN_MS, 1), { stage: 1, raise: null })
  assertEquals(at(PIN_MISSING_MIN_MS, 1), { stage: 2, raise: 'server.pin_missing' })
  assertEquals(at(PIN_MISSING_MIN_MS, 2), { stage: 2, raise: null })
  // Never straight to missing: the warning comes first.
  assertEquals(at(PIN_MISSING_MIN_MS), { stage: 1, raise: 'server.pin_silent' })
  // No healthy reading now, or an outage: nothing.
  assertEquals(at(null), { stage: 0, raise: null })
  assertEquals(
    decidePinSilence({ aliveForMs: PIN_MISSING_MIN_MS, massOutage: true, raisedStage: 1 }),
    { stage: 1, raise: null }
  )
})

test('a peer reading decides: healthy, down, or unknown when nothing current is known', () => {
  assertEquals(peerEvidence('s1', [ownRelay, peerRelay('s2', KEY_S, 10_000)], NOW), 'healthy')
  assertEquals(peerEvidence('s1', [ownRelay, peerRelay('s2', KEY_S, 600_000)], NOW), 'down')
  assertEquals(peerEvidence('s1', [ownRelay, peerRelay('s2', KEY_S, null)], NOW), 'down')
  // A stale reading says nothing.
  assertEquals(
    peerEvidence('s1', [ownRelay, peerRelay('s2', KEY_S, 10_000, 3_600_000)], NOW),
    'unknown'
  )
  // Its own reading never counts, and no relay means no evidence.
  assertEquals(peerEvidence('s1', [{ ...peerRelay('s1', KEY_S, 10_000) }], NOW), 'unknown')
  assertEquals(peerEvidence('s1', [], NOW), 'unknown')
})

type ServerRow = {
  id: string
  name: string | null
  organizationId: string | null
  isConnected: boolean
  statusChangedAt: string | null
  trustPinnedBy: string | null
  trustLevel: number
  stage: number | null
  since: string | null
  aliveAt: string | null
}

/**
 * The calls the sweep makes, in order: select servers, (update reconnected),
 * select relay fabrics, select relays, then one update per changed server.
 */
function fakeDb(servers: ServerRow[], relays: unknown[], opts: { failUpdates?: boolean } = {}) {
  const updates: Record<string, unknown>[] = []
  const fabrics = relays.map((r) => ({ fabricId: (r as { fabricId: string }).fabricId }))
  const selects: unknown[] = [servers, fabrics, relays]
  let selectIndex = 0
  const answer = () => Promise.resolve(selects[selectIndex++] ?? [])
  const db = {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          if (opts.failUpdates) return Promise.reject(new Error('down'))
          updates.push(values)
          return Promise.resolve()
        },
      }),
    }),
    select: () => ({
      from: () => {
        // The server read has no filter; the relay reads do.
        const pending = answer()
        return Object.assign(pending, { where: () => pending })
      },
    }),
  } as unknown as Db
  return { db, updates }
}

function recorder() {
  const audits: { action: string }[] = []
  const emits: { event: string; organizationId: string; context: Record<string, unknown> }[] = []
  return {
    audits,
    emits,
    deps: {
      now: () => NOW,
      audit: (_db: unknown, entry: { action: string }) => {
        audits.push(entry)
        return Promise.resolve()
      },
      emit: (_db: unknown, _s: unknown, input: (typeof emits)[number]) => {
        emits.push(input)
        return Promise.resolve({ inbox: 0, deliveries: 0, sent: 0, failed: 0, held: 0 })
      },
    } as unknown as PinSilenceDeps,
  }
}

const EIGHT_HOURS = 8 * 3_600_000
const offlineSince = iso(NOW - EIGHT_HOURS)

const silent = (over: Partial<ServerRow> = {}): ServerRow => ({
  id: 's1',
  name: 'kappa',
  organizationId: 'o1',
  isConnected: false,
  statusChangedAt: offlineSince,
  trustPinnedBy: 'install',
  trustLevel: 2,
  stage: null,
  since: null,
  aliveAt: null,
  ...over,
})
const online = (id: string): ServerRow => ({
  ...silent({ id, name: id }),
  isConnected: true,
  statusChangedAt: iso(NOW - 86_400_000),
})
const fleet = (row: ServerRow) => [row, online('s2'), online('s3'), online('s4'), online('s7')]
const healthyPeer = [ownRelay, peerRelay('s2', KEY_S, 10_000)]

test('offline for hours and only now reachable through a peer: the clock starts, nothing raised', async () => {
  const { db, updates } = fakeDb(fleet(silent()), healthyPeer)
  const r = recorder()
  assertEquals(await sweepPinSilence(db, undefined, r.deps), 0)
  assertEquals(updates, [
    { trustSilenceStage: null, trustSilenceSince: offlineSince, trustSilenceAliveAt: iso(NOW) },
  ])
  assertEquals([r.audits.length, r.emits.length], [0, 0])
})

test('half an hour of continued healthy readings raises pin_silent once, with audit and notice', async () => {
  const aliveAt = iso(NOW - PIN_SILENT_MIN_MS)
  const r = recorder()
  const first = fakeDb(fleet(silent({ since: offlineSince, aliveAt })), healthyPeer)
  assertEquals(await sweepPinSilence(first.db, undefined, r.deps), 1)
  assertEquals(first.updates, [
    { trustSilenceStage: 1, trustSilenceSince: offlineSince, trustSilenceAliveAt: aliveAt },
  ])
  assertEquals(
    r.audits.map((a) => a.action),
    ['server.panel_pin.silent']
  )
  assertEquals(r.emits[0]?.event, 'server.pin_silent')
  assertEquals(r.emits[0]?.context.offlineMinutes, '480')
  // Same episode, same stage: nothing again, nothing written.
  const again = fakeDb(fleet(silent({ stage: 1, since: offlineSince, aliveAt })), healthyPeer)
  assertEquals(await sweepPinSilence(again.db, undefined, r.deps), 0)
  assertEquals(again.updates.length, 0)
})

test('six hours of healthy readings after the warning raises pin_missing', async () => {
  const aliveAt = iso(NOW - PIN_MISSING_MIN_MS)
  const r = recorder()
  const { db } = fakeDb(fleet(silent({ stage: 1, since: offlineSince, aliveAt })), healthyPeer)
  assertEquals(await sweepPinSilence(db, undefined, r.deps), 1)
  assertEquals(r.emits[0]?.event, 'server.pin_missing')
})

test('a reading that breaks stops the clock; a new episode starts over', async () => {
  const r = recorder()
  const broken = fakeDb(
    fleet(silent({ stage: 1, since: offlineSince, aliveAt: iso(NOW - PIN_MISSING_MIN_MS) })),
    [ownRelay, peerRelay('s2', KEY_S, 600_000)]
  )
  assertEquals(await sweepPinSilence(broken.db, undefined, r.deps), 0)
  assertEquals(broken.updates, [
    { trustSilenceStage: 1, trustSilenceSince: offlineSince, trustSilenceAliveAt: null },
  ])
  // A stored stage from an older episode does not carry over.
  const fresh = fakeDb(
    fleet(
      silent({ stage: 2, since: iso(NOW - 999_999_999), aliveAt: iso(NOW - PIN_SILENT_MIN_MS) })
    ),
    healthyPeer
  )
  assertEquals(await sweepPinSilence(fresh.db, undefined, r.deps), 0)
  assertEquals(fresh.updates[0]?.trustSilenceAliveAt, iso(NOW))
})

test('servers that went offline together are an outage, however long ago', async () => {
  const quiet = (id: string, offsetMs: number) =>
    silent({ id, statusChangedAt: iso(NOW - EIGHT_HOURS + offsetMs), since: null })
  const aliveAt = iso(NOW - PIN_SILENT_MIN_MS)
  const rows = [
    { ...quiet('s1', 0), since: iso(NOW - EIGHT_HOURS), aliveAt },
    quiet('s5', 60_000),
    quiet('s6', 120_000),
    online('s2'),
  ]
  const { db } = fakeDb(rows, healthyPeer)
  const r = recorder()
  assertEquals(await sweepPinSilence(db, undefined, r.deps), 0)
  assertEquals(r.emits.length, 0)
})

test('reconnected servers are cleared; unpinned or never-signed ones are not candidates', async () => {
  const r = recorder()
  const back = fakeDb([{ ...online('s1'), stage: 1, aliveAt: offlineSince }], [])
  assertEquals(await sweepPinSilence(back.db, undefined, r.deps), 0)
  assertEquals(back.updates, [
    { trustSilenceStage: null, trustSilenceSince: null, trustSilenceAliveAt: null },
  ])
  const notCandidates = fakeDb(
    [silent({ trustPinnedBy: 'unsafe' }), silent({ id: 's9', trustLevel: 1 }), online('s2')],
    healthyPeer
  )
  assertEquals(await sweepPinSilence(notCandidates.db, undefined, r.deps), 0)
  assertEquals(notCandidates.updates.length, 0)
})

test('no peer, no organization, and a failure on one server', async () => {
  const r = recorder()
  const none = fakeDb(fleet(silent()), [])
  assertEquals(await sweepPinSilence(none.db, undefined, r.deps), 0)
  const aliveAt = iso(NOW - PIN_SILENT_MIN_MS)
  const orphan = fakeDb(
    fleet(silent({ organizationId: null, since: offlineSince, aliveAt })),
    healthyPeer
  )
  assertEquals(await sweepPinSilence(orphan.db, undefined, r.deps), 1)
  assertEquals([r.audits.length, r.emits.length], [1, 0])
  // A failing write is logged for that server, never thrown.
  const broken = fakeDb(fleet(silent({ since: offlineSince, aliveAt })), healthyPeer, {
    failUpdates: true,
  })
  assertEquals(await sweepPinSilence(broken.db, undefined, r.deps), 0)
})
