import { assertEquals } from 'jsr:@std/assert'
import {
  assembleTlsMetadata,
  metadataFromParsed,
  refreshTlsStatus,
  splitTlsMetadata,
} from './metadata.ts'
import type { ParsedCertificate, TlsMetadata } from './types.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const parsed: ParsedCertificate = {
  dnsNames: ['app.example.com', '*.example.com'],
  hasWildcard: true,
  notBefore: new Date('2026-01-01T00:00:00.000Z'),
  notAfter: new Date('2027-01-01T00:00:00.000Z'),
  fingerprintSha256: 'a'.repeat(64),
  subject: 'CN=app.example.com',
  issuer: 'CN=app.example.com',
  leafDer: new Uint8Array(),
  spkiDer: new Uint8Array(),
}

const fullMetadata: TlsMetadata = {
  dnsNames: parsed.dnsNames,
  hasWildcard: parsed.hasWildcard,
  notBefore: parsed.notBefore.toISOString(),
  notAfter: parsed.notAfter.toISOString(),
  fingerprintSha256: parsed.fingerprintSha256,
  subject: parsed.subject,
  issuer: parsed.issuer,
  status: 'ready',
}

test('metadataFromParsed builds a full TlsMetadata DTO from a parsed cert', () => {
  const meta = metadataFromParsed(parsed)
  assertEquals(meta, fullMetadata)
  assertEquals(metadataFromParsed(parsed, 'pending').status, 'pending')
})

test('splitTlsMetadata separates promoted columns from residual jsonb', () => {
  const { columns, residual } = splitTlsMetadata(fullMetadata)
  assertEquals(columns, {
    status: 'ready',
    notAfter: fullMetadata.notAfter,
    fingerprintSha256: fullMetadata.fingerprintSha256,
  })
  assertEquals(residual, {
    dnsNames: fullMetadata.dnsNames,
    hasWildcard: fullMetadata.hasWildcard,
    notBefore: fullMetadata.notBefore,
    subject: fullMetadata.subject,
    issuer: fullMetadata.issuer,
  })
  // Promoted fields never leak into the residual jsonb payload.
  assertEquals('status' in residual, false)
  assertEquals('notAfter' in residual, false)
  assertEquals('fingerprintSha256' in residual, false)
})

test('splitTlsMetadata carries acme metadata in the residual payload', () => {
  const withAcme: TlsMetadata = {
    ...fullMetadata,
    acme: { orderUrl: 'https://acme.example/order/1', challengeType: 'dns-01' },
  }
  const { residual } = splitTlsMetadata(withAcme)
  assertEquals(residual.acme, withAcme.acme)
})

test('splitTlsMetadata nulls out a blank fingerprint column', () => {
  const { columns } = splitTlsMetadata({ ...fullMetadata, fingerprintSha256: '   ' })
  assertEquals(columns.fingerprintSha256, null)
})

test('assembleTlsMetadata reassembles the DTO from dedicated columns + residual', () => {
  const { columns, residual } = splitTlsMetadata(fullMetadata)
  const assembled = assembleTlsMetadata(columns, residual)
  assertEquals(assembled, fullMetadata)
})

test('assembleTlsMetadata round-trips acme metadata through split + assemble', () => {
  const withAcme: TlsMetadata = {
    ...fullMetadata,
    acme: { orderUrl: 'https://acme.example/order/1', challengeType: 'http-01' },
  }
  const { columns, residual } = splitTlsMetadata(withAcme)
  assertEquals(assembleTlsMetadata(columns, residual), withAcme)
})

test('assembleTlsMetadata requires promoted fields from dedicated columns, never from residual jsonb', () => {
  // Even when the residual jsonb still carries status/notAfter/fingerprintSha256
  // keys (e.g. hand-crafted or stale data), only the dedicated columns count.
  const residualWithStaleKeys = {
    dnsNames: fullMetadata.dnsNames,
    hasWildcard: fullMetadata.hasWildcard,
    notBefore: fullMetadata.notBefore,
    subject: fullMetadata.subject,
    issuer: fullMetadata.issuer,
    notAfter: '2020-01-01T00:00:00.000Z',
    fingerprintSha256: 'b'.repeat(64),
    status: 'expired',
  }
  const assembled = assembleTlsMetadata(
    {
      status: 'ready',
      notAfter: fullMetadata.notAfter,
      fingerprintSha256: fullMetadata.fingerprintSha256,
    },
    residualWithStaleKeys,
  )
  assertEquals(assembled?.status, 'ready')
  assertEquals(assembled?.notAfter, fullMetadata.notAfter)
  assertEquals(assembled?.fingerprintSha256, fullMetadata.fingerprintSha256)
})

