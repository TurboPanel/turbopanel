/**
 * Host-free coverage for what an approved key change says afterwards (the
 * audit context and the mail every superadmin gets, rendered from the real
 * context) and for the checks the approve route makes before it verifies.
 */
import { assert, assertEquals, assertRejects } from '@std/assert'
import { base64urlEncode } from '../lib/encoding/base64url.ts'
import { AUDIT_EVENTS, contextFor } from '../features/notifications/audit-bridge.ts'
import { describeEvent } from '../features/notifications/events.ts'
import {
  KEYSET_ENVELOPE_MAX_BYTES,
  KEYSET_REFUSAL_REASONS,
  type KeysetEnvelope,
  type KeysetPin,
  type KeysetStatement,
  keysetStatementChallenge,
  parseKeysetStatement,
  type RotationPasskey,
  serializeKeysetStatement,
  verifyKeysetEnvelope,
} from '../lib/panel-identity/keyset-statement.ts'
import {
  type CustodianMark,
  envelopeOf,
  type MarkedCustodian,
} from '../lib/panel-identity/keyset-store.ts'
import {
  type PanelIdentity,
  PENDING_KEY_MISMATCH,
  STORED_IDENTITY_CHANGED,
} from '../lib/panel-identity/identity.ts'
import { importEd25519Signer } from '../lib/panel-identity/keys.ts'
import {
  createSoftPasskey,
  softAssert,
  softPanelKey,
} from '../test-fixtures/software-authenticator.ts'
import {
  approvalAudit,
  approvalStoreFailure,
  approvalsFromOwnOrigin,
  parseApproveBody,
  refusalWords,
  signApprovedEnvelope,
} from './key-rotation-routes.ts'

const test = Deno.test.bind(Deno)

const OLD_KEY = 'o'.repeat(43)
const NEW_KEY = 'n'.repeat(43)
const key = (id: string): RotationPasskey => ({ id: id.repeat(43), alg: 'EdDSA', pub: 'p' })
const custodian = (id: string, label: string | null): MarkedCustodian => ({
  ...key(id),
  rowId: `row-${id}`,
  passkeyId: `passkey-${id}`,
  rpId: 'cp.example.test',
  label,
})
const mark = (id: string, label: string): CustodianMark => ({
  ...key(id),
  passkeyId: `passkey-${id}`,
  rpId: 'cp.example.test',
  label,
})

const YUBI = custodian('a', 'Security Key (root@example.com)')
const PHONE = custodian('b', 'Phone (root@example.com)')

function statement(kind: KeysetStatement['kind'], passkeys: RotationPasskey[]): KeysetStatement {
  return {
    type: 'tp-keyset',
    v: 1,
    keyset: 7,
    prev: OLD_KEY,
    kind,
    rpId: 'cp.example.test',
    current: { kid: kind === 'passkeys' ? OLD_KEY : NEW_KEY, pub: 'pub' },
    passkeys,
    iat: 1,
  }
}

/** The mail a superadmin gets: the audit entry through the same path `recordKeyEvent` takes. */
function mailFor(facts: Parameters<typeof approvalAudit>[0]) {
  const entry = {
    organizationId: null,
    actorEmail: 'root@example.com',
    targetType: 'instance',
    ...approvalAudit(facts),
  }
  const event = AUDIT_EVENTS[entry.action]
  assert(event)
  const described = describeEvent(event, contextFor(entry, {}))
  return { action: entry.action, event, title: described.title, body: described.body ?? '' }
}

const pin = (custodians: MarkedCustodian[]) => ({
  current: OLD_KEY,
  keyset: 6,
  rpId: 'cp.example.test',
  passkeys: custodians,
  custodians,
})

