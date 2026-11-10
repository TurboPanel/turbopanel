import { assertEquals } from '@std/assert'
import { validateDaemonInboundFrame } from '../../contracts/cell-protocol.ts'
import { appendSignature } from '../../lib/panel-identity/frame-envelope.ts'
import {
  testDaemonKey,
  type TestDaemonKey,
} from '../../test-fixtures/daemon-signing-key.test.support.ts'
import {
  helloListsSignedReports,
  intakeSignedSessionReport,
  REPORT_SIGNATURE_INVALID,
  reportSigningInput,
  type ReportSession,
} from './report-signature.ts'

const test = Deno.test.bind(Deno)

const NOW_MS = Date.parse('2026-11-05T12:00:00.000Z')
const NOW_S = NOW_MS / 1000
const KEY_ID = 'key-test'

const OUTCOME = {
  type: 'command-outcome',
  id: 'cmd-1',
  ok: true,
  result: { publicKey: 'fabric-key' },
  at: '2026-11-05T12:00:00.000Z',
}
const PEERS = {
  type: 'fabric-peers-report',
  peers: [],
  observedAt: '2026-11-05T12:00:00.000Z',
  at: '2026-11-05T12:00:00.000Z',
}

/** A report signed the way the daemon does (`turbopaneld/src/instance/report-signing.ts`). */
async function signed(
  key: TestDaemonKey,
  message: { type: string } & Record<string, unknown>,
  envelope: { sessionId?: string; iat?: number; kid?: string } = {}
): Promise<string> {
  const unsigned = JSON.stringify({
    ...message,
    sessionId: envelope.sessionId ?? 's1',
    iat: envelope.iat ?? NOW_S,
    kid: envelope.kid ?? KEY_ID,
  })
  return appendSignature(unsigned, await key.sign(reportSigningInput(message.type, unsigned)))
}

function session(key: TestDaemonKey, extra: Partial<ReportSession> = {}): ReportSession {
  return {
    sessionId: 's1',
    keyId: KEY_ID,
    publicJwk: key.publicJwk,
    daemonSignsReports: true,
    serverSignsReports: false,
    nowMs: NOW_MS,
    ...extra,
  }
}

test('a signed report verifies and is handled without its envelope', async () => {
  const key = await testDaemonKey()
  for (const message of [OUTCOME, PEERS]) {
    const intake = await intakeSignedSessionReport(await signed(key, message), session(key))
    assertEquals(intake, {
      raw: JSON.stringify(message),
      warning: null,
      verdict: 'verified',
      signature: 'verified',
    })
    // The same once the server is known to sign.
    const again = await intakeSignedSessionReport(
      await signed(key, message),
      session(key, { serverSignsReports: true })
    )
    assertEquals(again.verdict, 'verified')
  }
})

test('one changed byte fails, and a failed result is recorded as signature_invalid', async () => {
  const key = await testDaemonKey()
  const raw = (await signed(key, OUTCOME)).replace('fabric-key', 'fabric-kez')
  const intake = await intakeSignedSessionReport(raw, session(key))
  assertEquals(intake.warning, 'refused signed command-outcome id=cmd-1: signature invalid')
  assertEquals(intake.verdict, 'refused')
  const replacement = JSON.parse(intake.raw!)
  assertEquals(replacement, {
    type: 'command-outcome',
    id: 'cmd-1',
    ok: false,
    error: REPORT_SIGNATURE_INVALID,
    at: '2026-11-05T12:00:00.000Z',
  })
  // The replacement passes the usual frame check, so it is stored and acked as today.
  const validated = validateDaemonInboundFrame(intake.raw!)
  assertEquals(validated.ok, true)
})

test('a peer report that does not verify is dropped', async () => {
  const key = await testDaemonKey()
  const other = await testDaemonKey()
  const intake = await intakeSignedSessionReport(await signed(other, PEERS), session(key))
  assertEquals(intake, {
    raw: null,
    warning: 'refused signed fabric-peers-report: signature invalid',
    verdict: 'refused',
    signature: 'invalid',
  })
})

test('another session, another key id, a stale iat or no stored key is refused', async () => {
  const key = await testDaemonKey()
  const cases: Array<[Parameters<typeof signed>[2], Partial<ReportSession>, string]> = [
    [{ sessionId: 's2' }, {}, 'for another session'],
    [{ kid: 'key-other' }, {}, 'signed by another key'],
    [{ iat: NOW_S - 301 }, {}, 'iat out of range'],
    [{ iat: NOW_S + 0.5 }, {}, 'iat out of range'],
    [{}, { publicJwk: undefined }, 'no daemon key'],
  ]
  for (const [envelope, ctx, reason] of cases) {
    const intake = await intakeSignedSessionReport(
      await signed(key, PEERS, envelope),
      session(key, ctx)
    )
    assertEquals(intake, {
      raw: null,
      warning: `refused signed fabric-peers-report: ${reason}`,
      verdict: 'refused',
      signature: 'invalid',
    })
  }
})

