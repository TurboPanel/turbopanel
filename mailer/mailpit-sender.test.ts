import { assertEquals } from '@std/assert'
import type { EmailJob } from '../src/lib/email/types.ts'
import { createMailerMailpitSender, MailerMailpitSender } from './mailpit-sender.ts'

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
  otp: '654321',
  otpType: 'email-verification',
}

const MAILPIT_ENV = {
  TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailpit',
  TURBOPANEL_SYSTEM_EMAIL__FROM: 'noreply@turbopanel.local',
  MAILPIT_API_URL: 'http://127.0.0.1:8025',
}

function mailpitSender(
  env: Record<string, string | undefined> = MAILPIT_ENV,
): MailerMailpitSender {
  return createMailerMailpitSender({ db: undefined, env })
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

test('createMailerMailpitSender returns a MailerMailpitSender', () => {
  assertEquals(mailpitSender() instanceof MailerMailpitSender, true)
})

test('omitted env falls back to Deno.env for Mailpit delivery', async () => {
  const keys = [
    'TURBOPANEL_SYSTEM_EMAIL__PROVIDER',
    'TURBOPANEL_SYSTEM_EMAIL__FROM',
    'MAILPIT_API_URL',
  ] as const
  const previous = Object.fromEntries(keys.map((key) => [key, Deno.env.get(key)]))
  Deno.env.set('TURBOPANEL_SYSTEM_EMAIL__PROVIDER', 'mailpit')
  Deno.env.set('TURBOPANEL_SYSTEM_EMAIL__FROM', 'noreply@turbopanel.local')
  Deno.env.set('MAILPIT_API_URL', 'http://127.0.0.1:8025')
  const restore = withFetch(() => Promise.resolve(new Response('', { status: 200 })))
  try {
    const result = await createMailerMailpitSender({ db: undefined }).sendJob(SIGNUP_JOB)
    assertEquals(result, { success: true })
  } finally {
    restore()
    for (const key of keys) {
      const value = previous[key]
      if (value === undefined) Deno.env.delete(key)
      else Deno.env.set(key, value)
    }
  }
})

test('sendJob posts signup-verification to the Mailpit HTTP API', async () => {
  let capturedUrl = ''
  let capturedBody = ''
  const restore = withFetch((input, init) => {
    capturedUrl = String(input)
    capturedBody = String(init?.body ?? '')
    return Promise.resolve(new Response('', { status: 200 }))
  })
  try {
    const result = await mailpitSender().sendJob(SIGNUP_JOB)
    assertEquals(result, { success: true })
    assertEquals(capturedUrl, 'http://127.0.0.1:8025/api/v1/send')
    assertEquals(capturedBody.includes('Verify your TurboPanel email'), true)
    assertEquals(capturedBody.includes('ops@example.com'), true)
    assertEquals(capturedBody.includes('noreply@turbopanel.local'), true)
  } finally {
    restore()
  }
})

test('sendJob posts email-otp jobs and treats 2xx as success', async () => {
  const restore = withFetch(() => Promise.resolve(new Response(null, { status: 204 })))
  try {
    const result = await mailpitSender().sendJob(OTP_JOB)
    assertEquals(result, { success: true })
  } finally {
    restore()
  }
})

test('sendJob resolves the Mailpit API base from env', async () => {
  const cases: Array<{ env: Record<string, string | undefined>; url: string }> = [
    {
      env: {
        TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailpit',
        MAILPIT_API_URL: 'http://203.0.113.10:8025',
      },
      url: 'http://203.0.113.10:8025/api/v1/send',
    },
    {
      env: {
        TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailpit',
        MAILPIT_WEB_PORT: '9090',
      },
      url: 'http://127.0.0.1:9090/api/v1/send',
    },
    {
      env: {
        TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailpit',
        MAILPIT_WEB_PORT: 'not-a-port',
      },
      url: 'http://127.0.0.1:8025/api/v1/send',
    },
    {
      env: { TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailpit' },
      url: 'http://127.0.0.1:8025/api/v1/send',
    },
  ]

  for (const { env, url } of cases) {
    let capturedUrl = ''
    const restore = withFetch((input) => {
      capturedUrl = String(input)
      return Promise.resolve(new Response('', { status: 200 }))
    })
    try {
      const result = await mailpitSender(env).sendJob(SIGNUP_JOB)
      assertEquals(result, { success: true })
      assertEquals(capturedUrl, url)
    } finally {
      restore()
    }
  }
})

test('sendJob rejects a non-mailpit provider as permanent', async () => {
  const result = await mailpitSender({
    TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'smtp',
  }).sendJob(SIGNUP_JOB)
  const failure = assertFailure(result)
  assertEquals(failure.permanent, true)
  assertEquals(failure.error.includes('not mailpit'), true)
})

test('sendJob rejects unknown job types as permanent', async () => {
  const result = await mailpitSender().sendJob({
    type: 'not-a-real-type',
    to: 'ops@example.com',
    from: 'noreply@example.com',
  } as unknown as EmailJob)
  const failure = assertFailure(result)
  assertEquals(failure.permanent, true)
  assertEquals(failure.error.includes('unknown job type'), true)
})

test('sendJob rejects a malformed recipient as permanent', async () => {
  const result = await mailpitSender().sendJob({
    ...SIGNUP_JOB,
    to: 'not-an-email',
  })
  const failure = assertFailure(result)
  assertEquals(failure.permanent, true)
  assertEquals(failure.error.includes('malformed recipient address'), true)
})

test('sendJob marks Mailpit 4xx responses as permanent', async () => {
  const restore = withFetch(() => Promise.resolve(new Response('bad request', { status: 400 })))
  try {
    const result = await mailpitSender().sendJob(OTP_JOB)
    const failure = assertFailure(result)
    assertEquals(failure.permanent, true)
    assertEquals(failure.error, 'bad request')
  } finally {
    restore()
  }
})

test('sendJob marks Mailpit 5xx responses as transient', async () => {
  const restore = withFetch(() => Promise.resolve(new Response('unavailable', { status: 503 })))
  try {
    const result = await mailpitSender().sendJob(OTP_JOB)
    const failure = assertFailure(result)
    assertEquals(failure.permanent, false)
    assertEquals(failure.error, 'unavailable')
  } finally {
    restore()
  }
})

test('sendJob uses the HTTP status when a 5xx body is empty', async () => {
  const restore = withFetch(() => Promise.resolve(new Response('', { status: 502 })))
  try {
    const result = await mailpitSender().sendJob(OTP_JOB)
    const failure = assertFailure(result)
    assertEquals(failure.permanent, false)
    assertEquals(failure.error, 'HTTP 502')
  } finally {
    restore()
  }
})

test('sendJob treats fetch network errors as transient', async () => {
  const restore = withFetch(() => Promise.reject(new Error('connection refused')))
  try {
    const result = await mailpitSender().sendJob(OTP_JOB)
    const failure = assertFailure(result)
    assertEquals(failure.permanent, false)
    assertEquals(failure.error, 'connection refused')
  } finally {
    restore()
  }
})

test('sendJob stringifies non-Error fetch rejections as transient', async () => {
  const restore = withFetch(() => Promise.reject('dns failed'))
  try {
    const result = await mailpitSender().sendJob(OTP_JOB)
    const failure = assertFailure(result)
    assertEquals(failure.permanent, false)
    assertEquals(failure.error, 'dns failed')
  } finally {
    restore()
  }
})

test('sendJob treats a throwing settings db as a transient failure', async () => {
  const db = {
    select: () => {
      throw new Error('db down')
    },
  }
  const result = await createMailerMailpitSender({
    db: db as never,
    env: MAILPIT_ENV,
  }).sendJob(SIGNUP_JOB)
  const failure = assertFailure(result)
  assertEquals(failure.permanent, false)
  assertEquals(failure.error, 'db down')
})
