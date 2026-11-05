import { assertEquals } from '@std/assert'
import { testDaemonKey } from '../../test-fixtures/daemon-signing-key.test.support.ts'
import {
  EMPTY_BODY_SHA256_B64U,
  daemonKeyThumbprint,
  requestSigningInput,
} from './request-signature.ts'
import { panelKeyFingerprints, refuseUnsignedUpgrade } from './upgrade-signature.ts'

const test = Deno.test.bind(Deno)

const NOW_MS = Date.parse('2026-11-05T12:00:00.000Z')
const NOW_S = NOW_MS / 1000
const PANEL = 'P'.repeat(43)
const NONCE = 'BBBBBBBBBBBBBBBBBBBBBB'
const KEY_ID = '7d0a1c3e-5b6f-4a28-9c11-0e2f3a4b5c6d'
const PATH = '/ws/daemon/v1'

async function setup() {
  const key = await testDaemonKey()
  const sig = await key.sign(
    requestSigningInput({
      method: 'GET',
      pathname: PATH,
      panelFingerprint: PANEL,
      nonce: NONCE,
      bodySha256: EMPTY_BODY_SHA256_B64U,
      iat: NOW_S,
    })
  )
  const used = new Set<string>()
  const params = {
    header: `${KEY_ID}:${NONCE}:${NOW_S}:${sig}`,
    cnfJkt: await daemonKeyThumbprint(key.publicJwk),
    trustLevel: 0,
    key: { id: KEY_ID, publicJwk: key.publicJwk },
    pathname: PATH,
    panelFingerprints: () => Promise.resolve([PANEL]),
    markNonceUsed: (nonce: string) => {
      if (used.has(nonce)) return Promise.resolve(false)
      used.add(nonce)
      return Promise.resolve(true)
    },
    nowMs: NOW_MS,
  }
  return { params }
}

test('the fingerprints are the current key, then next when set', () => {
  assertEquals(panelKeyFingerprints({ current: { kid: 'a' }, next: null }), ['a'])
  assertEquals(panelKeyFingerprints({ current: { kid: 'a' }, next: { kid: 'b' } }), ['a', 'b'])
})

test('a bearer token on a server that never proved itself needs no signature', async () => {
  const { params } = await setup()
  assertEquals(
    await refuseUnsignedUpgrade({ ...params, header: null, cnfJkt: undefined, trustLevel: 1 }),
    null
  )
})

test('a key-bound token needs a signed upgrade, used once', async () => {
  const { params } = await setup()
  assertEquals(await refuseUnsignedUpgrade(params), null)
  assertEquals(await refuseUnsignedUpgrade(params), { status: 401, error: 'Request replayed' })
})

test('a proven server needs the signature even with a bearer token', async () => {
  const { params } = await setup()
  const refused = await refuseUnsignedUpgrade({
    ...params,
    header: null,
    cnfJkt: undefined,
    trustLevel: 2,
  })
  assertEquals(refused?.status, 401)
  assertEquals(await refuseUnsignedUpgrade({ ...params, cnfJkt: undefined, trustLevel: 2 }), null)
})

test('a token bound to another key, or no identity loaded, is refused', async () => {
  const { params } = await setup()
  assertEquals(await refuseUnsignedUpgrade({ ...params, cnfJkt: 'x'.repeat(43) }), {
    status: 401,
    error: 'unauthorized',
  })
  assertEquals(
    (await refuseUnsignedUpgrade({ ...params, panelFingerprints: () => Promise.resolve(null) }))
      ?.status,
    503
  )
})
