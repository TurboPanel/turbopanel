import { assertEquals, assertNotEquals } from '@std/assert'
import {
  deadLetterId,
  maskEmailAddress,
  replayHeaders,
  summarizeDeadLetter,
} from './dead-letter-replay.ts'

const test = Deno.test.bind(Deno)
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

test('an address is masked to its first letter and its domain', () => {
  assertEquals(maskEmailAddress('jane.doe@example.com'), 'j***@example.com')
  assertEquals(maskEmailAddress('a@b.co'), 'a***@b.co')
  assertEquals(maskEmailAddress('not-an-address'), null)
  assertEquals(maskEmailAddress('@example.com'), null)
  assertEquals(maskEmailAddress('jane@'), null)
  assertEquals(maskEmailAddress(42), null)
})

test('a summary names the job and the reason but never carries its body', async () => {
  const content = bytes({
    type: 'email-otp',
    to: 'jane.doe@example.com',
    from: 'noreply@panel.test',
    otp: '482913',
    otpType: 'sign-in',
  })
  const summary = await summarizeDeadLetter({
    content,
    properties: {
      messageId: 'm-1',
      headers: {
        'x-tp-attempt': 5,
        'x-tp-dead-reason': 'email-otp gave up after 5 attempts: greylisted',
        'x-tp-dead-at': '2026-10-05T12:00:00.000Z',
      },
    },
  })
  assertEquals(summary, {
    id: 'm-1',
    jobType: 'email-otp',
    to: 'j***@example.com',
    failedAttempts: 5,
    reason: 'email-otp gave up after 5 attempts: greylisted',
    deadAt: '2026-10-05T12:00:00.000Z',
  })
  const text = JSON.stringify(summary)
  assertEquals(text.includes('482913'), false)
  assertEquals(text.includes('jane.doe'), false)
})

test('a body that does not parse still lists, as unknown', async () => {
  const summary = await summarizeDeadLetter({ content: new TextEncoder().encode('{nope') })
  assertEquals(summary.jobType, 'unknown')
  assertEquals(summary.to, null)
  assertEquals(summary.failedAttempts, 0)
  assertEquals(summary.reason, null)
  assertEquals(summary.deadAt, null)
})

test('a message without an id gets a stable hash id that differs per body', async () => {
  const a = bytes({ type: 'invitation', to: 'a@x.test' })
  const b = bytes({ type: 'invitation', to: 'b@x.test' })
  const first = await deadLetterId(undefined, a)
  assertEquals(first, await deadLetterId('', a))
  assertEquals(/^h-[0-9a-f]{16}$/.test(first), true)
  assertNotEquals(first, await deadLetterId(undefined, b))
  assertEquals(await deadLetterId('given', a), 'given')
})

test('replay headers reset the attempt count and dead-letter notes and stamp the replay', () => {
  const now = new Date('2026-10-05T13:00:00.000Z')
  const out = replayHeaders(
    {
      'x-tp-attempt': 5,
      'x-tp-dead-reason': 'gave up',
      'x-tp-dead-at': '2026-10-05T12:00:00.000Z',
      other: 'kept',
    },
    now
  )
  assertEquals(out, { other: 'kept', 'x-tp-replayed-at': now.toISOString() })
  assertEquals(replayHeaders(undefined, now), { 'x-tp-replayed-at': now.toISOString() })
})
