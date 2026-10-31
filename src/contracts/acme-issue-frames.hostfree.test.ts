/**
 * Shapes of the `acme-issue-v1` messages. Only the three a daemon sends are
 * accepted inbound, and no message may carry the certificate or its key.
 */

import { assert, assertEquals } from '@std/assert'
import {
  DAEMON_INBOUND_ALLOWED,
  MAX_ACME_ISSUE_NAMES,
  outboundEnvelopeToWireMessage,
  validateAcmeIssueEventFields,
  validateAcmeIssueRequestFields,
  validateAcmeProofForwardEndFields,
  validateAcmeProofForwardFields,
  validateAcmeProofForwardReportFields,
  validateDaemonInboundFrame,
} from './cell-protocol.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const AT = '2026-11-01T12:00:00.000Z'

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 'req_0123-abc',
    tlsId: '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b',
    names: ['example.com', 'www.example.com'],
    directory: 'staging',
    contactEmail: 'ops@example.com',
    startByIso: '2026-11-01T12:30:00.000Z',
    helpers: [
      { serverId: 'server-b', address: '203.0.113.7' },
      { serverId: 'server-c', address: '2001:db8::1' },
    ],
    at: AT,
    ...overrides,
  }
}

test('only the three daemon-to-panel messages are accepted from daemons', () => {
  const allowed: ReadonlySet<string> = DAEMON_INBOUND_ALLOWED
  for (const type of [
    'acme-issue-event',
    'acme-proof-forward-ready',
    'acme-proof-forward-failed',
  ]) {
    assert(allowed.has(type), type)
  }
  for (const type of ['acme-issue-request', 'acme-proof-forward', 'acme-proof-forward-end']) {
    assert(!allowed.has(type), type)
  }
})

test('acme-issue-request parses and refuses bad names, ids, directories and helpers', () => {
  assertEquals(validateAcmeIssueRequestFields(request()), null)
  assertEquals(validateAcmeIssueRequestFields(request({ helpers: [] })), null)
  const bad: Array<Record<string, unknown>> = [
    { names: [] },
    { names: ['Example.com'] },
    { names: ['*.example.com'] },
    { names: ['exa mple.com'] },
    { names: ['example.com.'] },
    { names: Array.from({ length: MAX_ACME_ISSUE_NAMES + 1 }, (_, i) => `h${i}.example.com`) },
    { requestId: 'has space' },
    { requestId: '' },
    { directory: 'other' },
    { contactEmail: '' },
    { startByIso: 'tomorrow' },
    { helpers: [{ serverId: 'b', address: 'not an address' }] },
    { helpers: Array.from({ length: 65 }, () => ({ serverId: 'b', address: '203.0.113.7' })) },
    { privateKeyPem: 'x' },
    { certificatePem: 'x' },
  ]
  for (const override of bad) {
    assert(validateAcmeIssueRequestFields(request(override)) !== null, JSON.stringify(override))
  }
})

test('unknown optional fields are ignored', () => {
  assertEquals(validateAcmeIssueRequestFields(request({ somethingNew: { a: 1 } })), null)
})

test('acme-proof-forward and its end parse and refuse bad input', () => {
  const forward = {
    requestId: 'req_1',
    names: ['example.com'],
    targetAddress: '203.0.113.7',
    expiresAtIso: '2026-11-01T12:30:00.000Z',
    at: AT,
  }
  assertEquals(validateAcmeProofForwardFields(forward), null)
  assert(validateAcmeProofForwardFields({ ...forward, targetAddress: 'a b' }) !== null)
  assert(validateAcmeProofForwardFields({ ...forward, names: ['Bad.Example.com'] }) !== null)
  assert(validateAcmeProofForwardFields({ ...forward, expiresAtIso: 'x' }) !== null)
  assertEquals(validateAcmeProofForwardEndFields({ requestId: 'req_1', at: AT }), null)
  assert(validateAcmeProofForwardEndFields({ requestId: '', at: AT }) !== null)
})

test('acme-issue-event parses every stage and never accepts the certificate or its key', () => {
  const event = {
    requestId: 'req_1',
    stage: 'issued',
    notAfterIso: '2027-01-01T00:00:00.000Z',
    at: AT,
  }
  assertEquals(validateAcmeIssueEventFields(event), null)
  assertEquals(
    validateAcmeIssueEventFields({ ...event, stage: 'started', notAfterIso: undefined }),
    null
  )
  assertEquals(
    validateAcmeIssueEventFields({ ...event, stage: 'failed', reason: 'Port 80 is busy.' }),
    null
  )
  assert(validateAcmeIssueEventFields({ ...event, stage: 'done' }) !== null)
  assert(validateAcmeIssueEventFields({ ...event, notAfterIso: 'x' }) !== null)
  assert(validateAcmeIssueEventFields({ ...event, reason: 'x'.repeat(5000) }) !== null)
  for (const key of ['certificatePem', 'privateKeyPem', 'privateKey']) {
    assert(validateAcmeIssueEventFields({ ...event, [key]: 'x' }) !== null, key)
  }
})