test('assembleTlsMetadata returns null when a required column is missing, even if residual jsonb has the key', () => {
  const residualWithStaleKeys = {
    dnsNames: fullMetadata.dnsNames,
    hasWildcard: fullMetadata.hasWildcard,
    notBefore: fullMetadata.notBefore,
    subject: fullMetadata.subject,
    issuer: fullMetadata.issuer,
    notAfter: fullMetadata.notAfter,
    status: fullMetadata.status,
  }
  assertEquals(
    assembleTlsMetadata(
      { status: fullMetadata.status, notAfter: null, fingerprintSha256: null },
      residualWithStaleKeys,
    ),
    null,
  )
  assertEquals(
    assembleTlsMetadata(
      { status: null, notAfter: fullMetadata.notAfter, fingerprintSha256: null },
      residualWithStaleKeys,
    ),
    null,
  )
})

test('assembleTlsMetadata returns null when residual is malformed or missing required fields', () => {
  const columns = {
    status: 'ready' as const,
    notAfter: fullMetadata.notAfter,
    fingerprintSha256: fullMetadata.fingerprintSha256,
  }
  assertEquals(assembleTlsMetadata(columns, null), null)
  assertEquals(assembleTlsMetadata(columns, 'nope'), null)
  assertEquals(assembleTlsMetadata(columns, []), null)
  assertEquals(assembleTlsMetadata(columns, {}), null)
  assertEquals(
    assembleTlsMetadata(columns, {
      dnsNames: [1, 2],
      hasWildcard: true,
      notBefore: fullMetadata.notBefore,
      subject: fullMetadata.subject,
      issuer: fullMetadata.issuer,
    }),
    null,
  )
})

test('assembleTlsMetadata returns null when the status column is invalid', () => {
  const { residual } = splitTlsMetadata(fullMetadata)
  const assembled = assembleTlsMetadata(
    { status: 'not-a-status', notAfter: null, fingerprintSha256: null },
    residual,
  )
  assertEquals(assembled, null)
})

test('assembleTlsMetadata preserves empty fingerprintSha256 for pending non-materialized certs', () => {
  const pending: TlsMetadata = {
    dnsNames: ['pending.example.com'],
    hasWildcard: false,
    notBefore: new Date(0).toISOString(),
    notAfter: new Date(0).toISOString(),
    fingerprintSha256: '',
    subject: '',
    issuer: '',
    status: 'pending',
    acme: { challengeType: 'http-01' },
  }
  const { columns, residual } = splitTlsMetadata(pending)
  assertEquals(columns.fingerprintSha256, null)
  assertEquals('fingerprintSha256' in residual, false)

  const assembled = assembleTlsMetadata(columns, residual)
  assertEquals(assembled, pending)
  assertEquals(assembled?.fingerprintSha256, '')
})

test('refreshTlsStatus flips ready certs past notAfter to expired', () => {
  const now = new Date('2027-06-01T00:00:00.000Z')
  const refreshed = refreshTlsStatus(fullMetadata, now)
  assertEquals(refreshed.status, 'expired')
  // Other statuses are left untouched even when notAfter has passed.
  const pending: TlsMetadata = { ...fullMetadata, status: 'pending' }
  assertEquals(refreshTlsStatus(pending, now).status, 'pending')
})

test('assembleTlsMetadata returns null when residual field types are wrong', () => {
  const columns = {
    status: 'ready' as const,
    notAfter: fullMetadata.notAfter,
    fingerprintSha256: fullMetadata.fingerprintSha256,
  }
  assertEquals(
    assembleTlsMetadata(columns, {
      dnsNames: fullMetadata.dnsNames,
      hasWildcard: 'yes',
      notBefore: fullMetadata.notBefore,
      subject: fullMetadata.subject,
      issuer: fullMetadata.issuer,
    }),
    null,
  )
  assertEquals(
    assembleTlsMetadata(columns, {
      dnsNames: fullMetadata.dnsNames,
      hasWildcard: true,
      notBefore: 1,
      subject: fullMetadata.subject,
      issuer: fullMetadata.issuer,
    }),
    null,
  )
  assertEquals(
    assembleTlsMetadata(columns, {
      dnsNames: fullMetadata.dnsNames,
      hasWildcard: true,
      notBefore: fullMetadata.notBefore,
      subject: 1,
      issuer: fullMetadata.issuer,
    }),
    null,
  )
})

test('refreshTlsStatus leaves ready certs alone before notAfter', () => {
  const now = new Date('2026-06-01T00:00:00.000Z')
  assertEquals(refreshTlsStatus(fullMetadata, now), fullMetadata)
})

test('refreshTlsStatus ignores unparseable notAfter on ready certs', () => {
  const broken: TlsMetadata = { ...fullMetadata, notAfter: 'not-a-date' }
  assertEquals(
    refreshTlsStatus(broken, new Date('2099-01-01T00:00:00.000Z')),
    broken,
  )
})
