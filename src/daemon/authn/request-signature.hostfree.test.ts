import { assert, assertEquals } from '@std/assert'
import { base64urlEncode } from '../../lib/encoding/base64url.ts'
import { computePublicKeyFingerprint } from './server-key.ts'
import { testDaemonKey } from '../../test-fixtures/daemon-signing-key.test.support.ts'
import {
  EMPTY_BODY_SHA256_B64U,
  REQUEST_CLOCK_SKEW_ERROR,
  daemonKeyThumbprint,
  parseDaemonSignatureHeader,
  requestSigningInput,
  sha256B64u,
  verifyDaemonRequest,
} from './request-signature.ts'

const test = Deno.test.bind(Deno)

const NOW_MS = Date.parse('2026-11-05T12:00:00.000Z')
const NOW_S = NOW_MS / 1000
const PANEL = 'P'.repeat(43)
const NEXT = 'N'.repeat(43)
const NONCE = 'AAAAAAAAAAAAAAAAAAAAAA'
const KEY_ID = '7d0a1c3e-5b6f-4a28-9c11-0e2f3a4b5c6d'
const encoder = new TextEncoder()

async function signedHeader(
  sign: (input: string) => Promise<string>,
  opts: { body?: string; iat?: number; panel?: string; method?: string; pathname?: string } = {}
): Promise<string> {
  const iat = opts.iat ?? NOW_S
  const input = requestSigningInput({
    method: opts.method ?? 'POST',
    pathname: opts.pathname ?? '/api/daemon/v1/secrets/decrypt',
    panelFingerprint: opts.panel ?? PANEL,
    nonce: NONCE,
    bodySha256: await sha256B64u(encoder.encode(opts.body ?? '{"a":1}')),
    iat,
  })
  return `${KEY_ID}:${NONCE}:${iat}:${await sign(input)}`
}

test('the empty-body hash is SHA-256 of zero bytes', async () => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(0)))
  assertEquals(base64urlEncode(digest), EMPTY_BODY_SHA256_B64U)
  assertEquals(await sha256B64u(new Uint8Array(0)), EMPTY_BODY_SHA256_B64U)
})

test('the signing input is fixed text, method upper-cased', () => {
  assertEquals(
    requestSigningInput({
      method: 'post',
      pathname: '/api/daemon/v1/ping',
      panelFingerprint: PANEL,
      nonce: NONCE,
      bodySha256: EMPTY_BODY_SHA256_B64U,
      iat: 1_800_000_000,
    }),
    `tp-request\nPOST\n/api/daemon/v1/ping\n${PANEL}\n${NONCE}\n${EMPTY_BODY_SHA256_B64U}\n1800000000`
  )
})

test('the header has four parts of fixed form', () => {
  const sig = 's'.repeat(86)
  assertEquals(parseDaemonSignatureHeader(`${KEY_ID}:${NONCE}:123:${sig}`), {
    keyId: KEY_ID,
    nonce: NONCE,
    iat: 123,
    sig,
  })
  assertEquals(parseDaemonSignatureHeader(undefined), null)
  assertEquals(parseDaemonSignatureHeader(`${KEY_ID}:${NONCE}:123`), null)
  assertEquals(parseDaemonSignatureHeader(`${KEY_ID}:short:123:${sig}`), null)
  assertEquals(parseDaemonSignatureHeader(`${KEY_ID}:${NONCE}:x:${sig}`), null)
})

test('the thumbprint is the base64url of the hex fingerprint digest', async () => {
  const { publicJwk } = await testDaemonKey()
  const hex = await computePublicKeyFingerprint(publicJwk)
  const bytes = new Uint8Array(hex.match(/../g)!.map((pair) => Number.parseInt(pair, 16)))
  const jkt = await daemonKeyThumbprint(publicJwk)
  assertEquals(jkt, base64urlEncode(bytes))
  assertEquals(jkt.length, 43)
})

test('a request signed for the current or the next key verifies', async () => {
  const { publicJwk, sign } = await testDaemonKey()
  for (const panel of [PANEL, NEXT]) {
    const result = await verifyDaemonRequest({
      header: await signedHeader(sign, { panel }),
      method: 'POST',
      pathname: '/api/daemon/v1/secrets/decrypt',
      body: encoder.encode('{"a":1}'),
      keyId: KEY_ID,
      publicJwk,
      panelFingerprints: [PANEL, NEXT],
      nowMs: NOW_MS,
    })
    assertEquals(result, { ok: true, value: { nonce: NONCE, iat: NOW_S } })
  }
})

test('a changed body, path, method or key is refused', async () => {
  const { publicJwk, sign } = await testDaemonKey()
  const header = await signedHeader(sign)
  const base = {
    header,
    method: 'POST',
    pathname: '/api/daemon/v1/secrets/decrypt',
    body: encoder.encode('{"a":1}'),
    keyId: KEY_ID,
    publicJwk,
    panelFingerprints: [PANEL],
    nowMs: NOW_MS,
  }
  const cases = [
    { body: encoder.encode('{"a":2}') },
    { pathname: '/api/daemon/v1/tls/issued' },
    { method: 'PUT' },
    { panelFingerprints: [NEXT] },
    { publicJwk: (await testDaemonKey()).publicJwk },
  ]
  for (const change of cases) {
    const result = await verifyDaemonRequest({ ...base, ...change })
    assert(!result.ok)
    assertEquals(result.status, 401)
  }
  const otherKey = await verifyDaemonRequest({ ...base, keyId: 'another-key' })
  assert(!otherKey.ok)
  assertEquals(otherKey.status, 401)
  const missing = await verifyDaemonRequest({ ...base, header: null })
  assert(!missing.ok)
  assertEquals(missing.status, 401)
})

test('a request more than 300 s off is a 400 skew answer', async () => {
  const { publicJwk, sign } = await testDaemonKey()
  const base = {
    method: 'POST',
    pathname: '/api/daemon/v1/secrets/decrypt',
    body: encoder.encode('{"a":1}'),
    keyId: KEY_ID,
    publicJwk,
    panelFingerprints: [PANEL],
    nowMs: NOW_MS,
  }
  const late = await verifyDaemonRequest({
    ...base,
    header: await signedHeader(sign, { iat: NOW_S - 301 }),
  })
  assertEquals(late, { ok: false, status: 400, error: REQUEST_CLOCK_SKEW_ERROR })
  const edge = await verifyDaemonRequest({
    ...base,
    header: await signedHeader(sign, { iat: NOW_S + 300 }),
  })
  assert(edge.ok)
})
