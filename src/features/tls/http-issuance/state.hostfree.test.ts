import { assertEquals } from '@std/assert'
import {
  afterCapture,
  canAcceptCapture,
  type HttpIssuanceState,
  readHttpIssuanceState,
  withHttpIssuanceState,
} from './state.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const NOW = new Date('2026-11-01T12:00:00.000Z')

function state(overrides: Partial<HttpIssuanceState> = {}): HttpIssuanceState {
  return {
    issuingServerId: 'server-a',
    requestId: 'req_1',
    startedAt: '2026-11-01T11:55:00.000Z',
    startByAt: '2026-11-01T12:30:00.000Z',
    endedAt: null,
    forwards: [
      { serverId: 'server-b', outcome: 'ready', reason: null, at: '2026-11-01T11:56:00.000Z' },
    ],
    attemptTimes: ['2026-11-01T11:55:00.000Z'],
    nextAttemptAt: null,
    directory: 'production',
    phase: 'forwarding',
    orderSentAt: null,
    lastEventAt: null,
    capturedAt: null,
    coveredNames: [],
    issuedEventAt: null,
    notAfterIso: null,
    lastError: null,
    consecutiveFailures: 0,
    avoidServerId: null,
    deliveredAt: null,
    roster: [],
    helperAddresses: [],
    ...overrides,
  }
}

test('state round trips through metadata and keeps the other keys', () => {
  const metadata = withHttpIssuanceState(
    { dnsNames: ['a.example.com'], acme: { stage: 'x' } },
    state()
  )
  assertEquals(metadata.dnsNames, ['a.example.com'])
  assertEquals(metadata.acme, { stage: 'x' })
  assertEquals(readHttpIssuanceState(metadata), state())
})

test('unknown shapes read as null', () => {
  for (const bad of [null, undefined, 'x', [], {}, { httpCert: 'x' }, { httpCert: {} }]) {
    assertEquals(readHttpIssuanceState(bad), null)
  }
  assertEquals(readHttpIssuanceState({ httpCert: { ...state(), requestId: '' } }), null)
})

test('bad forward entries are dropped and the rest is kept', () => {
  const read = readHttpIssuanceState({
    httpCert: {
      ...state(),
      forwards: [
        { serverId: 'b', outcome: 'nope' },
        3,
        { serverId: 'c', outcome: 'skipped', reason: 'offline' },
      ],
    },
  })
  assertEquals(read?.forwards, [{ serverId: 'c', outcome: 'skipped', reason: 'offline', at: null }])
})

test('capture is accepted from the asked server for the open request', () => {
  assertEquals(canAcceptCapture(state(), { serverId: 'server-a', requestId: 'req_1', now: NOW }), {
    ok: true,
  })
})

test('capture is refused from another server, for another or unknown request, when closed or expired', () => {
  const call = { serverId: 'server-a', requestId: 'req_1', now: NOW }
  assertEquals(canAcceptCapture(state(), { ...call, serverId: 'server-b' }), {
    ok: false,
    reason: 'wrong_server',
  })
  assertEquals(canAcceptCapture(state(), { ...call, requestId: 'req_2' }), {
    ok: false,
    reason: 'unknown_request',
  })
  assertEquals(canAcceptCapture(null, call), { ok: false, reason: 'unknown_request' })
  assertEquals(canAcceptCapture(state({ endedAt: '2026-11-01T11:59:00.000Z' }), call), {
    ok: false,
    reason: 'closed',
  })
  assertEquals(canAcceptCapture(state({ startByAt: '2026-11-01T11:59:00.000Z' }), call), {
    ok: false,
    reason: 'expired',
  })
  assertEquals(canAcceptCapture(state({ startByAt: 'garbage' }), call), {
    ok: false,
    reason: 'expired',
  })
})

test('a pair stored first leaves the request open until the issued event', () => {
  const stored = afterCapture(state(), NOW)
  assertEquals(stored.capturedAt, NOW.toISOString())
  assertEquals(stored.endedAt, null)
})

test('a pair stored after the issued event closes the request as issued', () => {
  const closed = afterCapture(
    state({ issuedEventAt: '2026-11-01T11:59:00.000Z', consecutiveFailures: 2, lastError: 'x' }),
    NOW
  )
  assertEquals(closed.endedAt, NOW.toISOString())
  assertEquals(closed.phase, 'issued')
  assertEquals(closed.consecutiveFailures, 0)
  assertEquals(closed.lastError, null)
})

test('the request is expired at exactly the start-by time', () => {
  const call = {
    serverId: 'server-a',
    requestId: 'req_1',
    now: new Date('2026-11-01T12:30:00.000Z'),
  }
  assertEquals(canAcceptCapture(state(), call), { ok: false, reason: 'expired' })
})

test('an old state without the newer fields still reads', () => {
  const metadata = {
    httpCert: {
      issuingServerId: 'a',
      requestId: 'r',
      startedAt: '2026-11-01T11:55:00.000Z',
      startByAt: '2026-11-01T12:30:00.000Z',
    },
  }
  const read = readHttpIssuanceState(metadata)
  assertEquals(read?.phase, 'forwarding')
  assertEquals(read?.directory, 'production')
  assertEquals(read?.consecutiveFailures, 0)
})

test('a request for two names closes only when both are covered and issued has arrived', () => {
  const names = ['a.example.com', 'www.a.example.com']
  const issued = state({ issuedEventAt: '2026-11-01T11:59:00.000Z' })
  const one = afterCapture(issued, NOW, ['a.example.com'], names)
  assertEquals(one.endedAt, null)
  const both = afterCapture(one, NOW, ['www.a.example.com'], names)
  assertEquals(both.phase, 'issued')
  const together = afterCapture(issued, NOW, names, names)
  assertEquals(together.phase, 'issued')
  // Pairs first, event later: the event closes it (see progress tests).
  assertEquals(afterCapture(state(), NOW, names, names).endedAt, null)
})

test('a late pair for another name is accepted briefly after the close, from the asked server only', () => {
  const closed = state({ phase: 'issued', endedAt: '2026-11-01T11:59:00.000Z' })
  const call = { serverId: 'server-a', requestId: 'req_1', now: NOW }
  assertEquals(canAcceptCapture(closed, call), { ok: true })
  assertEquals(canAcceptCapture(closed, { ...call, serverId: 'server-b' }), {
    ok: false,
    reason: 'wrong_server',
  })
  assertEquals(canAcceptCapture(closed, { ...call, now: new Date('2026-11-01T12:10:00.000Z') }), {
    ok: false,
    reason: 'closed',
  })
  assertEquals(
    canAcceptCapture(state({ phase: 'failed', endedAt: '2026-11-01T11:59:00.000Z' }), call),
    {
      ok: false,
      reason: 'closed',
    }
  )
  assertEquals(afterCapture(closed, NOW, ['x.example.com']).endedAt, closed.endedAt)
})
