import { assertEquals } from '@std/assert'
import {
  normalizeMailpitApiEnv,
  normalizeMailpitSmtpEnv,
  parseMailpitApiBaseUrl,
  resolveMailpitSmtpPort,
  resolveWorkersMailpitApiBaseUrl,
} from './env.ts'
import { buildMailpitSmtpConfig } from './smtp-config.ts'

const test = Deno.test.bind(Deno)

test('parseMailpitApiBaseUrl trims and strips trailing slash', () => {
  assertEquals(
    parseMailpitApiBaseUrl('https://mailpit.example.dev/'),
    'https://mailpit.example.dev',
  )
  assertEquals(parseMailpitApiBaseUrl('   '), undefined)
})

test('resolveWorkersMailpitApiBaseUrl requires an explicit URL', () => {
  assertEquals(resolveWorkersMailpitApiBaseUrl('https://mailpit.turbopanel.dev'), 'https://mailpit.turbopanel.dev')
  assertEquals(resolveWorkersMailpitApiBaseUrl(''), undefined)
})

test('normalizeMailpitApiEnv maps legacy API URL env', () => {
  const normalized = normalizeMailpitApiEnv({
    MAILPIT_API_URL: 'http://127.0.0.1:8025',
  })
  assertEquals(
    normalized.TURBOPANEL_SYSTEM_EMAIL__MAILPIT_API_URL,
    'http://127.0.0.1:8025',
  )
})

test('normalizeMailpitSmtpEnv maps legacy SMTP port env', () => {
  const normalized = normalizeMailpitSmtpEnv({
    MAILPIT_SMTP_PORT: '1125',
  })
  assertEquals(normalized.TURBOPANEL_SYSTEM_EMAIL__MAILPIT_SMTP_PORT, '1125')
})

test('buildMailpitSmtpConfig prefers explicit SMTP host/port', () => {
  assertEquals(
    buildMailpitSmtpConfig('203.0.113.10', '2525', '', '', ''),
    { host: '203.0.113.10', port: 2525 },
  )
  assertEquals(
    buildMailpitSmtpConfig('', '', '1125', '', ''),
    { host: '127.0.0.1', port: 1125 },
  )
})

test('resolveMailpitSmtpPort parses or defaults', () => {
  assertEquals(resolveMailpitSmtpPort('2525'), 2525)
  assertEquals(resolveMailpitSmtpPort(''), 1025)
  assertEquals(resolveMailpitSmtpPort('bad'), 1025)
})
