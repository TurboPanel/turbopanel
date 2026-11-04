import { assert, assertEquals } from '@std/assert'
import { AcmeError } from '../../../../lib/acme/client.ts'
import { TunnelProviderError } from '../../../../features/tunnels/errors.ts'
import {
  alertsFor,
  DNS01_BACKOFF_BASE_MS,
  DNS01_BACKOFF_CAP_MS,
  DNS01_MAX_ATTEMPTS,
  Dns01AccountError,
  failureState,
  mapAcmeFailure,
  nextAttemptAt,
} from './backoff.ts'
import { clearedForRetry, type Dns01Failure, type Dns01State, IDLE_STATE } from './state.ts'

const test = Deno.test.bind(Deno)

const NOW = new Date('2026-11-01T10:20:00.000Z')

function seeded(seed: number): () => number {
  let x = seed
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648
    return x / 2147483648
  }
}

test('nextAttemptAt stays inside [base, min(cap, base·2^n)]', () => {
  const random = seeded(7)
  for (let n = 0; n <= 6; n++) {
    const delay = nextAttemptAt(NOW, n, random).getTime() - NOW.getTime()
    const ceiling = Math.min(DNS01_BACKOFF_CAP_MS, DNS01_BACKOFF_BASE_MS * 2 ** n)
    assert(delay >= DNS01_BACKOFF_BASE_MS && delay <= ceiling, `n=${n} delay=${delay}`)
  }
})

test('a fifth start within the hour waits for the window to clear', () => {
  const starts = [10, 20, 30, 40].map((min) => new Date(NOW.getTime() - min * 60_000).toISOString())
  const at = nextAttemptAt(NOW, 1, () => 0, starts)
  const oldest = NOW.getTime() - 40 * 60_000
  assert(at.getTime() > oldest + 60 * 60_000)
})

test('the duplicate limit stops retries for the week or until the authority says', () => {
  const plain = mapAcmeFailure(
    new AcmeError(
      'rate_limited',
      'too many certificates (5) already issued for this exact set of identifiers'
    ),
    NOW
  )
  assertEquals(plain.cause, 'duplicate-limit')
  assertEquals(plain.stopUntil?.getTime(), NOW.getTime() + 7 * 24 * 60 * 60_000)
  const dated = mapAcmeFailure(
    new AcmeError(
      'rate_limited',
      'too many certificates already issued, retry after 2026-11-05 08:00:00 UTC: see docs'
    ),
    NOW
  )
  assertEquals(dated.stopUntil?.toISOString(), '2026-11-05T08:00:00.000Z')
})

test('the failed validation limit stops retries until the top of the next hour', () => {
  const mapped = mapAcmeFailure(
    new AcmeError('rate_limited', 'too many failed authorizations recently'),
    NOW
  )
  assertEquals(mapped.cause, 'failed-authz-limit')
  assertEquals(mapped.stopUntil?.toISOString(), '2026-11-01T11:00:00.000Z')
})

test('each failure kind maps to one plain cause', () => {
  assertEquals(mapAcmeFailure(new AcmeError('caa', 'CAA forbids'), NOW).cause, 'caa-forbids')
  assertEquals(mapAcmeFailure(new AcmeError('dns', 'NXDOMAIN'), NOW).cause, 'txt-not-visible')
  assertEquals(mapAcmeFailure(new AcmeError('account_gone', 'gone'), NOW).cause, 'account-error')
  assertEquals(mapAcmeFailure(new Dns01AccountError('terms'), NOW).cause, 'account-error')
  assertEquals(
    mapAcmeFailure(new TunnelProviderError('forbidden', 'no', 403), NOW).cause,
    'scope-missing'
  )
  assertEquals(
    mapAcmeFailure(new TunnelProviderError('rate_limited', 'slow', 429, [], 5000), NOW).cause,
    'provider-rate-limited'
  )
  assertEquals(mapAcmeFailure(new Error('x'.repeat(500)), NOW).detail.length, 200)
})