test('a rotation mail names the key set number, the approving passkey and both keys', () => {
  const mail = mailFor({
    parsed: statement('rotate', [YUBI, PHONE]),
    pin: pin([YUBI, PHONE]),
    marks: [],
    unmark: [],
    state: 'live',
    pinnedApprovals: [PHONE.id],
  })
  assertEquals([mail.action, mail.event], ['panel.key.rotate', 'panel.key_changed'])
  assertEquals(mail.title, 'The control plane key was rotated')
  assertEquals(
    mail.body,
    `root@example.com approved key set 7 with the passkey Phone (root@example.com): the key ${OLD_KEY} was replaced by ${NEW_KEY}. ` +
      'Every server moves to the new key as it sees this change. If you did not expect this, check Control Plane Identity in Admin.'
  )
})

test('a revoke that waits for its key says it has not taken effect yet', () => {
  const mail = mailFor({
    parsed: statement('revoke', [YUBI, PHONE]),
    pin: pin([YUBI, PHONE]),
    marks: [],
    unmark: [],
    state: 'awaiting_key',
    pinnedApprovals: [YUBI.id, PHONE.id],
  })
  assertEquals(mail.action, 'panel.key.revoke')
  assertEquals(mail.title, 'A control plane key change was approved')
  assert(mail.body.includes('approved key set 7 with the passkey Security Key'), mail.body)
  // Both passkeys that approved the revoke are named.
  assert(mail.body.includes('Security Key (root@example.com), Phone (root@example.com)'), mail.body)
  assert(mail.body.includes(`will be replaced by ${NEW_KEY}`), mail.body)
  assert(mail.body.includes('takes effect when the rotation command stores the new key'), mail.body)
})

test('a mark is mailed as a mark and names the passkey and the key set number', () => {
  const tablet = mark('c', 'Tablet (root@example.com)')
  const mail = mailFor({
    parsed: statement('passkeys', [YUBI, PHONE, tablet]),
    pin: pin([YUBI, PHONE]),
    marks: [tablet],
    unmark: [],
    state: 'live',
    pinnedApprovals: [YUBI.id],
  })
  assertEquals([mail.action, mail.event], ['panel.approver.mark', 'panel.approvers_changed'])
  assertEquals(mail.title, 'A passkey now approves control plane key changes')
  assert(
    mail.body.startsWith('root@example.com marked Tablet (root@example.com) (key set 7). '),
    mail.body
  )
  assert(!mail.body.includes('unmarked'), mail.body)
})

test('an unmark is mailed as an unmark, naming the passkey that was removed', () => {
  const mail = mailFor({
    parsed: statement('passkeys', [YUBI]),
    pin: pin([YUBI, PHONE]),
    marks: [],
    unmark: [PHONE.id],
    state: 'live',
    pinnedApprovals: [YUBI.id],
  })
  assertEquals([mail.action, mail.event], ['panel.approver.unmark', 'panel.approvers_changed'])
  assertEquals(mail.title, 'A passkey no longer approves control plane key changes')
  assert(
    mail.body.startsWith('root@example.com unmarked Phone (root@example.com) (key set 7). '),
    mail.body
  )
  assert(!mail.body.includes(' marked '), mail.body)
})

test('a statement that marks and unmarks names both', () => {
  const tablet = mark('c', 'Tablet (root@example.com)')
  const facts = {
    parsed: statement('passkeys', [YUBI, tablet]),
    pin: pin([YUBI, PHONE]),
    marks: [tablet],
    unmark: [PHONE.id],
    state: 'live' as const,
    pinnedApprovals: [YUBI.id],
  }
  assertEquals(approvalAudit(facts).context, {
    kind: 'passkeys',
    keyset: 7,
    oldFingerprint: OLD_KEY,
    newFingerprint: OLD_KEY,
    passkey: 'Security Key (root@example.com)',
    marked: 'Tablet (root@example.com)',
    unmarked: 'Phone (root@example.com)',
    state: 'live',
  })
  const mail = mailFor(facts)
  assertEquals(mail.title, 'The passkeys that approve control plane key changes changed')
  assert(
    mail.body.startsWith(
      'root@example.com marked Tablet (root@example.com) and unmarked Phone (root@example.com) (key set 7). '
    ),
    mail.body
  )
})

