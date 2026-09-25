import { assertEquals } from '@std/assert'
import {
  buildMailpitApiBaseUrl,
  normalizeMailpitRuntimeEnv,
  resolveMailpitSmtpPort,
} from './env.ts'

const test = Deno.test.bind(Deno)

test('buildMailpitApiBaseUrl prefers API URL and strips trailing slash', () => {
  assertEquals(
    buildMailpitApiBaseUrl('https://mailpit.example.dev/', ''),
    'https://mailpit.example.dev',
  )
})

test('buildMailpitApiBaseUrl falls back to localhost web port', () => {
  assertEquals(buildMailpitApiBaseUrl('', '9090'), 'http://127.0.0.1:9090')
  assertEquals(buildMailpitApiBaseUrl('', 'not-a-port'), 'http://127.0.0.1:8025')
})

test('normalizeMailpitRuntimeEnv maps legacy unprefixed vars', () => {
  const normalized = normalizeMailpitRuntimeEnv({
    MAILPIT_API_URL: 'http://127.0.0.1:8025',
    MAILPIT_WEB_PORT: '9090',
    MAILPIT_SMTP_PORT: '1125',
  })
  assertEquals(
    normalized.TURBOPANEL_SYSTEM_EMAIL__MAILPIT_API_URL,
    'http://127.0.0.1:8025',
  )
  assertEquals(normalized.TURBOPANEL_SYSTEM_EMAIL__MAILPIT_WEB_PORT, '9090')
  assertEquals(normalized.TURBOPANEL_SYSTEM_EMAIL__MAILPIT_SMTP_PORT, '1125')
})

test('normalizeMailpitRuntimeEnv does not override prefixed values', () => {
  const normalized = normalizeMailpitRuntimeEnv({
    TURBOPANEL_SYSTEM_EMAIL__MAILPIT_API_URL: 'https://mailpit.turbopanel.dev',
    MAILPIT_API_URL: 'http://legacy',
  })
  assertEquals(
    normalized.TURBOPANEL_SYSTEM_EMAIL__MAILPIT_API_URL,
    'https://mailpit.turbopanel.dev',
  )
})

test('resolveMailpitSmtpPort parses or defaults', () => {
  assertEquals(resolveMailpitSmtpPort('2525'), 2525)
  assertEquals(resolveMailpitSmtpPort(''), 1025)
  assertEquals(resolveMailpitSmtpPort('bad'), 1025)
})
