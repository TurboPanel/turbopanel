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
    nowMs: NOW_MS,
    ...extra,
  }
}

test('a signed report verifies and is handled without its envelope', async () => {
  const key = await testDaemonKey()
  for (const message of [OUTCOME, PEERS]) {
    const intake = await intakeSignedSessionReport(await signed(key, message), session(key))
    assertEquals(intake, { raw: JSON.stringify(message), warning: null })
  }
})

test('one changed byte fails, and a failed result is recorded as signature_invalid', async () => {
  const key = await testDaemonKey()
  const raw = (await signed(key, OUTCOME)).replace('fabric-key', 'fabric-kez')
  const intake = await intakeSignedSessionReport(raw, session(key))
  assertEquals(intake.warning, 'refused signed command-outcome id=cmd-1: signature invalid')
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
    assertEquals(intake, { raw: null, warning: `refused signed fabric-peers-report: ${reason}` })
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
  })
  assertEquals(await intakeSignedSessionReport(raw, session(key, { daemonSignsReports: false })), {
    raw,
    warning: null,
  })
})

test('frames that are not reports pass as they are', async () => {
  const key = await testDaemonKey()
  const heartbeat = '{"type":"heartbeat","at":"2026-11-05T12:00:00.000Z"}'
  assertEquals(await intakeSignedSessionReport(heartbeat, session(key)), {
    raw: heartbeat,
    warning: null,
  })
  // A result nested in another frame does not make it a report.
  const nested = JSON.stringify({ type: 'heartbeat', note: { type: 'command-outcome' } })
  assertEquals((await intakeSignedSessionReport(nested, session(key))).warning, null)
  const signedHello = appendSignature('{"type":"hello"}', 'abc')
  assertEquals(await intakeSignedSessionReport(signedHello, session(key)), {
    raw: signedHello,
    warning: null,
  })
  const notJson = appendSignature('{not json}', 'abc')
  assertEquals((await intakeSignedSessionReport(notJson, session(key))).raw, notJson)
})

test('the hello feature list says whether the daemon signs reports', () => {
  assertEquals(helloListsSignedReports(['signed-reports-v1']), true)
  assertEquals(helloListsSignedReports(['dev-host-v1']), false)
  assertEquals(helloListsSignedReports(undefined), false)
})
