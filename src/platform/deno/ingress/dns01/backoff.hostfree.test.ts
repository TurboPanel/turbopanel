import { assert, assertEquals } from '@std/assert'
import { AcmeError } from '../../../../lib/acme/client.ts'
import { TunnelProviderError } from '../../../../features/tunnels/errors.ts'
import {
  DNS01_BACKOFF_BASE_MS,
  DNS01_BACKOFF_CAP_MS,
  Dns01AccountError,
  mapAcmeFailure,
  nextAttemptAt,
} from './backoff.ts'

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
