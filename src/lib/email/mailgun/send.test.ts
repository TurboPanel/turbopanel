import { assertEquals } from '@std/assert'
import type { EmailJob } from '../types.ts'
import { sendMailgunJob } from './send.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const mailgunConfig = {
  apiKey: 'key-test-only',
  domain: 'mg.example.com',
  from: 'noreply@turbopanel.local',
}

test('sendMailgunJob rejects unknown job types as permanent failures', async () => {
  const outcome = await sendMailgunJob(
    {
      type: 'not-a-real-type',
      to: 'ops@example.com',
      from: 'noreply@example.com',
    } as unknown as EmailJob,
    mailgunConfig,
  )
  assertEquals(outcome.ok, false)
  if (!outcome.ok) {
    assertEquals(outcome.permanent, true)
    assertEquals(outcome.error.includes('unknown job type'), true)
  }
})

test('sendMailgunJob posts email-otp jobs to Mailgun with trimmed config', async () => {
  const originalFetch = globalThis.fetch
  let capturedUrl = ''
  let capturedAuth = ''
  let capturedBody = ''
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input)
    capturedAuth = String(
      (init?.headers as Record<string, string> | undefined)?.Authorization ?? '',
    )
    capturedBody = String(init?.body ?? '')
    return Promise.resolve(new Response('', { status: 200 }))
  }) as typeof fetch

  try {
    const outcome = await sendMailgunJob(
      {
        type: 'email-otp',
        to: 'ops@example.com',
        from: 'noreply@example.com',
        otp: '123456',
        otpType: 'sign-in',
      },
      {
        ...mailgunConfig,
        apiKey: ' key-test-only ',
        domain: ' mg.example.com ',
        apiBase: 'https://api.eu.mailgun.net/v3/',
      },
    )
    assertEquals(outcome.ok, true)
    assertEquals(
      capturedUrl,
      'https://api.eu.mailgun.net/v3/mg.example.com/messages',
    )
    assertEquals(capturedAuth.startsWith('Basic '), true)
    assertEquals(capturedBody.includes('Your+TurboPanel+sign-in+code'), true)
    assertEquals(capturedBody.includes('ops%40example.com'), true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('sendMailgunJob marks most 4xx responses as permanent but not 429', async () => {
  const originalFetch = globalThis.fetch
  const statuses = [
    { status: 400, permanent: true },
    { status: 401, permanent: true },
    { status: 429, permanent: false },
    { status: 500, permanent: false },
  ] as const

  for (const { status, permanent } of statuses) {
    globalThis.fetch = (() =>
      Promise.resolve(new Response(`status ${status}`, { status }))) as typeof fetch
    const outcome = await sendMailgunJob(
      {
        type: 'email-otp',
        to: 'ops@example.com',
        from: 'noreply@example.com',
        otp: '123456',
        otpType: 'forget-password',
      },
      mailgunConfig,
    )
    assertEquals(outcome.ok, false)
    if (!outcome.ok) {
      assertEquals(outcome.permanent, permanent)
      assertEquals(outcome.error.includes(`Mailgun ${status}`), true)
    }
  }

  globalThis.fetch = originalFetch
})

test('sendMailgunJob treats network errors as transient', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (() => Promise.reject(new Error('dns failure'))) as typeof fetch

  try {
    const outcome = await sendMailgunJob(
      {
        type: 'signup-verification',
        to: 'ops@example.com',
        from: 'noreply@example.com',
        verificationUrl: 'https://panel.example.com/verify?token=abc',
      },
      mailgunConfig,
    )
    assertEquals(outcome.ok, false)
    if (!outcome.ok) {
      assertEquals(outcome.permanent, false)
      assertEquals(outcome.error, 'dns failure')
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})