test('an unmarked passkey without a stored name still reads as an unmark', () => {
  const nameless = custodian('d', null)
  const mail = mailFor({
    parsed: statement('passkeys', [YUBI]),
    pin: pin([YUBI, nameless]),
    marks: [],
    unmark: [nameless.id],
    state: 'live',
    pinnedApprovals: [YUBI.id],
  })
  assertEquals(mail.action, 'panel.approver.unmark')
  assert(mail.body.startsWith('root@example.com unmarked a passkey (key set 7). '), mail.body)
})

test('every refusal has owner words with no internal terms', () => {
  for (const reason of KEYSET_REFUSAL_REASONS) {
    const words = refusalWords(reason)
    assert(words.length > 0 && words.endsWith('.'), reason)
    assert(!/\b(prev|rpId|kid|keyset|iat|pinned|envelope|base64url)\b/i.test(words), words)
  }
})

const B64 = base64urlEncode(new TextEncoder().encode('{"origin":"https://cp.example.test:8443"}'))
const approval = (over: Record<string, unknown> = {}) => ({
  credentialId: 'AAAA',
  authenticatorData: 'BBBB',
  clientDataJSON: B64,
  signature: 'CCCC',
  ...over,
})

test('the approve body is refused before any hashing when it is malformed or too large', () => {
  assertEquals(
    parseApproveBody({ statement: 'AAAA', approvals: [approval()] })?.approvals.length,
    1
  )
  assertEquals(parseApproveBody(null), null)
  assertEquals(parseApproveBody({ statement: 'AAAA' }), null)
  // Not base64url: padding, other alphabets, empty.
  assertEquals(parseApproveBody({ statement: 'AA==', approvals: [] }), null)
  assertEquals(parseApproveBody({ statement: '', approvals: [] }), null)
  for (const field of ['credentialId', 'authenticatorData', 'clientDataJSON', 'signature']) {
    assertEquals(
      parseApproveBody({ statement: 'AAAA', approvals: [approval({ [field]: 'not base64!' })] }),
      null,
      field
    )
    assertEquals(
      parseApproveBody({ statement: 'AAAA', approvals: [approval({ [field]: 7 })] }),
      null,
      field
    )
  }
  // More approvals than five marked plus five being marked.
  assertEquals(
    parseApproveBody({
      statement: 'AAAA',
      approvals: Array.from({ length: 11 }, () => approval()),
    }),
    null
  )
  // Larger than the envelope servers accept.
  assertEquals(
    parseApproveBody({
      statement: 'AAAA',
      approvals: [approval({ signature: 'A'.repeat(KEYSET_ENVELOPE_MAX_BYTES) })],
    }),
    null
  )
})

test("an approval counts only from this control plane's own address", () => {
  const from = (origin: unknown) => ({
    clientDataJSON: base64urlEncode(new TextEncoder().encode(JSON.stringify({ origin }))),
  })
  const own = ['https://cp.example.test:8443', 'https://cp.example.test']
  assert(approvalsFromOwnOrigin([from(own[0]), from(own[1])], own))
  // Servers would take these (same hostname): the control plane does not.
  assertEquals(approvalsFromOwnOrigin([from('https://cp.example.test:9000')], own), false)
  assertEquals(approvalsFromOwnOrigin([from('https://app.cp.example.test')], own), false)
  assertEquals(approvalsFromOwnOrigin([from(own[0]), from('https://evil.test')], own), false)
  assertEquals(approvalsFromOwnOrigin([from(undefined)], own), false)
  assertEquals(approvalsFromOwnOrigin([{ clientDataJSON: 'AAAA' }], own), false)
  assertEquals(approvalsFromOwnOrigin([{ clientDataJSON: 'not base64!' }], own), false)
  // No configured address: nothing can be approved.
  assertEquals(approvalsFromOwnOrigin([from(own[0])], []), false)
})

