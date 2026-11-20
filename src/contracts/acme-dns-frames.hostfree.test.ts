/**
 * Shapes of the `acme-issue-dns-v1` messages: the daemon asks the panel to
 * publish and remove challenge records, the panel answers once. Only the two
 * requests are accepted inbound, names are bounded, and no message may carry
 * certificate material.
 */
import { assert, assertEquals } from '@std/assert'
import {
  DAEMON_INBOUND_ALLOWED,
  MAX_ACME_DNS_RECORDS,
  validateAcmeDnsPublishedFields,
  validateAcmeDnsPublishFields,
  validateAcmeDnsRemoveFields,
  validateAcmeIssueRequestFields,
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
const record = { name: '_acme-challenge.example.com', value: 'abc_DEF-123' }

const publish = (over: Record<string, unknown> = {}) => ({
  requestId: 'req_0123-abc',
  records: [record],
  at: AT,
  ...over,
})

test('only publish and remove are accepted from a daemon; the answer is not', () => {
  const allowed: ReadonlySet<string> = DAEMON_INBOUND_ALLOWED
  assert(allowed.has('acme-dns-publish'))
  assert(allowed.has('acme-dns-remove'))
  assert(!allowed.has('acme-dns-published'))
})

test('acme-dns-publish parses and refuses bad names, values, counts and key material', () => {
  assertEquals(validateAcmeDnsPublishFields(publish()), null)
  assert(validateAcmeDnsPublishFields(publish({ records: [] })) !== null)
  assert(
    validateAcmeDnsPublishFields(publish({ records: [{ ...record, name: 'example.com' }] })) !==
      null
  )
  assert(validateAcmeDnsPublishFields(publish({ records: [{ ...record, value: 'a b' }] })) !== null)
  assert(
    validateAcmeDnsPublishFields(publish({ records: [{ ...record, value: 'x'.repeat(129) }] })) !==
      null
  )
  const many = Array.from({ length: MAX_ACME_DNS_RECORDS + 1 }, () => record)
  assert(validateAcmeDnsPublishFields(publish({ records: many })) !== null)
  assert(validateAcmeDnsPublishFields(publish({ requestId: 'bad id' })) !== null)
  assert(validateAcmeDnsPublishFields(publish({ privateKey: 'x' })) !== null)
})

test('acme-dns-remove and acme-dns-published parse', () => {
  assertEquals(validateAcmeDnsRemoveFields({ requestId: 'req_1', at: AT }), null)
  assert(validateAcmeDnsRemoveFields({ requestId: '', at: AT }) !== null)
  assertEquals(validateAcmeDnsPublishedFields({ requestId: 'req_1', ok: true, at: AT }), null)
  assertEquals(
    validateAcmeDnsPublishedFields({ requestId: 'req_1', ok: false, error: 'No zone.', at: AT }),
    null
  )
  assert(validateAcmeDnsPublishedFields({ requestId: 'req_1', ok: 'yes', at: AT }) !== null)
})

test('the inbound frame validator takes the two requests and rejects an unbounded one', () => {
  const ok = validateDaemonInboundFrame(JSON.stringify({ type: 'acme-dns-publish', ...publish() }))
  assert(ok.ok)
  const remove = validateDaemonInboundFrame(
    JSON.stringify({ type: 'acme-dns-remove', requestId: 'req_1', at: AT })
  )
  assert(remove.ok)
  const bad = validateDaemonInboundFrame(
    JSON.stringify({ type: 'acme-dns-publish', ...publish({ records: [] }) })
  )
  assert(!bad.ok)
})

test('acme-issue-request carries a challenge, and a wildcard only over dns-01', () => {
  const request = (over: Record<string, unknown>) => ({
    requestId: 'req_0123-abc',
    tlsId: '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b',
    names: ['example.com', '*.example.com'],
    directory: 'staging',
    contactEmail: 'ops@example.com',
    startByIso: '2026-11-01T12:30:00.000Z',
    helpers: [],
    at: AT,
    ...over,
  })
  assertEquals(validateAcmeIssueRequestFields(request({ challenge: 'dns-01' })), null)
  assert(validateAcmeIssueRequestFields(request({})) !== null)
  assert(validateAcmeIssueRequestFields(request({ challenge: 'http-01' })) !== null)
  assertEquals(
    validateAcmeIssueRequestFields(request({ names: ['example.com'], challenge: 'http-01' })),
    null
  )
  assert(validateAcmeIssueRequestFields(request({ challenge: 'tls-alpn' })) !== null)
})
