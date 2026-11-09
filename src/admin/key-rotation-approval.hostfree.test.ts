/**
 * Host-free coverage for what an approved key change says afterwards (the
 * audit context and the mail every superadmin gets, rendered from the real
 * context) and for the checks the approve route makes before it verifies.
 */
import { assert, assertEquals } from '@std/assert'
import { base64urlEncode } from '../lib/encoding/base64url.ts'
import { AUDIT_EVENTS, contextFor } from '../features/notifications/audit-bridge.ts'
import { describeEvent } from '../features/notifications/events.ts'
import {
  KEYSET_ENVELOPE_MAX_BYTES,
  KEYSET_REFUSAL_REASONS,
  type KeysetStatement,
  type RotationPasskey,
} from '../lib/panel-identity/keyset-statement.ts'
import type { CustodianMark, MarkedCustodian } from '../lib/panel-identity/keyset-store.ts'
import {
  approvalAudit,
  approvalsFromOwnOrigin,
  parseApproveBody,
  refusalWords,
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
    pinnedApprovals: [YUBI.id],
  })
  assertEquals(mail.action, 'panel.key.revoke')
  assertEquals(mail.title, 'A control plane key change was approved')
  assert(mail.body.includes('approved key set 7 with the passkey Security Key'), mail.body)
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
