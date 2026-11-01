import { assert, assertEquals } from '@std/assert'
import {
  FIXTURE_NEXT_FINGERPRINT,
  fixtureBindingJson,
} from '../../test-fixtures/panel-identity-fixture.ts'
import {
  buildIdentityDocument,
  IDENTITY_DOCUMENT_RESIGN_AFTER_MS,
  IDENTITY_DOCUMENT_TTL_MS,
  serializeIdentityDocument,
  signIdentityDocument,
  verifyIdentityResponse,
} from './document.ts'
import { createIdentityDocumentCache } from './document-cache.ts'
import { resolvePanelIdentityFromBinding } from './identity.ts'
import { orderedPublicOrigins } from './urls.ts'

const test = Deno.test.bind(Deno)

const NOW = new Date('2026-11-01T12:00:00.000Z')
const URLS = ['https://panel.example.test', 'https://alt.example.test:8443']

async function fixtureIdentity(withNext = false) {
  const identity = await resolvePanelIdentityFromBinding(
    await fixtureBindingJson(withNext ? { next: { kid: FIXTURE_NEXT_FINGERPRINT } } : {})
  )
  assert(identity)
  return identity
}

test('serialized bytes keep the declared key order and a 30 day lifetime', async () => {
  const doc = buildIdentityDocument(await fixtureIdentity(true), URLS, NOW)
  const body = serializeIdentityDocument(doc)
  const parsed = JSON.parse(body)
  assertEquals(Object.keys(parsed), ['v', 'keys', 'seal', 'keyset', 'urls', 'issued', 'expires'])
  assertEquals(Object.keys(parsed.keys[0]), ['kid', 'alg', 'pub', 'role'])
  assertEquals(Date.parse(parsed.expires) - Date.parse(parsed.issued), IDENTITY_DOCUMENT_TTL_MS)
  assertEquals(parsed.urls, URLS)
})

test('next has its fingerprint as kid and an empty pub', async () => {
  const doc = buildIdentityDocument(await fixtureIdentity(true), URLS, NOW)
  assertEquals(doc.keys[1], {
    kid: FIXTURE_NEXT_FINGERPRINT,
    alg: 'Ed25519',
    pub: '',
    role: 'next',
  })
  assertEquals(buildIdentityDocument(await fixtureIdentity(), URLS, NOW).keys.length, 1)
})

test('a signed document verifies, with the signature in the header over the exact body', async () => {
  const identity = await fixtureIdentity()
  const signed = await signIdentityDocument(identity, URLS, NOW)
  assert(signed.signature.startsWith(`${identity.current.kid}:`))
  assertEquals(await verifyIdentityResponse(signed.body, signed.signature), {
    ok: true,
    currentKid: identity.current.kid,
  })
})

test('a changed body or signature, or a different key, does not verify', async () => {
  const identity = await fixtureIdentity()
  const signed = await signIdentityDocument(identity, URLS, NOW)
  const tamperedBody = signed.body.replace('panel.example.test', 'evil.example.test')
  assertEquals((await verifyIdentityResponse(tamperedBody, signed.signature)).ok, false)
  const [kid, sig] = signed.signature.split(':')
  const flipped = `${kid}:${sig![0] === 'A' ? 'B' : 'A'}${sig!.slice(1)}`
  assertEquals((await verifyIdentityResponse(signed.body, flipped)).ok, false)
  assertEquals((await verifyIdentityResponse(signed.body, `${'C'.repeat(43)}:${sig}`)).ok, false)
  assertEquals((await verifyIdentityResponse(signed.body, 'nonsense')).ok, false)
})

test('a lifetime over 30 days is refused', async () => {
  const identity = await fixtureIdentity()
  const doc = buildIdentityDocument(identity, URLS, NOW)
  doc.expires = new Date(NOW.getTime() + IDENTITY_DOCUMENT_TTL_MS + 1000).toISOString()
  const body = serializeIdentityDocument(doc)
  const { signature } = await signIdentityDocument(identity, URLS, NOW)
  assertEquals(await verifyIdentityResponse(body, signature), {
    ok: false,
    reason: 'lifetime is longer than 30 days',
  })
})

test('the cache re-signs after a week, when the urls change, and not otherwise', async () => {
  const identity = await fixtureIdentity()
  let at = NOW
  const cache = createIdentityDocumentCache(() => at)
  const first = await cache.get(identity, URLS)
  at = new Date(NOW.getTime() + 60_000)
  assertEquals(await cache.get(identity, URLS), first)
  const changed = await cache.get(identity, [URLS[0]!])
  assert(changed.body !== first.body)
  at = new Date(NOW.getTime() + IDENTITY_DOCUMENT_RESIGN_AFTER_MS + 120_000)
  const later = await cache.get(identity, [URLS[0]!])
  assert(later.issued !== changed.issued)
})

test('orderedPublicOrigins keeps order, adds https and drops blanks and duplicates', () => {
  assertEquals(
    orderedPublicOrigins([
      { host: 'a.example.test' },
      { host: 'b.example.test:8443' },
      { host: 'a.example.test.' },
      { host: ' ' },
    ]),
    ['https://a.example.test', 'https://b.example.test:8443']
  )
})

test('an independent verifier (node:crypto, SPKI import) accepts the header signature over the raw body', async () => {
  const { createPublicKey, verify } = await import('node:crypto')
  const identity = await fixtureIdentity()
  const signed = await signIdentityDocument(identity, URLS, NOW)
  const spkiPrefix = Uint8Array.from([
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
  ])
  const der = new Uint8Array([...spkiPrefix, ...identity.current.publicRaw])
  const key = createPublicKey({ key: Buffer.from(der), format: 'der', type: 'spki' })
  const sig = Buffer.from(signed.signature.split(':')[1]!, 'base64url')
  const message = Buffer.from(`tp-http\n/api/daemon/v1/instance/identity\n${signed.body}`)
  assert(verify(null, message, key, sig))
})
