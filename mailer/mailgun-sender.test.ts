import { assertEquals } from '@std/assert'
import type { EmailJob } from '../src/lib/email/types.ts'
import { createMailerMailgunSender, MailerMailgunSender } from './mailgun-sender.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SIGNUP_JOB: EmailJob = {
  type: 'signup-verification',
  to: 'ops@example.com',
  from: 'ignored@example.com',
  verificationUrl: 'https://panel.example.com/verify?token=abc',
}

const OTP_JOB: EmailJob = {
  type: 'email-otp',
  to: 'ops@example.com',
  from: 'ignored@example.com',
  otp: '123456',
  otpType: 'forget-password',
}

const MAILGUN_ENV = {
  TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailgun',
  TURBOPANEL_SYSTEM_EMAIL__FROM: 'noreply@turbopanel.local',
  TURBOPANEL_SYSTEM_EMAIL__MAILGUN_API_KEY: 'key-test-only',
  TURBOPANEL_SYSTEM_EMAIL__MAILGUN_DOMAIN: 'mg.example.com',
}

function mailgunSender(
  env: Record<string, string | undefined> = MAILGUN_ENV,
): MailerMailgunSender {
  return createMailerMailgunSender({ db: undefined, env })
}

function assertFailure(
  result: { success: boolean; error?: string; permanent?: boolean },
): { error: string; permanent: boolean } {
  if (result.success) throw new TypeError('expected a failed send')
  if (typeof result.error !== 'string') throw new TypeError('expected an error string')
  if (typeof result.permanent !== 'boolean') {
    throw new TypeError('expected a permanent flag')
  }
  return { error: result.error, permanent: result.permanent }
}

function withFetch(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): () => void {
  const original = globalThis.fetch
  globalThis.fetch = impl as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

test('createMailerMailgunSender returns a MailerMailgunSender', () => {
  assertEquals(mailgunSender() instanceof MailerMailgunSender, true)
})

test('sendJob delivers signup-verification through Mailgun', async () => {
  let capturedUrl = ''
  const restore = withFetch((input) => {
    capturedUrl = String(input)
    return Promise.resolve(new Response('', { status: 200 }))
  })
  try {
    const result = await mailgunSender().sendJob(SIGNUP_JOB)
    assertEquals(result, { success: true })
    assertEquals(capturedUrl, 'https://api.mailgun.net/v3/mg.example.com/messages')
  } finally {
    restore()
  }
})

test('sendJob delivers email-otp through the EU Mailgun base', async () => {
  let capturedUrl = ''
  const restore = withFetch((input) => {
    capturedUrl = String(input)
    return Promise.resolve(new Response('', { status: 200 }))
  })
  try {
    const result = await mailgunSender({
      ...MAILGUN_ENV,
      TURBOPANEL_SYSTEM_EMAIL__MAILGUN_REGION: 'eu',
    }).sendJob(OTP_JOB)
    assertEquals(result, { success: true })
    assertEquals(capturedUrl, 'https://api.eu.mailgun.net/v3/mg.example.com/messages')
  } finally {
    restore()
  }
})

test('sendJob forwards Mailgun permanent and transient outcomes', async () => {
  const cases = [
    { status: 400, permanent: true },
    { status: 429, permanent: false },
    { status: 500, permanent: false },
  ] as const

  for (const { status, permanent } of cases) {
    const restore = withFetch(() =>
      Promise.resolve(new Response(`status ${status}`, { status })),
    )
    try {
      const result = await mailgunSender().sendJob(OTP_JOB)
      const failure = assertFailure(result)
      assertEquals(failure.permanent, permanent)
      assertEquals(failure.error.includes(`Mailgun ${status}`), true)
    } finally {
      restore()
    }
  }
})

test('sendJob rejects a non-mailgun provider as permanent', async () => {
  const result = await mailgunSender({
    TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'smtp',
  }).sendJob(SIGNUP_JOB)
  const failure = assertFailure(result)
  assertEquals(failure.permanent, true)
  assertEquals(failure.error.includes('not mailgun'), true)
})

test('sendJob rejects missing Mailgun credentials as permanent', async () => {
  const missingKey = await mailgunSender({
    TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailgun',
    TURBOPANEL_SYSTEM_EMAIL__MAILGUN_DOMAIN: 'mg.example.com',
  }).sendJob(SIGNUP_JOB)
  const keyFailure = assertFailure(missingKey)
  assertEquals(keyFailure.permanent, true)
  assertEquals(keyFailure.error, 'Mailgun API key and domain are required')

  const missingDomain = await mailgunSender({
    TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailgun',
    TURBOPANEL_SYSTEM_EMAIL__MAILGUN_API_KEY: 'key-test-only',
  }).sendJob(SIGNUP_JOB)
  const domainFailure = assertFailure(missingDomain)
  assertEquals(domainFailure.permanent, true)
  assertEquals(domainFailure.error, 'Mailgun API key and domain are required')
})

test('sendJob rejects a malformed from address as permanent', async () => {
  const result = await mailgunSender({
    ...MAILGUN_ENV,
    TURBOPANEL_SYSTEM_EMAIL__FROM: 'not-an-email',
  }).sendJob(SIGNUP_JOB)
  const failure = assertFailure(result)
  assertEquals(failure.permanent, true)
  assertEquals(failure.error.includes('malformed from address'), true)
})

test('sendJob rejects unknown job types as permanent without validating to', async () => {
  const result = await mailgunSender().sendJob({
    type: 'not-a-real-type',
    to: 'not-an-email',
    from: 'noreply@example.com',
  } as unknown as EmailJob)
  const failure = assertFailure(result)
  assertEquals(failure.permanent, true)
  assertEquals(failure.error.includes('unknown job type'), true)
})

test('sendJob treats a throwing settings db as a transient failure', async () => {
  const db = {
    select: () => {
      throw new Error('db down')
    },
  }
  const result = await createMailerMailgunSender({
    db: db as never,
    env: MAILGUN_ENV,
  }).sendJob(SIGNUP_JOB)
  const failure = assertFailure(result)
  assertEquals(failure.permanent, false)
  assertEquals(failure.error, 'db down')
})
