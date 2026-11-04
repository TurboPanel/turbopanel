import { assertEquals } from '@std/assert'
import { emailDeliveryState } from './delivery-status.ts'
import type { ResolvedEmailSettings } from '../settings/email-settings.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}; Sonar typescript:S2187 only
 * recognizes `test()` / `it()` / `describe()`.
 */
const test = Deno.test.bind(Deno)

function settings(overrides: Partial<ResolvedEmailSettings>): ResolvedEmailSettings {
  return {
    provider: 'smtp',
    from: 'noreply@example.com',
    mailgunRegion: 'us',
    mailgunApiBase: 'https://api.mailgun.net/v3',
    keys: { MAILPIT_API_URL: { value: '' } } as unknown as ResolvedEmailSettings['keys'],
    ...overrides,
  }
}

const MAILGUN = settings({
  provider: 'mailgun',
  mailgunApiKey: 'key',
  mailgunDomain: 'mg.example.com',
})

test('a set-up provider with a reachable queue delivers on both editions', () => {
  for (const runtime of ['deno', 'workers'] as const) {
    assertEquals(emailDeliveryState({ settings: MAILGUN, runtime, queueUnavailable: false }), 'ok')
  }
})

test('no usable provider for the edition is not configured', () => {
  // SMTP cannot be used on High Availability.
  const smtp = settings({ provider: 'smtp', smtp: { host: 'mail.example.com' } as never })
  assertEquals(
    emailDeliveryState({ settings: smtp, runtime: 'workers', queueUnavailable: false }),
    'not_configured'
  )
  assertEquals(
    emailDeliveryState({ settings: smtp, runtime: 'deno', queueUnavailable: false }),
    'ok'
  )
  const noKey = settings({ provider: 'mailgun' })
  assertEquals(
    emailDeliveryState({ settings: noKey, runtime: 'deno', queueUnavailable: false }),
    'not_configured'
  )
})

test('self-hosted without its mail broker is not delivering', () => {
  assertEquals(
    emailDeliveryState({ settings: MAILGUN, runtime: 'deno', queueUnavailable: true }),
    'queue_unavailable'
  )
  // High Availability has no broker of its own to be missing.
  assertEquals(
    emailDeliveryState({ settings: MAILGUN, runtime: 'workers', queueUnavailable: true }),
    'ok'
  )
})
