import { assertEquals } from '@std/assert'
import type { EmailJob } from '../types.ts'
import { resolveMailpitApiBaseUrl, sendMailpitJob } from './send.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('resolveMailpitApiBaseUrl prefers MAILPIT_API_URL and strips trailing slash', () => {
  assertEquals(
    resolveMailpitApiBaseUrl({ MAILPIT_API_URL: 'http://127.0.0.1:8025/' }),
    'http://127.0.0.1:8025',
  )
})

test('resolveMailpitApiBaseUrl falls back to MAILPIT_WEB_PORT', () => {
  assertEquals(
    resolveMailpitApiBaseUrl({ MAILPIT_WEB_PORT: '9090' }),
    'http://127.0.0.1:9090',
  )
})

test('resolveMailpitApiBaseUrl defaults when env is empty or invalid', () => {
  assertEquals(resolveMailpitApiBaseUrl({}), 'http://127.0.0.1:8025')
  assertEquals(
    resolveMailpitApiBaseUrl({ MAILPIT_WEB_PORT: 'not-a-port' }),
    'http://127.0.0.1:8025',
  )
})

test('sendMailpitJob rejects unknown job types as permanent failures', async () => {
  const outcome = await sendMailpitJob(
    {
      type: 'not-a-real-type',
      to: 'ops@example.com',
      from: 'noreply@example.com',
    } as unknown as EmailJob,
    { apiBaseUrl: 'http://127.0.0.1:8025', from: 'noreply@example.com' },
  )
  assertEquals(outcome.ok, false)
  if (!outcome.ok) {
    assertEquals(outcome.permanent, true)
    assertEquals(outcome.error.includes('unknown job type'), true)
  }
})

test('sendMailpitJob posts signup-verification jobs to Mailpit', async () => {
  const originalFetch = globalThis.fetch
  let capturedUrl = ''
  let capturedBody = ''
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input)
    capturedBody = String(init?.body ?? '')
    return Promise.resolve(new Response('', { status: 200 }))
  }) as typeof fetch

  try {
    const outcome = await sendMailpitJob(
      {
        type: 'signup-verification',
        to: 'ops@example.com',
        from: 'noreply@example.com',
        verificationUrl: 'https://panel.example.com/verify?token=abc',
      },
      { apiBaseUrl: 'http://127.0.0.1:8025/', from: 'noreply@turbopanel.local' },
    )
    assertEquals(outcome.ok, true)
    assertEquals(capturedUrl, 'http://127.0.0.1:8025/api/v1/send')
    assertEquals(capturedBody.includes('Verify your TurboPanel email'), true)
    assertEquals(capturedBody.includes('ops@example.com'), true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('sendMailpitJob marks 4xx Mailpit responses as permanent', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (() =>
    Promise.resolve(new Response('bad request', { status: 400 }))) as typeof fetch

  try {
    const outcome = await sendMailpitJob(
      {
        type: 'email-otp',
        to: 'ops@example.com',
        from: 'noreply@example.com',
        otp: '654321',
        otpType: 'sign-in',
      },
      { apiBaseUrl: 'http://127.0.0.1:8025', from: 'noreply@example.com' },
    )
    assertEquals(outcome.ok, false)
    if (!outcome.ok) {
      assertEquals(outcome.permanent, true)
      assertEquals(outcome.error, 'bad request')
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('sendMailpitJob treats network errors as transient', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (() => Promise.reject(new Error('connection refused'))) as typeof fetch

  try {
    const outcome = await sendMailpitJob(
      {
        type: 'email-otp',
        to: 'ops@example.com',
        from: 'noreply@example.com',
        otp: '654321',
        otpType: 'sign-in',
      },
      { apiBaseUrl: 'http://127.0.0.1:8025', from: 'noreply@example.com' },
    )
    assertEquals(outcome.ok, false)
    if (!outcome.ok) {
      assertEquals(outcome.permanent, false)
      assertEquals(outcome.error, 'connection refused')
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})
