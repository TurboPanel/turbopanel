import { assertEquals } from '@std/assert'
import type { EmailJob } from './types.ts'
import {
  createWorkersQueuedEmailQueue,
  EmailSendError,
  type EmailQueueBinding,
  type EmailQueueMessage,
  settleEmailMessage,
} from './workers-mail-queue.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}; Sonar typescript:S2187 only
 * recognizes `test()` / `it()` / `describe()`.
 */
const test = Deno.test.bind(Deno)

const OTP_JOB: EmailJob = {
  type: 'email-otp',
  to: 'ops@example.com',
  from: 'noreply@example.com',
  otp: '123456',
  otpType: 'sign-in',
}

function message(body: unknown, attempts = 1) {
  const settled: Array<{ action: 'ack' } | { action: 'retry'; delaySeconds?: number }> = []
  const msg: EmailQueueMessage = {
    id: 'm1',
    body,
    attempts,
    ack: () => settled.push({ action: 'ack' }),
    retry: (options) => settled.push({ action: 'retry', delaySeconds: options?.delaySeconds }),
  }
  return { msg, settled }
}

function recordingBinding() {
  const sent: unknown[] = []
  const binding: EmailQueueBinding = {
    send: (body) => {
      sent.push(body)
      return Promise.resolve()
    },
  }
  return { binding, sent }
}

test('a request only puts the job on the mail queue', async () => {
  const { binding, sent } = recordingBinding()
  await createWorkersQueuedEmailQueue(binding).enqueue(OTP_JOB)
  assertEquals(sent, [{ v: 1, job: OTP_JOB }])
})

test('a queued job that sends is acked', async () => {
  const { msg, settled } = message({ v: 1, job: OTP_JOB })
  const delivered: EmailJob[] = []
  const outcome = await settleEmailMessage({
    message: msg,
    sender: {
      send: (job) => {
        delivered.push(job)
        return Promise.resolve()
      },
    },
  })
  assertEquals(outcome, 'sent')
  assertEquals(delivered, [OTP_JOB])
  assertEquals(settled, [{ action: 'ack' }])
})

test('a passing failure is retried later on the self-hosted schedule', async () => {
  const { msg, settled } = message({ v: 1, job: OTP_JOB })
  const outcome = await settleEmailMessage({
    message: msg,
    sender: { send: () => Promise.reject(new Error('Mailgun did not answer')) },
    random: () => 1,
  })
  assertEquals(outcome, 'retry')
  // A sign-in code's first retry waits the first tier, 30 s.
  assertEquals(settled, [{ action: 'retry', delaySeconds: 30 }])
})

test('while mail is not configured a job waits and is retried', async () => {
  const { msg, settled } = message({ v: 1, job: OTP_JOB })
  assertEquals(await settleEmailMessage({ message: msg, sender: null, random: () => 1 }), 'retry')
  assertEquals(settled.length, 1)
})

test('a job the provider refused for good, or out of tries, is dead-lettered and acked', async () => {
  for (const [msgInput, error] of [
    [message({ v: 1, job: OTP_JOB }), new EmailSendError('Mailgun 400: bad address', true)],
    [message({ v: 1, job: OTP_JOB }, 6), new Error('Mailgun did not answer')],
  ] as const) {
    const dead = recordingBinding()
    const outcome = await settleEmailMessage({
      message: msgInput.msg,
      sender: { send: () => Promise.reject(error) },
      deadLetterQueue: dead.binding,
    })
    assertEquals(outcome, 'dead')
    assertEquals(msgInput.settled, [{ action: 'ack' }])
    assertEquals(dead.sent.length, 1)
  }
})

test('a dead-lettered job is counted for the Admin notice; a sent one is not', async () => {
  let counted = 0
  const onDeadLetter = () => {
    counted += 1
    return Promise.resolve()
  }
  const dead = recordingBinding()
  await settleEmailMessage({
    message: message({ v: 1, job: OTP_JOB }, 9).msg,
    sender: { send: () => Promise.reject(new Error('down')) },
    deadLetterQueue: dead.binding,
    onDeadLetter,
  })
  await settleEmailMessage({
    message: message({ v: 1, job: OTP_JOB }).msg,
    sender: { send: () => Promise.resolve() },
    deadLetterQueue: dead.binding,
    onDeadLetter,
  })
  assertEquals(counted, 1)
})

test('an unreadable message is dead-lettered without a send', async () => {
  const { msg, settled } = message({ v: 2, something: 'else' })
  const dead = recordingBinding()
  let sends = 0
  const outcome = await settleEmailMessage({
    message: msg,
    sender: {
      send: () => {
        sends += 1
        return Promise.resolve()
      },
    },
    deadLetterQueue: dead.binding,
  })
  assertEquals(outcome, 'dead')
  assertEquals(sends, 0)
  assertEquals(settled, [{ action: 'ack' }])
})

test('a job that cannot be dead-lettered is handed back, not lost', async () => {
  const { msg, settled } = message({ v: 1, job: OTP_JOB }, 9)
  const outcome = await settleEmailMessage({
    message: msg,
    sender: { send: () => Promise.reject(new Error('down')) },
    deadLetterQueue: { send: () => Promise.reject(new Error('queue down')) },
  })
  assertEquals(outcome, 'dead')
  assertEquals(settled, [{ action: 'retry', delaySeconds: 60 }])
})
