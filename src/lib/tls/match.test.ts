import { assertEquals } from 'jsr:@std/assert'
import {
  coversAllHostnames,
  coversHostname,
  normalizeHostname,
  parseTlsOptions,
  resolveTlsForHosting,
} from './match.ts'
import type { TlsCandidate, TlsMetadata } from './types.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const NOW = new Date('2026-06-01T00:00:00.000Z')

function readyMeta(dnsNames: string[], overrides: Partial<TlsMetadata> = {}): TlsMetadata {
  return {
    dnsNames,
    hasWildcard: dnsNames.some((n) => n.startsWith('*.')),
    notBefore: '2026-01-01T00:00:00.000Z',
    notAfter: '2027-01-01T00:00:00.000Z',
    fingerprintSha256: 'abc',
    subject: 'CN=test',
    issuer: 'CN=test',
    status: 'ready',
    ...overrides,
  }
}

function candidate(id: string, dnsNames: string[], overrides?: Partial<TlsMetadata>): TlsCandidate {
  return { id, metadata: readyMeta(dnsNames, overrides), options: null }
}

test('normalizeHostname lowercases and strips a trailing dot', () => {
  assertEquals(normalizeHostname('  Example.COM.  '), 'example.com')
  assertEquals(normalizeHostname('apex.example.com'), 'apex.example.com')
})

test('coversHostname matches exact names and one-label wildcards', () => {
  assertEquals(coversHostname(['example.com'], 'Example.COM.'), true)
  assertEquals(coversHostname(['*.example.com'], 'a.example.com'), true)
  assertEquals(coversHostname(['*.example.com'], 'example.com'), false)
  assertEquals(coversHostname(['*.example.com'], 'a.b.example.com'), false)
  assertEquals(coversHostname(['*.example.com'], ''), false)
  assertEquals(coversHostname(['other.com'], 'example.com'), false)
})

test('coversAllHostnames requires every hostname to be covered', () => {
  assertEquals(coversAllHostnames(['*.example.com'], []), false)
  assertEquals(
    coversAllHostnames(['*.example.com', 'example.com'], ['a.example.com', 'example.com']),
    true,
  )
  assertEquals(
    coversAllHostnames(['*.example.com'], ['a.example.com', 'b.example.com', 'c.d.example.com']),
    false,
  )
})

test('resolveTlsForHosting uses internal when hostnames or pin are absent', () => {
  assertEquals(
    resolveTlsForHosting({ pinId: null, hostnames: [], candidates: [], now: NOW }),
    { ok: true, tlsId: null, reason: 'internal' },
  )
  assertEquals(
    resolveTlsForHosting({
      pinId: undefined,
      hostnames: ['app.example.com'],
      candidates: [candidate('tls-1', ['*.example.com'])],
      now: NOW,
    }),
    { ok: true, tlsId: null, reason: 'internal' },
  )
})

test('resolveTlsForHosting accepts a ready pin that covers all hostnames', () => {
  const pinned = candidate('tls-1', ['*.example.com', 'example.com'])
  assertEquals(
    resolveTlsForHosting({
      pinId: 'tls-1',
      hostnames: ['App.Example.COM.', 'example.com'],
      candidates: [pinned],
      now: NOW,
    }),
    { ok: true, tlsId: 'tls-1', reason: 'pin' },
  )
})

test('resolveTlsForHosting rejects missing, unready, or mismatched pins', () => {
  assertEquals(
    resolveTlsForHosting({
      pinId: 'missing',
      hostnames: ['a.example.com'],
      candidates: [candidate('tls-1', ['*.example.com'])],
      now: NOW,
    }),
    { ok: false, error: 'pin_not_found' },
  )
  assertEquals(
    resolveTlsForHosting({
      pinId: 'tls-1',
      hostnames: ['a.example.com'],
      candidates: [candidate('tls-1', ['*.example.com'], { status: 'pending' })],
      now: NOW,
    }),
    { ok: false, error: 'pin_not_ready' },
  )
  assertEquals(
    resolveTlsForHosting({
      pinId: 'tls-1',
      hostnames: ['a.example.com'],
      candidates: [
        candidate('tls-1', ['*.example.com'], {
          notBefore: '2026-07-01T00:00:00.000Z',
        }),
      ],
      now: NOW,
    }),
    { ok: false, error: 'pin_not_ready' },
  )
  assertEquals(
    resolveTlsForHosting({
      pinId: 'tls-1',
      hostnames: ['a.example.com'],
      candidates: [
        candidate('tls-1', ['*.example.com'], {
          notAfter: 'not-a-date',
        }),
      ],
      now: NOW,
    }),
    { ok: false, error: 'pin_not_ready' },
  )
  assertEquals(
    resolveTlsForHosting({
      pinId: 'tls-1',
      hostnames: ['other.com'],
      candidates: [candidate('tls-1', ['*.example.com'])],
      now: NOW,
    }),
    { ok: false, error: 'pin_mismatch' },
  )
})

test('parseTlsOptions reads prefer, autoRenew, and requestedHostnames', () => {
  assertEquals(parseTlsOptions(null), null)
  assertEquals(parseTlsOptions('x'), null)
  assertEquals(parseTlsOptions([]), null)
  assertEquals(
    parseTlsOptions({
      prefer: 10,
      autoRenew: true,
      requestedHostnames: ['a.example.com', 'b.example.com'],
      ignored: true,
    }),
    {
      prefer: 10,
      autoRenew: true,
      requestedHostnames: ['a.example.com', 'b.example.com'],
    },
  )
  assertEquals(
    parseTlsOptions({
      prefer: Number.NaN,
      autoRenew: 'yes',
      requestedHostnames: ['ok', 1],
    }),
    {},
  )
})
