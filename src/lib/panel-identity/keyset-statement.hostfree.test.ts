import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import { base64urlEncode } from '../encoding/base64url.ts'
import {
  derEcdsaToRaw,
  KEYSET_ENVELOPE_MAX_BYTES,
  type KeysetEnvelope,
  type KeysetPin,
  keysetStatementChallenge,
  parseKeysetEnvelope,
  parseKeysetStatement,
  pinAfter,
  rotationPasskeysHash,
  rotationPasskeysLine,
  serializeKeysetStatement,
  verifyKeysetEnvelope,
} from './keyset-statement.ts'
import {
  createSoftPasskey,
  rawEcdsaToDer,
  softAssert,
  softPanelKey,
  vectorEnvelope,
} from '../../test-fixtures/software-authenticator.ts'
import vectors from '../../test-fixtures/keyset-statement-vectors.json' with { type: 'json' }

const test = Deno.test.bind(Deno)
const encoder = new TextEncoder()
const NOW = vectors.now
/** The JSON escape for the letter p, built so no tool rewrites it. */
const ESCAPED_P = `${String.fromCodePoint(92)}u0070`

test('the shared vectors: every forged envelope is refused', async () => {
  for (const vector of vectors.refused) {
    const envelope = parseKeysetEnvelope(vectorEnvelope(vector.envelope))
    assert(envelope, vector.name)
    const result = await verifyKeysetEnvelope(envelope, vector.pin as KeysetPin, NOW)
    assertEquals<unknown>(result, { ok: false, reason: vector.reason }, vector.name)
  }
})

test('the shared vectors: an offline server applies the whole chain in order', async () => {
  let pin = vectors.pin as KeysetPin
  for (const raw of vectors.chain) {
    const envelope = parseKeysetEnvelope(vectorEnvelope(raw))
    assert(envelope)
    const result = await verifyKeysetEnvelope(envelope, pin, NOW)
    assert(result.ok, result.ok ? '' : result.reason)
    pin = pinAfter(result.statement)
  }
  assertEquals(pin, vectors.pinAfterChain)
  // Applying the first statement again after the chain is refused.
  const replay = await verifyKeysetEnvelope(
    parseKeysetEnvelope(vectorEnvelope(vectors.chain[0]!))!,
    pin,
    NOW
  )
  assertEquals(replay.ok, false)
})

test('a rotation approved by one pinned passkey verifies (ES256 and EdDSA)', async () => {
  for (const alg of ['ES256', 'EdDSA'] as const) {
    const approver = await createSoftPasskey(alg)
    const other = await createSoftPasskey('ES256')
    const [k1, k2] = [await softPanelKey(), await softPanelKey()]
    const pin: KeysetPin = {
      current: k1.kid,
      keyset: 1,
      rpId: 'cp.example.test',
      passkeys: [approver.passkey, other.passkey],
    }
    const bytes = encoder.encode(
      serializeKeysetStatement({
        keyset: 2,
        prev: k1.kid,
        kind: 'rotate',
        rpId: 'cp.example.test',
        current: k2,
        passkeys: pin.passkeys,
        iat: NOW,
      })
    )
    const challenge = await keysetStatementChallenge(bytes)
    const envelope: KeysetEnvelope = {
      statement: base64urlEncode(bytes),
      approvals: [
        await softAssert(approver, {
          rpId: 'cp.example.test',
          challenge,
          origin: 'https://admin.cp.example.test:8443',
        }),
      ],
    }
    const result = await verifyKeysetEnvelope(envelope, pin, NOW)
    assert(result.ok, result.ok ? '' : result.reason)
    assertEquals(result.pinnedApprovals, [approver.passkey.id])
  }
})

