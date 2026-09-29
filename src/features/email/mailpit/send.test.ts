import { assertEquals } from '@std/assert'
import type { EmailJob } from '../types.ts'
import { sendMailpitJob } from './send.ts'

const test = Deno.test.bind(Deno)

const SIGNUP_JOB: EmailJob = {
  type: 'signup-verification',
  to: 'ops@example.com',
  from: 'ignored@example.com',
  verificationUrl: 'https://panel.example.com/verify?token=abc',
}

test('sendMailpitJob rejects unknown job types as permanent failures', async () => {
  const outcome = await sendMailpitJob({ type: 'bogus' } as unknown as EmailJob, {
    apiBaseUrl: 'http://127.0.0.1:8025',
    from: 'noreply@example.com',
  })
  assertEquals(outcome.ok, false)
  if (outcome.ok) throw new Error('expected failure')
  assertEquals(outcome.permanent, true)
})

test('sendMailpitJob posts signup-verification jobs to Mailpit', async () => {
  let capturedUrl = ''
  const original = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL) => {
    capturedUrl = String(input)
    return Promise.resolve(new Response('', { status: 200 }))
  }) as typeof fetch
  try {
    const outcome = await sendMailpitJob(SIGNUP_JOB, {
      apiBaseUrl: 'https://mailpit.turbopanel.dev',
      from: 'noreply@example.com',
    })
    assertEquals(outcome, { ok: true })
    assertEquals(capturedUrl, 'https://mailpit.turbopanel.dev/api/v1/send')
  } finally {
    globalThis.fetch = original
  }
})

test('sendMailpitJob marks 4xx Mailpit responses as permanent', async () => {
  const original = globalThis.fetch
  globalThis.fetch = () => Promise.resolve(new Response('bad request', { status: 400 }))
  try {
    const outcome = await sendMailpitJob(SIGNUP_JOB, {
      apiBaseUrl: 'http://127.0.0.1:8025',
      from: 'noreply@example.com',
    })
    assertEquals(outcome.ok, false)
    if (outcome.ok) throw new Error('expected failure')
    assertEquals(outcome.permanent, true)
  } finally {
    globalThis.fetch = original
  }
})

test('sendMailpitJob treats network errors as transient', async () => {
  const original = globalThis.fetch
  globalThis.fetch = () => Promise.reject(new Error('connection refused'))
  try {
    const outcome = await sendMailpitJob(SIGNUP_JOB, {
      apiBaseUrl: 'http://127.0.0.1:8025',
      from: 'noreply@example.com',
    })
    assertEquals(outcome.ok, false)
    if (outcome.ok) throw new Error('expected failure')
    assertEquals(outcome.permanent, false)
  } finally {
    globalThis.fetch = original
  }
})

test('sendMailpitJob gives up on a Mailpit that never answers, as a transient failure', async () => {
  const original = globalThis.fetch
  let signalSeen = false
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    signalSeen = init?.signal instanceof AbortSignal
    return Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'))
  }) as typeof fetch
  try {
    const outcome = await sendMailpitJob(SIGNUP_JOB, {
      apiBaseUrl: 'http://127.0.0.1:8025',
      from: 'noreply@example.com',
    })
    assertEquals(signalSeen, true)
    assertEquals(outcome, {
      ok: false,
      error: 'Mailpit did not answer within 10 s',
      permanent: false,
    })
  } finally {
    globalThis.fetch = original
  }
})

test('sendMailpitJob stringifies a non-Error rejection and keeps it transient', async () => {
  const original = globalThis.fetch
  globalThis.fetch = () => Promise.reject('socket hang up')
  try {
    const outcome = await sendMailpitJob(SIGNUP_JOB, {
      apiBaseUrl: 'http://127.0.0.1:8025',
      from: 'noreply@example.com',
    })
    assertEquals(outcome, { ok: false, error: 'socket hang up', permanent: false })
  } finally {
    globalThis.fetch = original
  }
})
