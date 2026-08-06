import { assertEquals } from '@std/assert'
import {
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