test('genesis: the first marks need a proof of possession from each passkey', async () => {
  const [a, b] = [await createSoftPasskey('ES256'), await createSoftPasskey('EdDSA')]
  const k1 = await softPanelKey()
  const pin: KeysetPin = { current: k1.kid, keyset: 1, rpId: 'cp.example.test', passkeys: [] }
  const bytes = encoder.encode(
    serializeKeysetStatement({
      keyset: 2,
      prev: k1.kid,
      kind: 'passkeys',
      rpId: 'cp.example.test',
      current: k1,
      passkeys: [a.passkey, b.passkey],
      iat: NOW,
    })
  )
  const challenge = await keysetStatementChallenge(bytes)
  const only = {
    statement: base64urlEncode(bytes),
    approvals: [await softAssert(a, { rpId: 'cp.example.test', challenge })],
  }
  assertEquals((await verifyKeysetEnvelope(only, pin, NOW)).ok, false)
  only.approvals.push(await softAssert(b, { rpId: 'cp.example.test', challenge }))
  assert((await verifyKeysetEnvelope(only, pin, NOW)).ok)
  // A genesis pin can never rotate the key.
  const rotate = encoder.encode(
    serializeKeysetStatement({
      keyset: 2,
      prev: k1.kid,
      kind: 'rotate',
      rpId: 'cp.example.test',
      current: await softPanelKey(),
      passkeys: [a.passkey],
      iat: NOW,
    })
  )
  const rotateChallenge = await keysetStatementChallenge(rotate)
  const refused = await verifyKeysetEnvelope(
    {
      statement: base64urlEncode(rotate),
      approvals: [await softAssert(a, { rpId: 'cp.example.test', challenge: rotateChallenge })],
    },
    pin,
    NOW
  )
  assertEquals(refused, { ok: false, reason: 'no rotation passkey is pinned' })
})

test('an rpId move needs an old-set approval and possession under the new id', async () => {
  const [old, fresh] = [await createSoftPasskey('ES256'), await createSoftPasskey('ES256')]
  const k1 = await softPanelKey()
  const pin: KeysetPin = {
    current: k1.kid,
    keyset: 3,
    rpId: 'old.example.test',
    passkeys: [old.passkey],
  }
  const bytes = encoder.encode(
    serializeKeysetStatement({
      keyset: 4,
      prev: k1.kid,
      kind: 'passkeys',
      rpId: 'new.example.test',
      current: k1,
      passkeys: [fresh.passkey],
      iat: NOW,
    })
  )
  const challenge = await keysetStatementChallenge(bytes)
  const oldApproval = await softAssert(old, { rpId: 'old.example.test', challenge })
  const freshProof = await softAssert(fresh, { rpId: 'new.example.test', challenge })
  const statement = base64urlEncode(bytes)
  assert(
    (await verifyKeysetEnvelope({ statement, approvals: [oldApproval, freshProof] }, pin, NOW)).ok
  )
  assertEquals(
    (await verifyKeysetEnvelope({ statement, approvals: [freshProof] }, pin, NOW)).ok,
    false
  )
  assertEquals(
    (await verifyKeysetEnvelope({ statement, approvals: [oldApproval] }, pin, NOW)).ok,
    false
  )
})

test('statement parsing is strict about members, order and passkey shapes', async () => {
  const k = await softPanelKey()
  const a = await createSoftPasskey('ES256')
  const good = serializeKeysetStatement({
    keyset: 2,
    prev: k.kid,
    kind: 'rotate',
    rpId: 'cp.example.test',
    current: k,
    passkeys: [a.passkey],
    iat: 1,
  })
  assert(parseKeysetStatement(encoder.encode(good)))
  assertEquals(parseKeysetStatement(encoder.encode(good.replace('"v":1,', ''))), null)
  assertEquals(parseKeysetStatement(encoder.encode(good.replace('"iat":1', '"iat":1,"x":2'))), null)
  assertEquals(parseKeysetStatement(encoder.encode(good.replace('"ES256"', '"RS256"'))), null)
  assertEquals(
    parseKeysetStatement(encoder.encode(good.replace('cp.example.test', 'CP.example'))),
    null
  )
  assertEquals(
    parseKeysetStatement(encoder.encode(good.replace('"passkeys":[', '"passkeys":[],"_":['))),
    null
  )
})

test('an envelope over 16 KiB is refused', () => {
  const big = { statement: 'A'.repeat(KEYSET_ENVELOPE_MAX_BYTES), approvals: [] }
  assertEquals(parseKeysetEnvelope(big), null)
  assertEquals(parseKeysetEnvelope({ statement: 'AA', approvals: [] })?.statement, 'AA')
})

test('DER to raw is strict and round-trips', () => {
  const raw = crypto.getRandomValues(new Uint8Array(64))
  raw[0] = 0x80
  raw[32] = 0x01
  assertEquals(derEcdsaToRaw(rawEcdsaToDer(raw)), raw)
  assertEquals(derEcdsaToRaw(raw), null)
  const der = rawEcdsaToDer(raw)
  assertEquals(derEcdsaToRaw(Uint8Array.of(...der, 0)), null)
})