test('acme-proof-forward-ready and -failed parse with an optional reason', () => {
  assertEquals(validateAcmeProofForwardReportFields({ requestId: 'req_1', at: AT }), null)
  assertEquals(
    validateAcmeProofForwardReportFields({ requestId: 'req_1', reason: 'Reload failed.', at: AT }),
    null
  )
  assert(validateAcmeProofForwardReportFields({ requestId: 'req_1', reason: 7, at: AT }) !== null)
  assert(
    validateAcmeProofForwardReportFields({ requestId: 'req_1', privateKeyPem: 'x', at: AT }) !==
      null
  )
})

test('address literals must be real IPv4 or IPv6 addresses', () => {
  const good = [
    '203.0.113.7',
    '2001:db8::1',
    '::1',
    'fe80::1',
    '2001:db8:0:0:0:0:0:1',
    '::ffff:203.0.113.7',
  ]
  for (const address of good) {
    assertEquals(
      validateAcmeProofForwardFields({
        requestId: 'req_1',
        names: ['example.com'],
        targetAddress: address,
        expiresAtIso: AT,
        at: AT,
      }),
      null,
      address
    )
  }
  const bad = [
    '::::',
    ':::',
    '1:2:3:4:5:6:7:8:9',
    '1::2::3',
    '256.1.1.1',
    '1.2.3',
    '01.2.3.4',
    'abcd',
    'g::1',
    '1:2:3:4:5:6:7::8',
    '::.',
    '....',
    '12345::1',
  ]
  for (const address of bad) {
    assert(
      validateAcmeProofForwardFields({
        requestId: 'req_1',
        names: ['example.com'],
        targetAddress: address,
        expiresAtIso: AT,
        at: AT,
      }) !== null,
      address
    )
  }
})

test('proof-forward-end and each helper entry refuse certificate material keys', () => {
  assertEquals(validateAcmeProofForwardEndFields({ requestId: 'req_1', at: AT }), null)
  assert(
    validateAcmeProofForwardEndFields({ requestId: 'req_1', at: AT, privateKey: 'x' }) !== null
  )
  assert(validateAcmeProofForwardEndFields({ requestId: 'req_1', at: AT, pem: 'x' }) !== null)
  const withKey = request({
    helpers: [{ serverId: 'b', address: '203.0.113.7', privateKeyPem: 'x' }],
  })
  assert(validateAcmeIssueRequestFields(withKey) !== null)
})

test('the three daemon messages pass the inbound frame check and nothing else of the set does', () => {
  const frame = (record: Record<string, unknown>) =>
    validateDaemonInboundFrame(JSON.stringify(record))
  assertEquals(
    frame({ type: 'acme-issue-event', requestId: 'req_1', stage: 'started', at: AT }).ok,
    true
  )
  assertEquals(frame({ type: 'acme-proof-forward-ready', requestId: 'req_1', at: AT }).ok, true)
  assertEquals(
    frame({ type: 'acme-proof-forward-failed', requestId: 'req_1', reason: 'no', at: AT }).ok,
    true
  )
  assert(
    frame({
      type: 'acme-issue-event',
      requestId: 'req_1',
      stage: 'issued',
      privateKey: 'x',
      at: AT,
    }).ok === false
  )
  assert(frame({ type: 'acme-issue-request', requestId: 'req_1', at: AT }).ok === false)
})

test('outbound envelopes become the wire messages with the order id as requestId', () => {
  const base = { deliveryId: 'd1', requestId: 'cell-correlation', at: AT }
  const order = outboundEnvelopeToWireMessage({
    ...base,
    kind: 'acme-issue-request',
    acmeRequestId: 'req_1',
    tlsId: '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b',
    names: ['example.com'],
    directory: 'production',
    contactEmail: 'ops@example.com',
    startByIso: AT,
    helpers: [{ serverId: 'b', address: '203.0.113.7' }],
  }) as unknown as Record<string, unknown>
  assertEquals(order.type, 'acme-issue-request')
  assertEquals(order.requestId, 'req_1')
  assertEquals(validateAcmeIssueRequestFields(order), null)
  const forward = outboundEnvelopeToWireMessage({
    ...base,
    kind: 'acme-proof-forward',
    acmeRequestId: 'req_1',
    names: ['example.com'],
    targetAddress: '203.0.113.1',
    expiresAtIso: AT,
  }) as unknown as Record<string, unknown>
  assertEquals(forward.requestId, 'req_1')
  assertEquals(validateAcmeProofForwardFields(forward), null)
  const end = outboundEnvelopeToWireMessage({
    ...base,
    kind: 'acme-proof-forward-end',
    acmeRequestId: 'req_1',
  }) as unknown as Record<string, unknown>
  assertEquals(end, { type: 'acme-proof-forward-end', requestId: 'req_1', at: AT })
})
