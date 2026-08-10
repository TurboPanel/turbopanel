import { assertEquals } from '@std/assert'
import type { Db } from '../../../db.ts'
import {
  resolveSelfHostedMailFromAddress,
  resolveSelfHostedSmtpConfig,
  smtpConfigFromRuntimeEnv,
  smtpEnvOverrideActive,
} from './smtp-resolve.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function mockEmailSettingsDb(): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
  } as unknown as Db
}

test('smtpEnvOverrideActive requires both host and port', () => {
  assertEquals(smtpEnvOverrideActive({}), false)
  assertEquals(
    smtpEnvOverrideActive({ TURBOPANEL_SYSTEM_EMAIL__SMTP_HOST: '127.0.0.1' }),
    false,
  )
  assertEquals(
    smtpEnvOverrideActive({
      TURBOPANEL_SYSTEM_EMAIL__SMTP_HOST: '127.0.0.1',
      TURBOPANEL_SYSTEM_EMAIL__SMTP_PORT: '1025',
    }),
    true,
  )
})

test('smtpConfigFromRuntimeEnv parses host/port/user/pass', () => {
  assertEquals(smtpConfigFromRuntimeEnv({}), undefined)
  assertEquals(
    smtpConfigFromRuntimeEnv({
      TURBOPANEL_SYSTEM_EMAIL__SMTP_HOST: 'mail.example.com',
      TURBOPANEL_SYSTEM_EMAIL__SMTP_PORT: 'not-a-port',
    }),
    undefined,
  )
  assertEquals(
    smtpConfigFromRuntimeEnv({
      TURBOPANEL_SYSTEM_EMAIL__SMTP_HOST: ' mail.example.com ',
      TURBOPANEL_SYSTEM_EMAIL__SMTP_PORT: '587',
      TURBOPANEL_SYSTEM_EMAIL__SMTP_USER: ' ops ',
      TURBOPANEL_SYSTEM_EMAIL__SMTP_PASS: 'secret',
    }),
    {
      host: 'mail.example.com',
      port: 587,
      user: 'ops',
      pass: 'secret',
    },
  )
  assertEquals(
    smtpConfigFromRuntimeEnv({
      TURBOPANEL_SYSTEM_EMAIL__SMTP_HOST: 'mail.example.com',
      TURBOPANEL_SYSTEM_EMAIL__SMTP_PORT: '587',
      TURBOPANEL_SYSTEM_EMAIL__SMTP_USER: '',
      TURBOPANEL_SYSTEM_EMAIL__SMTP_PASS: '',
    }),
    { host: 'mail.example.com', port: 587 },
  )
})

test('smtpEnvOverrideActive is false when only port is set', () => {
  assertEquals(
    smtpEnvOverrideActive({ TURBOPANEL_SYSTEM_EMAIL__SMTP_PORT: '587' }),
    false,
  )
})

test('resolveSelfHostedSmtpConfig returns smtp settings for smtp provider', async () => {
  const config = await resolveSelfHostedSmtpConfig(mockEmailSettingsDb(), {
    TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'smtp',
    TURBOPANEL_SYSTEM_EMAIL__SMTP_HOST: '127.0.0.1',
    TURBOPANEL_SYSTEM_EMAIL__SMTP_PORT: '1025',
  })
  assertEquals(config, { host: '127.0.0.1', port: 1025 })
})

test('resolveSelfHostedSmtpConfig returns undefined for non-smtp providers', async () => {
  const config = await resolveSelfHostedSmtpConfig(mockEmailSettingsDb(), {
    TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailgun',
    TURBOPANEL_SYSTEM_EMAIL__MAILGUN_API_KEY: 'key-test-only',
    TURBOPANEL_SYSTEM_EMAIL__MAILGUN_DOMAIN: 'mg.example.com',
  })
  assertEquals(config, undefined)
})

test('resolveSelfHostedMailFromAddress resolves from runtime env', async () => {
  const from = await resolveSelfHostedMailFromAddress(mockEmailSettingsDb(), {
    TURBOPANEL_SYSTEM_EMAIL__FROM: 'ops@203.0.113.10.example',
  })
  assertEquals(from, 'ops@203.0.113.10.example')
})
