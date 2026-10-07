import { assertEquals, assertMatch } from '@std/assert'
import {
  describeEvent,
  eventAudience,
  eventIsUrgent,
  eventSeverity,
  isNotificationEvent,
  isNotificationEventLive,
  NOTIFICATION_EVENTS,
  NOTIFICATION_RULE_EVENTS,
} from './events.ts'
import { emitCertificateRenewalFailed, plainAcmeReason } from './certificate-alerts.ts'
import type { Db } from '../../db/connection.ts'
import type { emitNotification } from './emit.ts'

/** Sonar typescript:S2187 only recognizes `test()`; keep this alias. */
const test = Deno.test.bind(Deno)

test('known probe errors read in plain words', () => {
  assertMatch(plainAcmeReason('dns error: failed to lookup address information'), /does not point/)
  assertMatch(plainAcmeReason('tcp connect error: Connection refused (os error 111)'), /port 443/)
  assertMatch(plainAcmeReason('operation timed out'), /in time/)
  assertMatch(plainAcmeReason('invalid peer certificate: UnknownIssuer'), /test certificate/)
  assertMatch(plainAcmeReason('too many certificates already issued'), /limiting/)
  assertMatch(plainAcmeReason('CAA record prevents issuance'), /CAA/)
})

test('an unknown or empty error still gives one calm sentence', () => {
  assertEquals(
    plainAcmeReason(undefined),
    "Let's Encrypt could not issue or renew the certificate."
  )
  assertEquals(plainAcmeReason('zzz'), plainAcmeReason(''))
})

test('the renewal alert names the domain, carries the reason and goes out at once', () => {
  const { title, body } = describeEvent('certificate.renewal_failed', {
    hostname: 'shop.acme.com',
    reason: 'The domain name does not point at this server yet.',
  })
  assertEquals(title, 'Certificate renewal failed for shop.acme.com')
  assertMatch(body ?? '', /does not point at this server yet\./)
  assertEquals(eventIsUrgent('certificate.renewal_failed'), true)
  assertEquals(eventSeverity('certificate.renewal_failed'), 'warning')
  assertEquals(eventAudience('certificate.renewal_failed'), 'members')
})

const FAILURE = { organizationId: 'org-1', hostname: 'shop.acme.com', rawError: 'dns error' }
const NO_DB = new Proxy(
  {},
  {
    get() {
      throw new Error('the database must not be touched')
    },
  }
) as unknown as Db

type EmitArgs = Parameters<typeof emitNotification>
function recordingEmit() {
  const calls: EmitArgs[] = []
  const emit = ((...args: EmitArgs) => {
    calls.push(args)
    return Promise.resolve({} as Awaited<ReturnType<typeof emitNotification>>)
  }) as typeof emitNotification
  return { calls, emit }
}

test('until the migration widens the CHECK constraints the event is not offered anywhere', () => {
  assertEquals(isNotificationEventLive('certificate.renewal_failed'), false)
  assertEquals(isNotificationEvent('certificate.renewal_failed'), false)
  assertEquals(NOTIFICATION_EVENTS.includes('certificate.renewal_failed' as never), false)
  assertEquals(NOTIFICATION_RULE_EVENTS.includes('certificate.renewal_failed' as never), false)
})

test('on an unmigrated database the emitter does nothing and never touches the database', async () => {
  const { calls, emit } = recordingEmit()
  await emitCertificateRenewalFailed(NO_DB, undefined, FAILURE, { emit })
  assertEquals(calls.length, 0)
})

test('once the event is live the emitter sends one organization alert with the plain reason', async () => {
  const { calls, emit } = recordingEmit()
  await emitCertificateRenewalFailed(NO_DB, undefined, FAILURE, { live: true, emit })
  assertEquals(calls.length, 1)
  const input = calls[0]![2]
  assertEquals(input.event, 'certificate.renewal_failed')
  assertEquals(input.organizationId, 'org-1')
  assertEquals(input.context?.hostname, 'shop.acme.com')
  assertMatch(String(input.context?.reason), /does not point/)
  assertEquals(input.context?.detail, 'dns error')
})
