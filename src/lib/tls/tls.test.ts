import { assertEquals, assertRejects } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import {
  coversAllHostnames,
  coversHostname,
  metadataFromParsed,
  mintSelfSignedCertificate,
  normalizeHostname,
  parseCertificatePem,
  parseTlsOptions,
  privateKeyMatchesCertificate,
  resolveTlsForHosting,
  TlsKeyError,
  type TlsCandidate,
} from './index.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

describe('normalizeHostname', () => {
  it('lowercases, trims, and strips a trailing dot', () => {
    assertEquals(normalizeHostname('  API.Example.COM.  '), 'api.example.com')
    assertEquals(normalizeHostname('host.example.com.'), 'host.example.com')
  })
})

describe('coversHostname', () => {
  it('matches exact names case-insensitively', () => {
    assertEquals(coversHostname(['Example.COM'], 'example.com'), true)
  })

  it('matches one-label wildcards', () => {
    assertEquals(coversHostname(['*.example.com'], 'api.example.com'), true)
    assertEquals(coversHostname(['*.example.com'], 'example.com'), false)
    assertEquals(coversHostname(['*.example.com'], 'a.b.example.com'), false)
  })

  it('supports multi-SAN lists', () => {
    assertEquals(
      coversHostname(['a.example.com', 'b.example.com'], 'b.example.com'),
      true,
    )
  })

  it('rejects empty hostnames and blank labels under wildcards', () => {
    assertEquals(coversHostname(['*.example.com'], ''), false)
    assertEquals(coversHostname(['*.example.com'], '   '), false)
    assertEquals(coversHostname(['*.example.com'], '.example.com'), false)
  })
})

describe('coversAllHostnames', () => {
  it('requires every hostname to match and rejects empty lists', () => {
    assertEquals(
      coversAllHostnames(['*.example.com'], ['api.example.com', 'www.example.com']),
      true,
    )
    assertEquals(
      coversAllHostnames(['*.example.com'], ['api.example.com', 'other.test']),
      false,
    )
    assertEquals(coversAllHostnames(['*.example.com'], []), false)
  })
})

describe('parseCertificatePem + self-signed', () => {
  it('parses DNS SANs and fingerprint from a minted leaf', async () => {
    const material = await mintSelfSignedCertificate([
      'app.example.com',
      '*.example.com',
    ])
    const parsed = await parseCertificatePem(material.certificatePem)
    assertEquals(parsed.dnsNames.includes('app.example.com'), true)
    assertEquals(parsed.dnsNames.includes('*.example.com'), true)
    assertEquals(parsed.hasWildcard, true)
    assertEquals(parsed.fingerprintSha256.length, 64)
    assertEquals(
      await privateKeyMatchesCertificate(material.privateKeyPem, parsed),
      true,
    )
  })

  it('rejects garbage PEM', async () => {
    await assertRejects(
      () => parseCertificatePem('not-a-cert'),
      Error,
    )
  })
})