const LOOKUP: Dns01Failure = { cause: 'dns-lookup', detail: 'No nameservers found.' }
const MINUTE = 60_000

function fail(state: Dns01State, failure: Dns01Failure, now = NOW): Dns01State {
  return failureState(state, failure, { now, random: () => 0, stopUntil: null })
}

test('a nameserver lookup failure backs off 1, 5, 15, 60 minutes, then hourly, and never stops', () => {
  let state: Dns01State = { ...IDLE_STATE, stage: 'preflight' }
  const delays: number[] = []
  for (let n = 0; n < DNS01_MAX_ATTEMPTS + 3; n++) {
    state = fail(state, LOOKUP)
    delays.push((Date.parse(state.nextAttemptAt ?? '') - NOW.getTime()) / MINUTE)
    assertEquals(state.stage, 'backoff')
  }
  assertEquals(delays, [1, 5, 15, 60, 60, 60, 60, 60, 60])
  assertEquals(state.attempts, 0)
  assertEquals(state.lookupFailures, DNS01_MAX_ATTEMPTS + 3)
  assertEquals(state.lastError, { ...LOOKUP, at: NOW.toISOString() })
})

test('a lookup failure leaves the failed-order count alone, and an order failure still stops at the limit', () => {
  const nearLimit: Dns01State = {
    ...IDLE_STATE,
    stage: 'backoff',
    attempts: DNS01_MAX_ATTEMPTS - 1,
  }
  const looked = fail(nearLimit, LOOKUP)
  assertEquals(looked.stage, 'backoff')
  assertEquals(looked.attempts, DNS01_MAX_ATTEMPTS - 1)
  const refused = fail(looked, { cause: 'caa-forbids', detail: 'CAA forbids' })
  assertEquals(refused.stage, 'failed')
  assertEquals(refused.attempts, DNS01_MAX_ATTEMPTS)
  assertEquals(refused.nextAttemptAt, null)
  assertEquals(refused.lookupFailures, 0)
})

test('authority refusals still count toward the limit as before', () => {
  const causes = ['caa-forbids', 'txt-not-visible', 'acme-error', 'scope-missing'] as const
  for (const cause of causes) {
    let state: Dns01State = { ...IDLE_STATE }
    for (let n = 1; n <= DNS01_MAX_ATTEMPTS; n++) {
      state = fail(state, { cause, detail: cause })
      assertEquals(state.attempts, n)
      assertEquals(state.stage, n === DNS01_MAX_ATTEMPTS ? 'failed' : 'backoff', cause)
    }
  }
})

test('a lookup failure keeps the start times it is given and honours a stop time', () => {
  const kept = failureState({ ...IDLE_STATE, attemptTimes: ['a', 'b'] }, LOOKUP, {
    now: NOW,
    random: () => 0,
    stopUntil: new Date(NOW.getTime() + 30 * MINUTE),
    attemptTimes: ['a'],
  })
  assertEquals(kept.attemptTimes, ['a'])
  assertEquals(kept.nextAttemptAt, new Date(NOW.getTime() + 30 * MINUTE).toISOString())
})

test('a lookup failure alerts only once it repeats', () => {
  const first = fail({ ...IDLE_STATE }, LOOKUP)
  const second = fail(first, LOOKUP)
  const third = fail(second, LOOKUP)
  assertEquals(
    [first, second, third].map((state) => alertsFor(state, LOOKUP)),
    [false, false, true]
  )
  assertEquals(alertsFor(first, { cause: 'caa-forbids', detail: '' }), true)
})

test('Retry clears both failure counts and keeps the rest of the state', () => {
  let state = fail({ ...IDLE_STATE }, { cause: 'acme-error', detail: 'refused' })
  state = fail(fail(state, LOOKUP), LOOKUP)
  assertEquals([state.attempts, state.lookupFailures], [1, 2])
  const cleared = clearedForRetry(state)
  assertEquals([cleared.attempts, cleared.lookupFailures], [0, 0])
  assertEquals(cleared, { ...state, attempts: 0, lookupFailures: 0 })
})
