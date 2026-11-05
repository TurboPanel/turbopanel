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

test('the stages climb only with a live peer tunnel and no outage, once each', () => {
  const at = (silentForMs: number, raisedStage: 0 | 1 | 2 = 0) =>
    decidePinSilence({ silentForMs, evidence: 'healthy', massOutage: false, raisedStage })
  assertEquals(at(PIN_SILENT_MIN_MS - 1), { stage: 0, raise: null })
  assertEquals(at(PIN_SILENT_MIN_MS), { stage: 1, raise: 'server.pin_silent' })
  assertEquals(at(PIN_SILENT_MIN_MS, 1), { stage: 1, raise: null })
  assertEquals(at(PIN_MISSING_MIN_MS, 1), { stage: 2, raise: 'server.pin_missing' })
  assertEquals(at(PIN_MISSING_MIN_MS, 2), { stage: 2, raise: null })
  // Straight to missing when the first look is already late.
  assertEquals(at(PIN_MISSING_MIN_MS), { stage: 2, raise: 'server.pin_missing' })
})

test('no sign of life, or an outage, never raises past the ordinary offline notice', () => {
  for (const evidence of ['down', 'unknown'] as const) {
    assertEquals(
      decidePinSilence({
        silentForMs: PIN_MISSING_MIN_MS,
        evidence,
        massOutage: false,
        raisedStage: 0,
      }),
      { stage: 0, raise: null }
    )
  }
  assertEquals(
    decidePinSilence({
      silentForMs: PIN_MISSING_MIN_MS,
      evidence: 'healthy',
      massOutage: true,
      raisedStage: 1,
    }),
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
  stage: number | null
  since: string | null
}

/**
 * The calls the sweep makes, in order: update (reset), select servers, select
 * relay fabrics, select relays, then one update per raise.
 */
function fakeDb(servers: ServerRow[], relays: unknown[], opts: { fail?: boolean } = {}) {
  const updates: Record<string, unknown>[] = []
  const selects = [
    servers,
    relays.map((r) => ({ fabricId: (r as { fabricId: string }).fabricId })),
    relays,
  ]
  let selectIndex = 0
  const db = {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          if (opts.fail) return Promise.reject(new Error('down'))
          updates.push(values)
          return Promise.resolve()
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(selects[selectIndex++] ?? []),
      }),
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

const silent = (over: Partial<ServerRow> = {}): ServerRow => ({
  id: 's1',
  name: 'kappa',
  organizationId: 'o1',
  isConnected: false,
  statusChangedAt: iso(NOW - PIN_SILENT_MIN_MS - 60_000),
  stage: null,
  since: null,
  ...over,
})
const online = (id: string): ServerRow => ({
  id,
  name: id,
  organizationId: 'o1',
  isConnected: true,
  statusChangedAt: iso(NOW - 86_400_000),
  stage: null,
  since: null,
})

test('a silent server a peer still reaches raises pin_silent once, with audit and notice', async () => {
  const fleet = [silent(), online('s2'), online('s3'), online('s4')]
  const { db, updates } = fakeDb(fleet, [ownRelay, peerRelay('s2', KEY_S, 10_000)])
  const r = recorder()
  assertEquals(await sweepPinSilence(db, undefined, r.deps), 1)
  assertEquals(updates[0], { trustSilenceStage: null, trustSilenceSince: null })
  assertEquals(updates[1], { trustSilenceStage: 1, trustSilenceSince: fleet[0]!.statusChangedAt })
  assertEquals(
    r.audits.map((a) => a.action),
    ['server.panel_pin.silent']
  )
  assertEquals(r.emits[0]?.event, 'server.pin_silent')
  assertEquals(r.emits[0]?.context.silentMinutes, '31')

  // Same episode, same stage: nothing again.
  const again = fakeDb(
    [
      silent({ stage: 1, since: fleet[0]!.statusChangedAt }),
      online('s2'),
      online('s3'),
      online('s4'),
    ],
    [ownRelay, peerRelay('s2', KEY_S, 10_000)]
  )
  assertEquals(await sweepPinSilence(again.db, undefined, r.deps), 0)
  assertEquals(again.updates.length, 1)
})

test('a later stage of the same episode raises pin_missing; a new episode starts over', async () => {
  const started = iso(NOW - PIN_MISSING_MIN_MS - 60_000)
  const r = recorder()
  const late = fakeDb(
    [
      silent({ statusChangedAt: started, stage: 1, since: started }),
      online('s2'),
      online('s3'),
      online('s4'),
    ],
    [ownRelay, peerRelay('s2', KEY_S, 10_000)]
  )
  assertEquals(await sweepPinSilence(late.db, undefined, r.deps), 1)
  assertEquals(r.emits[0]?.event, 'server.pin_missing')
  // A stored stage from an older episode does not hold back the new one.
  const fresh = fakeDb(
    [silent({ stage: 2, since: iso(NOW - 999_999_999) }), online('s2'), online('s3'), online('s4')],
    [ownRelay, peerRelay('s2', KEY_S, 10_000)]
  )
  assertEquals(await sweepPinSilence(fresh.db, undefined, r.deps), 1)
  assertEquals(r.emits[1]?.event, 'server.pin_silent')
})

test('many pinned servers going quiet together raise nothing', async () => {
  const quiet = (id: string) =>
    silent({ id, statusChangedAt: iso(NOW - PIN_SILENT_MIN_MS - 60_000) })
  const { db } = fakeDb(
    [quiet('s1'), quiet('s5'), quiet('s6'), online('s2')],
    [ownRelay, peerRelay('s2', KEY_S, 10_000)]
  )
  const r = recorder()
  assertEquals(await sweepPinSilence(db, undefined, r.deps), 0)
  assertEquals(r.emits.length, 0)
})

test('no peer reading, no relay, no organization and a failing database', async () => {
  const r = recorder()
  const fleet = () => [silent(), online('s2'), online('s3'), online('s4')]
  // Peer says the tunnel is down: just offline.
  const down = fakeDb(fleet(), [ownRelay, peerRelay('s2', KEY_S, 600_000)])
  assertEquals(await sweepPinSilence(down.db, undefined, r.deps), 0)
  // Not in TurboFabric at all.
  const none = fakeDb(fleet(), [])
  assertEquals(await sweepPinSilence(none.db, undefined, r.deps), 0)
  // Nobody silent.
  const quiet = fakeDb([online('s2')], [])
  assertEquals(await sweepPinSilence(quiet.db, undefined, r.deps), 0)
  // No organization: audited, not notified.
  const orphan = fakeDb(
    [silent({ organizationId: null }), online('s2'), online('s3'), online('s4')],
    [ownRelay, peerRelay('s2', KEY_S, 10_000)]
  )
  assertEquals(await sweepPinSilence(orphan.db, undefined, r.deps), 1)
  assertEquals(r.emits.length, 0)
  assertEquals(r.audits.length, 1)
  // A database error is logged, never thrown.
  const broken = fakeDb(fleet(), [], { fail: true })
  assertEquals(await sweepPinSilence(broken.db, undefined, r.deps), 0)
})
