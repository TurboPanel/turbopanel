import { assertEquals } from '@std/assert'
import {
  emailSettingsToApiShape,
  emailUpdatesRequireEncryption,
  isEmailActive,
  isEmailActiveForRuntime,
  resolveEmailSettings,
  resolveMailgunApiBase,
} from './email-settings.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('resolveMailgunApiBase maps EU region and defaults to US', () => {
  assertEquals(resolveMailgunApiBase('eu'), 'https://api.eu.mailgun.net/v3')
  assertEquals(resolveMailgunApiBase(' EU '), 'https://api.eu.mailgun.net/v3')
  assertEquals(resolveMailgunApiBase(undefined), 'https://api.mailgun.net/v3')
  assertEquals(resolveMailgunApiBase('us'), 'https://api.mailgun.net/v3')
})

test('isEmailActive reflects provider-specific requirements', async () => {
  const mailpit = await resolveEmailSettings(undefined, {
    TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailpit',
  })
  assertEquals(isEmailActive(mailpit), true)

  const smtpMissing = await resolveEmailSettings(undefined, {
    TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'smtp',
  })
  assertEquals(isEmailActive(smtpMissing), false)

  const smtpReady = await resolveEmailSettings(undefined, {
    TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'smtp',
    TURBOPANEL_SYSTEM_EMAIL__SMTP_HOST: '127.0.0.1',
    TURBOPANEL_SYSTEM_EMAIL__SMTP_PORT: '1025',
  })
  assertEquals(isEmailActive(smtpReady), true)
  assertEquals(isEmailActiveForRuntime(smtpReady, 'deno'), true)

  const mailgunMissing = await resolveEmailSettings(undefined, {
    TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailgun',
  })
  assertEquals(isEmailActive(mailgunMissing), false)

  const mailgunReady = await resolveEmailSettings(undefined, {
    TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailgun',
    TURBOPANEL_SYSTEM_EMAIL__MAILGUN_API_KEY: 'key',
    TURBOPANEL_SYSTEM_EMAIL__MAILGUN_DOMAIN: 'mg.example.com',
  })
  assertEquals(isEmailActive(mailgunReady), true)
})

test('resolveEmailSettings normalizes burst to per-minute rate when unset', async () => {
  const resolved = await resolveEmailSettings(undefined, {
    TURBOPANEL_SYSTEM_EMAIL__RATE_LIMIT_PER_MINUTE: '45',
  })
  assertEquals(resolved.keys.RATE_LIMIT_BURST.value, '45')
})

test('emailUpdatesRequireEncryption detects secret writes only', () => {
  assertEquals(
    emailUpdatesRequireEncryption({
      TURBOPANEL_SYSTEM_EMAIL__SMTP_HOST: '127.0.0.1',
    }),
    false,
  )
  assertEquals(
    emailUpdatesRequireEncryption({
      SMTP_PASS: 'secret',
    }),
    true,
  )
  assertEquals(
    emailUpdatesRequireEncryption({
      TURBOPANEL_SYSTEM_EMAIL__MAILGUN_API_KEY: '   ',
    }),
    false,
  )
})

test('emailSettingsToApiShape masks env and db secrets', async () => {
  const envResolved = await resolveEmailSettings(undefined, {
    TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailgun',
    TURBOPANEL_SYSTEM_EMAIL__MAILGUN_API_KEY: 'env-key',
    TURBOPANEL_SYSTEM_EMAIL__MAILGUN_DOMAIN: 'mg.example.com',
  })
  const envApi = emailSettingsToApiShape(envResolved)
  assertEquals(envApi.TURBOPANEL_SYSTEM_EMAIL__MAILGUN_API_KEY, {
    source: 'env',
    value: null,
  })
  assertEquals(envApi.TURBOPANEL_SYSTEM_EMAIL__MAILGUN_DOMAIN?.value, 'mg.example.com')
})
