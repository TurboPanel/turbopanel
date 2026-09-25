import { assertEquals } from '@std/assert'
import {
  DEFAULT_DENO_MAILPIT_API_BASE_URL,
  normalizeMailpitApiEnv,
  normalizeMailpitSmtpEnv,
  parseMailpitApiBaseUrl,
  resolveDenoMailpitApiBaseUrl,
  resolveMailpitSmtpPort,
  resolveWorkersMailpitApiBaseUrl,
} from './env.ts'

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

test('resolveDenoMailpitApiBaseUrl falls back to co-located Mailpit', () => {
  assertEquals(resolveDenoMailpitApiBaseUrl(''), DEFAULT_DENO_MAILPIT_API_BASE_URL)
  assertEquals(resolveDenoMailpitApiBaseUrl('http://127.0.0.1:9090'), 'http://127.0.0.1:9090')
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

test('resolveMailpitSmtpPort parses or defaults', () => {
  assertEquals(resolveMailpitSmtpPort('2525'), 2525)
  assertEquals(resolveMailpitSmtpPort(''), 1025)
  assertEquals(resolveMailpitSmtpPort('bad'), 1025)
})