test('an unverifiable id is not written to the log', async () => {
  const key = await testDaemonKey()
  const other = await testDaemonKey()
  const raw = await signed(other, { ...OUTCOME, id: 'bad\nid' })
  const intake = await intakeSignedSessionReport(raw, session(key))
  assertEquals(intake.warning, 'refused signed command-outcome: signature invalid')
  const noId = await signed(other, { type: 'command-outcome', ok: true })
  assertEquals((await intakeSignedSessionReport(noId, session(key))).raw, null)
})

test('an unsigned report is still accepted, with a warning only from a daemon that signs', async () => {
  const key = await testDaemonKey()
  const raw = JSON.stringify(OUTCOME)
  assertEquals(await intakeSignedSessionReport(raw, session(key)), {
    raw,
    warning: 'unsigned command-outcome from a daemon that signs reports',
    verdict: 'unsigned',
    signature: 'unsigned',
  })
  assertEquals(await intakeSignedSessionReport(raw, session(key, { daemonSignsReports: false })), {
    raw,
    warning: null,
    verdict: 'unsigned',
    signature: 'unsigned',
  })
})

test('once the server has signed, an unsigned result is refused as signature_invalid', async () => {
  const key = await testDaemonKey()
  const raw = JSON.stringify(OUTCOME)
  // The hello's feature list does not matter: a proxy can strip it.
  for (const daemonSignsReports of [true, false]) {
    const intake = await intakeSignedSessionReport(
      raw,
      session(key, { serverSignsReports: true, daemonSignsReports })
    )
    assertEquals(intake.verdict, 'refused')
    assertEquals(
      intake.warning,
      'refused unsigned command-outcome id=cmd-1: this server signs its reports'
    )
    assertEquals(JSON.parse(intake.raw!), {
      type: 'command-outcome',
      id: 'cmd-1',
      ok: false,
      error: REPORT_SIGNATURE_INVALID,
      at: '2026-11-05T12:00:00.000Z',
    })
    assertEquals(validateDaemonInboundFrame(intake.raw!).ok, true)
  }
})

test('once the server has signed, an unsigned peer report is dropped', async () => {
  const key = await testDaemonKey()
  const intake = await intakeSignedSessionReport(
    JSON.stringify(PEERS),
    session(key, { serverSignsReports: true, daemonSignsReports: false })
  )
  assertEquals(intake, {
    raw: null,
    warning: 'refused unsigned fabric-peers-report: this server signs its reports',
    verdict: 'refused',
    signature: 'unsigned',
  })
})

test('once the server has signed, frames that are not reports still pass', async () => {
  const key = await testDaemonKey()
  const ratcheted = session(key, { serverSignsReports: true })
  const heartbeat = '{"type":"heartbeat","at":"2026-11-05T12:00:00.000Z"}'
  assertEquals(await intakeSignedSessionReport(heartbeat, ratcheted), {
    raw: heartbeat,
    warning: null,
    verdict: 'other',
    signature: 'none',
  })
  const nested = JSON.stringify({ type: 'heartbeat', note: { type: 'command-outcome' } })
  assertEquals((await intakeSignedSessionReport(nested, ratcheted)).raw, nested)
})

test('frames that are not reports pass as they are', async () => {
  const key = await testDaemonKey()
  const heartbeat = '{"type":"heartbeat","at":"2026-11-05T12:00:00.000Z"}'
  assertEquals(await intakeSignedSessionReport(heartbeat, session(key)), {
    raw: heartbeat,
    warning: null,
    verdict: 'other',
    signature: 'none',
  })
  // A result nested in another frame does not make it a report.
  const nested = JSON.stringify({ type: 'heartbeat', note: { type: 'command-outcome' } })
  assertEquals((await intakeSignedSessionReport(nested, session(key))).warning, null)
  const signedHello = appendSignature('{"type":"hello"}', 'abc')
  assertEquals(await intakeSignedSessionReport(signedHello, session(key)), {
    raw: signedHello,
    warning: null,
    verdict: 'other',
    signature: 'none',
  })
  const notJson = appendSignature('{not json}', 'abc')
  assertEquals((await intakeSignedSessionReport(notJson, session(key))).raw, notJson)
})