test('a store that loses the compare-and-set on the stored key is a 409 start again, not a 500', () => {
  // writeStored's compare-and-set lost a race while the approval was stored.
  assertEquals(approvalStoreFailure(new Error(STORED_IDENTITY_CHANGED)), 'conflict')
  // Another approval took the key set first (unique violation, wrapped as drizzle does).
  const unique = Object.assign(new Error('duplicate key'), { code: '23505' })
  assertEquals(approvalStoreFailure(new Error('query failed', { cause: unique })), 'conflict')
  assertEquals(approvalStoreFailure(new Error(PENDING_KEY_MISMATCH)), 'pending_key_changed')
  // Anything else stays a real fault.
  assertEquals(approvalStoreFailure(new Error('connection reset')), null)
  assertEquals(approvalStoreFailure('not an error'), null)
})

/** A control plane identity with a fresh current key, and a pin of two passkeys on it. */
async function signingSetup() {
  const current = await importEd25519Signer(crypto.getRandomValues(new Uint8Array(32)))
  const identity = { keyset: 4, current, next: null, seal: current } as PanelIdentity
  const [a, b] = [await createSoftPasskey('ES256'), await createSoftPasskey('EdDSA')]
  const rpId = 'cp.example.test'
  const pin: KeysetPin = { current: current.kid, keyset: 4, rpId, passkeys: [a.passkey, b.passkey] }
  const approved = async (kind: 'rotate' | 'revoke' | 'passkeys', prev = current.kid) => {
    const statement: Omit<KeysetStatement, 'type' | 'v'> = {
      keyset: 5,
      prev,
      kind,
      rpId,
      current:
        kind === 'passkeys'
          ? { kid: current.kid, pub: base64urlEncode(current.publicRaw) }
          : await softPanelKey(),
      passkeys: pin.passkeys,
      iat: 1793000000,
    }
    const bytes = new TextEncoder().encode(serializeKeysetStatement(statement))
    const challenge = await keysetStatementChallenge(bytes)
    const envelope: KeysetEnvelope = {
      statement: base64urlEncode(bytes),
      approvals: [
        await softAssert(a, { rpId, challenge }),
        await softAssert(b, { rpId, challenge }),
      ],
    }
    return { envelope, parsed: parseKeysetStatement(bytes)! }
  }
  return { identity, pin, approved }
}

test('the running key signs a rotation and a passkey change, exactly as servers check it', async () => {
  const { identity, pin, approved } = await signingSetup()
  for (const kind of ['rotate', 'passkeys'] as const) {
    const { envelope, parsed } = await approved(kind)
    assertEquals((await verifyKeysetEnvelope(envelope, pin, 1793000000)).ok, false, kind)
    const signed = await signApprovedEnvelope(identity, pin, envelope, parsed, 1793000000)
    assertEquals(signed.keySig?.pub, base64urlEncode(identity.current.publicRaw), kind)
    assert((await verifyKeysetEnvelope(signed, pin, 1793000000)).ok, kind)
  }
})

test('a revoke stays unsigned, and a key that moved since prepare signs nothing', async () => {
  const { identity, pin, approved } = await signingSetup()
  const revoke = await approved('revoke')
  const unsigned = await signApprovedEnvelope(identity, pin, revoke.envelope, revoke.parsed, 1)
  assertEquals(unsigned, revoke.envelope)
  assertEquals(unsigned.keySig, undefined)
  const moved = await approved('rotate', (await softPanelKey()).kid)
  await assertRejects(
    () => signApprovedEnvelope(identity, pin, moved.envelope, moved.parsed, 1793000000),
    Error,
    STORED_IDENTITY_CHANGED
  )
})

test('a stored change hands out its old-key signature only once it is live', () => {
  const row = {
    body: 'ST',
    approvals: '[]',
    prevKey: 'PUB',
    prevKeySignature: 'SIG',
  }
  assertEquals(envelopeOf({ ...row, state: 'live' }).keySig, { pub: 'PUB', sig: 'SIG' })
  assertEquals(envelopeOf({ ...row, state: 'awaiting_key' }).keySig, undefined)
  assertEquals(
    envelopeOf({ ...row, prevKey: null, prevKeySignature: null, state: 'live' }).keySig,
    undefined
  )
})