describe('resolveTlsForHosting', () => {
  const now = new Date('2026-06-01T00:00:00.000Z')

  function candidate(
    id: string,
    dnsNames: string[],
    opts?: { prefer?: number; status?: 'ready' | 'pending' | 'expired' },
  ): TlsCandidate {
    return {
      id,
      metadata: {
        dnsNames,
        hasWildcard: dnsNames.some((n) => n.startsWith('*.')),
        notBefore: '2026-01-01T00:00:00.000Z',
        notAfter: '2027-01-01T00:00:00.000Z',
        fingerprintSha256: 'a'.repeat(64),
        subject: `CN=${dnsNames[0]}`,
        issuer: `CN=${dnsNames[0]}`,
        status: opts?.status ?? 'ready',
      },
      options: opts?.prefer === undefined ? null : { prefer: opts.prefer },
    }
  }

  it('uses pinned cert when it covers all hostnames', () => {
    const result = resolveTlsForHosting({
      pinId: 'pin-1',
      hostnames: ['api.example.com'],
      candidates: [candidate('pin-1', ['*.example.com'])],
      now,
    })
    assertEquals(result, { ok: true, tlsId: 'pin-1', reason: 'pin' })
  })

  it('fails when pin does not cover hostnames', () => {
    const result = resolveTlsForHosting({
      pinId: 'pin-1',
      hostnames: ['other.test'],
      candidates: [candidate('pin-1', ['*.example.com'])],
      now,
    })
    assertEquals(result, { ok: false, error: 'pin_mismatch' })
  })

  it('fails when pin is not ready', () => {
    const result = resolveTlsForHosting({
      pinId: 'pin-1',
      hostnames: ['api.example.com'],
      candidates: [
        candidate('pin-1', ['*.example.com'], { status: 'pending' }),
      ],
      now,
    })
    assertEquals(result, { ok: false, error: 'pin_not_ready' })
  })

  it('defaults to internal self-signed when no pin (never auto-picks library certs)', () => {
    const result = resolveTlsForHosting({
      pinId: null,
      hostnames: ['api.example.com'],
      candidates: [
        candidate('wild', ['*.example.com']),
        candidate('exact', ['api.example.com']),
        candidate('le', ['api.example.com']),
      ],
      now,
    })
    assertEquals(result, { ok: true, tlsId: null, reason: 'internal' })
  })

  it('defaults to internal when hostnames are empty', () => {
    const result = resolveTlsForHosting({
      pinId: null,
      hostnames: [],
      candidates: [candidate('exact', ['api.example.com'])],
      now,
    })
    assertEquals(result, { ok: true, tlsId: null, reason: 'internal' })
  })

  it('builds metadata from parsed certs', async () => {
    const material = await mintSelfSignedCertificate(['solo.example.com'])
    const meta = metadataFromParsed(material.parsed)
    assertEquals(meta.status, 'ready')
    assertEquals(meta.dnsNames.includes('solo.example.com'), true)
  })

  it('fails when pin id is unknown', () => {
    const result = resolveTlsForHosting({
      pinId: 'missing',
      hostnames: ['api.example.com'],
      candidates: [candidate('pin-1', ['*.example.com'])],
      now,
    })
    assertEquals(result, { ok: false, error: 'pin_not_found' })
  })

  it('fails when pin is expired or outside the validity window', () => {
    const expired = resolveTlsForHosting({
      pinId: 'pin-1',
      hostnames: ['api.example.com'],
      candidates: [{
        ...candidate('pin-1', ['*.example.com']),
        metadata: {
          ...candidate('pin-1', ['*.example.com']).metadata,
          notAfter: '2025-01-01T00:00:00.000Z',
        },
      }],
      now,
    })
    assertEquals(expired, { ok: false, error: 'pin_not_ready' })

    const notYetValid = resolveTlsForHosting({
      pinId: 'pin-1',
      hostnames: ['api.example.com'],
      candidates: [{
        ...candidate('pin-1', ['*.example.com']),
        metadata: {
          ...candidate('pin-1', ['*.example.com']).metadata,
          notBefore: '2027-01-01T00:00:00.000Z',
        },
      }],
      now,
    })
    assertEquals(notYetValid, { ok: false, error: 'pin_not_ready' })

    const badDates = resolveTlsForHosting({
      pinId: 'pin-1',
      hostnames: ['api.example.com'],
      candidates: [{
        ...candidate('pin-1', ['*.example.com']),
        metadata: {
          ...candidate('pin-1', ['*.example.com']).metadata,
          notBefore: 'not-a-date',
          notAfter: 'also-not-a-date',
        },
      }],
      now,
    })
    assertEquals(badDates, { ok: false, error: 'pin_not_ready' })
  })

  it('normalizes hostnames before matching pins', () => {
    const result = resolveTlsForHosting({
      pinId: 'pin-1',
      hostnames: ['  API.Example.COM.  '],
      candidates: [candidate('pin-1', ['api.example.com'])],
      now,
    })
    assertEquals(result, { ok: true, tlsId: 'pin-1', reason: 'pin' })
  })
})

describe('parseTlsOptions', () => {
  it('returns null for non-objects', () => {
    assertEquals(parseTlsOptions(null), null)
    assertEquals(parseTlsOptions(undefined), null)
    assertEquals(parseTlsOptions('x'), null)
    assertEquals(parseTlsOptions([]), null)
  })

  it('keeps finite prefer, boolean autoRenew, and string hostnames', () => {
    assertEquals(
      parseTlsOptions({
        prefer: 2,
        autoRenew: true,
        requestedHostnames: ['a.example.com', 'b.example.com'],
        ignored: true,
      }),
      {
        prefer: 2,
        autoRenew: true,
        requestedHostnames: ['a.example.com', 'b.example.com'],
      },
    )
    assertEquals(
      parseTlsOptions({ prefer: Number.NaN, requestedHostnames: [1] }),
      {},
    )
  })

  it('returns an empty object for records with no recognized fields', () => {
    assertEquals(parseTlsOptions({}), {})
    assertEquals(parseTlsOptions({ autoRenew: 'yes' }), {})
  })
})

describe('mintSelfSignedCertificate', () => {
  it('rejects empty DNS name lists', async () => {
    await assertRejects(
      () => mintSelfSignedCertificate([]),
      TypeError,
      'at least one DNS name is required',
    )
    await assertRejects(
      () => mintSelfSignedCertificate(['  ', '']),
      TypeError,
      'at least one DNS name is required',
    )
  })

  it('honors custom validity and common name options', async () => {
    const material = await mintSelfSignedCertificate(
      ['svc.example.com'],
      { validDays: 30, commonName: 'custom.example.com' },
    )
    assertEquals(material.parsed.dnsNames.includes('svc.example.com'), true)
    assertEquals(material.parsed.subject.includes('CN=custom.example.com'), true)
  })
})

describe('privateKeyMatchesCertificate', () => {
  it('returns false for a mismatched private key', async () => {
    const first = await mintSelfSignedCertificate(['one.example.com'])
    const second = await mintSelfSignedCertificate(['two.example.com'])
    assertEquals(
      await privateKeyMatchesCertificate(second.privateKeyPem, first.parsed),
      false,
    )
  })

  it('wraps PEM decode failures as TlsKeyError', async () => {
    const material = await mintSelfSignedCertificate(['solo.example.com'])
    await assertRejects(
      () => privateKeyMatchesCertificate('not-a-key', material.parsed),
      TlsKeyError,
    )
  })
})

// Keep a named Deno.test entry so the suite is discoverable when BDD is filtered.
test('tls module suite loaded', () => {
  assertEquals(typeof coversHostname, 'function')
})
