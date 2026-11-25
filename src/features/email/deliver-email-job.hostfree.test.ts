import { assertEquals } from '@std/assert'
import { deliverEmailJob } from './deliver-email-job.ts'
import type { MailerSendResult, MailerSender } from './sender-types.ts'
import type { EmailJob } from './types.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}; Sonar typescript:S2187 only
 * recognizes `test()` / `it()` / `describe()`.
 */
const test = Deno.test.bind(Deno)

const OTP: EmailJob = {
  type: 'email-otp',
  to: 'ops@example.net',
  from: 'noreply@example.net',
  otp: '123456',
  otpType: 'sign-in',
}
const NOTICE: EmailJob = {
  type: 'invitation',
  to: 'ops@example.net',
  from: 'noreply@example.net',
  inviterEmail: 'boss@example.net',
  organizationName: 'Example',
  teamName: 'Ops',
  acceptUrl: 'https://example.net/accept',
}

const ok: MailerSender = { sendJob: () => Promise.resolve({ success: true }) }
const result = (r: MailerSendResult): MailerSender => ({ sendJob: () => Promise.resolve(r) })
const throws = (message: string): MailerSender => ({
  sendJob: () => Promise.reject(new Error(message)),
})

type Row = {
  name: string
  job: EmailJob
  sender: MailerSender | null
  failed: number
  expect: unknown
}

const rows: Row[] = [
  { name: 'sent', job: OTP, sender: ok, failed: 1, expect: { kind: 'sent' } },
  {
    name: 'transient failure, first sign-in try: 30 s tier 0',
    job: OTP,
    sender: result({ success: false, error: 'greylisted', permanent: false }),
    failed: 1,
    expect: { kind: 'retry', delayS: 30, delayMs: 30_000, tier: 0, reason: 'greylisted' },
  },
  {
    name: 'thrown send is a transient failure',
    job: OTP,
    sender: throws('socket hang up'),
    failed: 1,
    expect: { kind: 'retry', delayS: 30, delayMs: 30_000, tier: 0, reason: 'socket hang up' },
  },
  {
    name: 'not configured waits like a transient failure',
    job: OTP,
    sender: null,
    failed: 2,
    expect: {
      kind: 'retry',
      delayS: 60,
      delayMs: 60_000,
      tier: 1,
      reason: 'system email is not configured',
    },
  },
  {
    name: 'other jobs start at the second tier',
    job: NOTICE,
    sender: result({ success: false, error: 'busy', permanent: false }),
    failed: 1,
    expect: { kind: 'retry', delayS: 60, delayMs: 60_000, tier: 1, reason: 'busy' },
  },
  {
    name: 'permanent refusal is dead at once',
    job: OTP,
    sender: result({ success: false, error: '550 no such user', permanent: true }),
    failed: 1,
    expect: { kind: 'dead', reason: 'email-otp refused: 550 no such user', permanent: true },
  },
  {
    name: 'sign-in job out of tries',
    job: OTP,
    sender: throws('down'),
    failed: 6,
    expect: { kind: 'dead', reason: 'email-otp gave up after 6 attempts: down', permanent: false },
  },
  {
    name: 'other job out of tries sooner',
    job: NOTICE,
    sender: result({ success: false, error: 'down', permanent: false }),
    failed: 5,
    expect: {
      kind: 'dead',
      reason: 'invitation gave up after 5 attempts: down',
      permanent: false,
    },
  },
  {
    name: 'attempt below 1 counts as the first',
    job: OTP,
    sender: throws('x'),
    failed: 0,
    expect: { kind: 'retry', delayS: 30, delayMs: 30_000, tier: 0, reason: 'x' },
  },
]

for (const row of rows) {
  test(`deliverEmailJob: ${row.name}`, async () => {
    assertEquals(await deliverEmailJob(row.job, row.sender, row.failed, () => 1), row.expect)
  })
}

test('deliverEmailJob: jitter only shortens the wait', async () => {
  const out = await deliverEmailJob(OTP, throws('x'), 1, () => 0)
  assertEquals(out.kind === 'retry' ? out.delayMs : 0, 15_000)
})