const HA_EVENT = {
  type: 'managed-ha-event',
  managedId: '00000000-0000-4000-8000-0000000000aa',
  evidence: { spanMs: 20_000 },
  at: '2026-11-05T12:00:00.000Z',
}

test('a signed managed-ha-event is verified and handed on without its envelope', async () => {
  const key = await testDaemonKey()
  const intake = await intakeSignedSessionReport(await signed(key, HA_EVENT), session(key))
  assertEquals(intake, {
    raw: JSON.stringify(HA_EVENT),
    warning: null,
    verdict: 'verified',
    signature: 'verified',
  })
})

test('an unsigned managed-ha-event is handed on marked unsigned, ratchet or not', async () => {
  const key = await testDaemonKey()
  const raw = JSON.stringify(HA_EVENT)
  for (const serverSignsReports of [false, true]) {
    assertEquals(await intakeSignedSessionReport(raw, session(key, { serverSignsReports })), {
      raw,
      warning: null,
      verdict: 'other',
      signature: 'unsigned',
    })
  }
  // Spacing in the type does not hide it: the parsed type decides.
  const spaced = raw.replace('"type":', '"type": ')
  assertEquals((await intakeSignedSessionReport(spaced, session(key))).signature, 'unsigned')
})

test('a managed-ha-event with a bad signature is handed on marked invalid', async () => {
  const key = await testDaemonKey()
  const other = await testDaemonKey()
  const intake = await intakeSignedSessionReport(await signed(other, HA_EVENT), session(key))
  assertEquals(intake, {
    raw: JSON.stringify(HA_EVENT),
    warning: 'refused signed managed-ha-event: signature invalid',
    verdict: 'refused',
    signature: 'invalid',
  })
})

test('the hello feature list says whether the daemon signs reports', () => {
  assertEquals(helloListsSignedReports(['signed-reports-v1']), true)
  assertEquals(helloListsSignedReports(['dev-host-v1']), false)
  assertEquals(helloListsSignedReports(undefined), false)
})

const OUTCOME_TEXT = '"command-outcome"'
const UNSIGNED_VARIANTS: Array<[string, string]> = [
  ['one space after the colon', `{"type": ${OUTCOME_TEXT},"id":"cmd-1","ok":true,"at":"x"}`],
  ['tabs and newlines', `{\n\t"type"\t:\n${OUTCOME_TEXT},"id":"cmd-1","ok":true,"at":"x"}`],
  ['type after other keys', `{"id":"cmd-1","ok":true,"type":${OUTCOME_TEXT},"at":"x"}`],
  [
    'type after other keys, spaced',
    `{ "id" : "cmd-1" , "type" : ${OUTCOME_TEXT} , "ok" : true, "at":"x" }`,
  ],
  [
    'a duplicate type key, last one wins',
    `{"type":"hello","id":"cmd-1","ok":true,"at":"x","type":${OUTCOME_TEXT}}`,
  ],
  [
    'a unicode-escaped type value',
    '{"type":"command\\u002doutcome","id":"cmd-1","ok":true,"at":"x"}',
  ],
  ['a unicode-escaped type key', `{"\\u0074ype":${OUTCOME_TEXT},"id":"cmd-1","ok":true,"at":"x"}`],
]

for (const [name, text] of UNSIGNED_VARIANTS) {
  test(`once the server has signed, an unsigned result with ${name} is refused`, async () => {
    const key = await testDaemonKey()
    const intake = await intakeSignedSessionReport(text, session(key, { serverSignsReports: true }))
    assertEquals(intake.verdict, 'refused')
    assertEquals(JSON.parse(intake.raw ?? 'null').error, REPORT_SIGNATURE_INVALID)
  })
}

test('an unsigned peer report with spaced JSON is refused once the server has signed', async () => {
  const key = await testDaemonKey()
  const intake = await intakeSignedSessionReport(
    '{"peers": [], "type": "fabric-peers-report", "at": "x"}',
    session(key, { serverSignsReports: true })
  )
  assertEquals(intake.verdict, 'refused')
  assertEquals(intake.raw, null)
})

test('a duplicate type key that ends as another type is not a report', async () => {
  const key = await testDaemonKey()
  const text = `{"type":${OUTCOME_TEXT},"id":"cmd-1","type":"hello"}`
  const intake = await intakeSignedSessionReport(text, session(key, { serverSignsReports: true }))
  assertEquals(intake.verdict, 'other')
  assertEquals(intake.raw, text)
})
