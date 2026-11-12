import { assertEquals } from '@std/assert'
import { base64urlEncode } from '../../lib/encoding/base64url.ts'
import { pinPasskeysMatch, pinReportMatches } from '../../features/servers/pin-report.ts'
import { pinPasskeysSigningInput, pinReportSigningInput, verifyPinReport } from './pin-report.ts'

const test = Deno.test.bind(Deno)

const NOW_MS = Date.UTC(2026, 10, 5, 12)
const IAT = Math.floor(NOW_MS / 1000)
const FP_A = 'a'.repeat(43)
const FP_B = 'b'.repeat(43)
const CTX = { sessionId: 'sess-1', serverId: 'srv-1', keyId: 'key-1', nowMs: NOW_MS }

async function daemonKey() {
  const pair = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const sign = async (fields: { pinnedBy: string; current: string; keyset: number; iat: number }) =>
    base64urlEncode(
      new Uint8Array(
        await crypto.subtle.sign(
          'Ed25519',
          pair.privateKey,
          new TextEncoder().encode(pinReportSigningInput({ ...CTX, ...fields }))
        )
      )
    )
  const signPasskeys = async (passkeys: string, iat: number) =>
    base64urlEncode(
      new Uint8Array(
        await crypto.subtle.sign(
          'Ed25519',
          pair.privateKey,
          new TextEncoder().encode(pinPasskeysSigningInput({ ...CTX, passkeys, iat }))
        )
      )
    )
  return { publicJwk, sign, signPasskeys }
}

test('the signing input is the documented bytes (the daemon twin builds the same)', () => {
  assertEquals(
    pinReportSigningInput({
      ...CTX,
      pinnedBy: 'upgrade',
      current: FP_A,
      keyset: 3,
      iat: 1700000000,
    }),
    `tp-panel-pin\nsess-1\nsrv-1\nkey-1\nupgrade\n${FP_A}\n3\n1700000000`
  )
})

test('a pin report signed by the daemon key verifies and says what the server pinned', async () => {
  const key = await daemonKey()
  const fields = { pinnedBy: 'upgrade', current: FP_A, keyset: 3, iat: IAT }
  const report = await verifyPinReport(
    { ...fields, sig: await key.sign(fields) },
    { ...CTX, publicJwk: key.publicJwk }
  )
  assertEquals(report, { pinnedBy: 'upgrade', current: FP_A, keyset: 3 })
})

test('an unsafe pin with no key verifies with an empty current', async () => {
  const key = await daemonKey()
  const fields = { pinnedBy: 'unsafe', current: '', keyset: 0, iat: IAT }
  const report = await verifyPinReport(
    { ...fields, sig: await key.sign(fields) },
    { ...CTX, publicJwk: key.publicJwk }
  )
  assertEquals(report, { pinnedBy: 'unsafe', current: '', keyset: 0 })
})

test('a tampered, stale, unsigned or foreign pin report is ignored', async () => {
  const key = await daemonKey()
  const other = await daemonKey()
  const fields = { pinnedBy: 'install', current: FP_A, keyset: 1, iat: IAT }
  const sig = await key.sign(fields)
  const ctx = { ...CTX, publicJwk: key.publicJwk }
  const cases: Array<[string, unknown, typeof ctx]> = [
    ['another fingerprint', { ...fields, current: FP_B, sig }, ctx],
    ['another key set', { ...fields, keyset: 2, sig }, ctx],
    ['no signature (an older daemon)', { ...fields }, ctx],
    ['another daemon key', { ...fields, sig }, { ...ctx, publicJwk: other.publicJwk }],
    ['another session', { ...fields, sig }, { ...ctx, sessionId: 'sess-2' }],
    ['another server', { ...fields, sig }, { ...ctx, serverId: 'srv-2' }],
    ['stale', { ...fields, sig }, { ...ctx, nowMs: NOW_MS + 600_000 }],
    ['unsafe with a key', { ...fields, pinnedBy: 'unsafe', sig }, ctx],
    ['a short fingerprint', { ...fields, current: 'abc', sig }, ctx],
    ['not an object', 'x', ctx],
  ]
  for (const [label, panelPin, context] of cases) {
    assertEquals(await verifyPinReport(panelPin, context), null, label)
  }
  assertEquals(await verifyPinReport({ ...fields, sig }, { ...ctx, keyId: undefined }), null)
})

test('a pin matches the control plane current or next key, never an empty one', () => {
  const report = { pinnedBy: 'install' as const, current: FP_A, keyset: 1 }
  assertEquals(pinReportMatches(report, { current: FP_A }), true)
  assertEquals(pinReportMatches(report, { current: FP_B, next: FP_A }), true)
  assertEquals(pinReportMatches(report, { current: FP_B, next: null }), false)
  assertEquals(
    pinReportMatches({ pinnedBy: 'unsafe', current: '', keyset: 0 }, { current: FP_B, next: '' }),
    false
  )
})

test('the passkeys report has its own signature, documented bytes and match rule', async () => {
  assertEquals(
    pinPasskeysSigningInput({ ...CTX, passkeys: FP_B, iat: 1700000000 }),
    `tp-panel-pin-passkeys\nsess-1\nsrv-1\nkey-1\n${FP_B}\n1700000000`
  )
  const key = await daemonKey()
  const fields = { pinnedBy: 'upgrade', current: FP_A, keyset: 3, iat: IAT }
  const sig = await key.sign(fields)
  const ctx = { ...CTX, publicJwk: key.publicJwk }
  const good = await verifyPinReport(
    { ...fields, sig, passkeys: FP_B, passkeysSig: await key.signPasskeys(FP_B, IAT) },
    ctx
  )
  assertEquals(good, { pinnedBy: 'upgrade', current: FP_A, keyset: 3, passkeys: FP_B })
  // A forged passkeys part is dropped; the key report still stands.
  const forged = await verifyPinReport(
    { ...fields, sig, passkeys: FP_A, passkeysSig: await key.signPasskeys(FP_B, IAT) },
    ctx
  )
  assertEquals(forged, { pinnedBy: 'upgrade', current: FP_A, keyset: 3 })
  assertEquals(pinPasskeysMatch({ ...good!, passkeys: '' }, { current: FP_A }), true)
  assertEquals(pinPasskeysMatch(good!, { current: FP_A, passkeys: FP_B }), true)
  assertEquals(pinPasskeysMatch(good!, { current: FP_A, passkeys: null }), false)
  assertEquals(pinPasskeysMatch(good!, { current: FP_A, passkeys: FP_A }), false)
})