test('the passkey line and its hash are order independent', async () => {
  const [a, b] = [await createSoftPasskey('ES256'), await createSoftPasskey('EdDSA')]
  assertEquals(
    rotationPasskeysLine([a.passkey, b.passkey]),
    rotationPasskeysLine([b.passkey, a.passkey])
  )
  assertStringIncludes(rotationPasskeysLine([b.passkey]), '.eddsa.')
  assertEquals(
    await rotationPasskeysHash([a.passkey, b.passkey]),
    await rotationPasskeysHash([b.passkey, a.passkey])
  )
})

test('only the exact statement bytes verify: other forms of the same JSON are refused', async () => {
  const [a, b] = [await createSoftPasskey('ES256'), await createSoftPasskey('EdDSA')]
  const k1 = await softPanelKey()
  const rpId = 'cp.example.test'
  const pin: KeysetPin = { current: k1.kid, keyset: 1, rpId, passkeys: [] }
  const text = serializeKeysetStatement({
    keyset: 2,
    prev: k1.kid,
    kind: 'passkeys',
    rpId,
    current: k1,
    passkeys: [a.passkey, b.passkey],
    iat: NOW,
  })
  // Each approval signs the bytes it is sent with, so only the form is wrong.
  const verify = async (bytes: Uint8Array) => {
    const challenge = await keysetStatementChallenge(bytes)
    return await verifyKeysetEnvelope(
      {
        statement: base64urlEncode(bytes),
        approvals: [
          await softAssert(a, { rpId, challenge }),
          await softAssert(b, { rpId, challenge }),
        ],
      },
      pin,
      NOW
    )
  }
  assert((await verify(encoder.encode(text))).ok)

  const first = [a.passkey, b.passkey].sort((x, y) => (x.id < y.id ? -1 : 1))[0]!
  const member = `{"id":"${first.id}","alg":"${first.alg}","pub":"${first.pub}"}`
  const reordered = `{"alg":"${first.alg}","id":"${first.id}","pub":"${first.pub}"}`
  assertStringIncludes(text, member)
  const withMark = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode(text)])
  const variants: [string, Uint8Array][] = [
    ['a decimal key set', encoder.encode(text.replace('"keyset":2,', '"keyset":2.0,'))],
    ['an exponent key set', encoder.encode(text.replace('"keyset":2,', '"keyset":2e0,'))],
    ['passkey members in another order', encoder.encode(text.replace(member, reordered))],
    ['a leading byte order mark', withMark],
    ['a trailing newline', encoder.encode(`${text}\n`)],
    ['a space after a colon', encoder.encode(text.replace('"v":1', '"v": 1'))],
    [
      'an escaped letter',
      encoder.encode(text.replace('"kind":"passkeys"', `"kind":"${ESCAPED_P}asskeys"`)),
    ],
    ['a repeated member', encoder.encode(text.replace('{"type":', '{"type":"x","type":'))],
  ]
  for (const [name, bytes] of variants) {
    // Parsing alone takes these: the exact-bytes rule is what refuses them.
    assert(parseKeysetStatement(bytes) !== null, name)
    assertEquals(await verify(bytes), { ok: false, reason: 'statement is malformed' }, name)
  }
})

test('a statement in base64url with stray trailing bits is refused', async () => {
  const a = await createSoftPasskey('ES256')
  const k1 = await softPanelKey()
  const rpId = 'cp.example.test'
  const bytes = encoder.encode(
    serializeKeysetStatement({
      keyset: 2,
      prev: k1.kid,
      kind: 'passkeys',
      rpId,
      current: k1,
      passkeys: [a.passkey],
      iat: NOW,
    })
  )
  const challenge = await keysetStatementChallenge(bytes)
  const approvals = [await softAssert(a, { rpId, challenge })]
  const pin: KeysetPin = { current: k1.kid, keyset: 1, rpId, passkeys: [] }
  const canonical = base64urlEncode(bytes)
  assert((await verifyKeysetEnvelope({ statement: canonical, approvals }, pin, NOW)).ok)
  // Find a spelling that decodes to the same bytes but is not the one an encoder writes.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const last = alphabet.indexOf(canonical.at(-1)!)
  const padBits = canonical.length % 4 === 2 ? 4 : canonical.length % 4 === 3 ? 2 : 0
  if (padBits === 0) return
  const stray = canonical.slice(0, -1) + alphabet[last + 1]!
  assertEquals(await verifyKeysetEnvelope({ statement: stray, approvals }, pin, NOW), {
    ok: false,
    reason: 'statement is not base64url',
  })
})
