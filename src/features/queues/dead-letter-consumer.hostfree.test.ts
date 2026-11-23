import { assertEquals, assertStringIncludes } from '@std/assert'
import {
  consumeDeadLetterBatch,
  deadLetterQueueKind,
  type DeadLetterDeps,
  type DeadLetterMessage,
  type DeadLetterRecord,
  type RecordOutcome,
  redactDeadLetter,
  redactError,
  settleDeadLetter,
} from './dead-letter-consumer.ts'

/** Jest/Mocha-shaped alias so Sonar sees real tests (see AGENTS.md). */
const test = Deno.test.bind(Deno)

function message(body: unknown, id = 'msg-1', attempts = 4) {
  const calls: string[] = []
  const m: DeadLetterMessage = {
    id,
    body,
    attempts,
    timestamp: new Date('2026-11-23T10:00:00.000Z'),
    ack: () => calls.push('ack'),
    retry: (options) => calls.push(options === undefined ? 'retry' : 'retry-delayed'),
  }
  return { m, calls }
}

const COMMAND_BODY = {
  commandId: 'cmd-1',
  serverId: 'srv-1',
  type: 'deploy',
  attempt: 3,
  queuedAt: '2026-11-23T09:00:00.000Z',
  extra: 'body-field-should-never-appear',
}

test('queue names map to a dead-letter kind in every environment', () => {
  assertEquals(deadLetterQueueKind('daemon-commands-dlq'), 'commands')
  assertEquals(deadLetterQueueKind('staging-daemon-commands-dlq'), 'commands')
  assertEquals(deadLetterQueueKind('system-email-dlq'), 'email')
  assertEquals(deadLetterQueueKind('testing-system-email-dlq'), 'email')
  assertEquals(deadLetterQueueKind('system-email'), null)
  assertEquals(deadLetterQueueKind('dev-daemon-commands'), null)
})

test('a command dead letter keeps ids and type only, never other body fields', () => {
  const { m } = message(COMMAND_BODY)
  const record = redactDeadLetter('commands', m)
  assertEquals(record, {
    queue: 'commands',
    messageId: 'msg-1',
    type: 'deploy',
    commandId: 'cmd-1',
    serverId: 'srv-1',
    attempts: 4,
    error: 'delivery retries exhausted',
    seenAt: '2026-11-23T10:00:00.000Z',
  })
  assertEquals(JSON.stringify(record).includes('never-appear'), false)
})

test('an email dead letter drops the job body and scrubs the reason', () => {
  const { m } = message({
    body: {
      v: 1,
      job: {
        type: 'password-reset',
        to: 'person@example.net',
        link: 'https://x.example.net/t/abc',
      },
    },
    reason: 'password-reset gave up after 6 attempts: 550 rejected person@example.net',
    at: '2026-11-23T09:59:00.000Z',
  })
  const record = redactDeadLetter('email', m)
  assertEquals(record.type, 'password-reset')
  assertStringIncludes(record.error, '[address]')
  const text = JSON.stringify(record)
  assertEquals(text.includes('person@example.net'), false)
  assertEquals(text.includes('x.example.net'), false)
})

test('a raw platform-moved mail message and an unreadable body still yield a record', () => {
  const raw = redactDeadLetter('email', message({ v: 1, job: { type: 'verify' } }).m)
  assertEquals(raw.type, 'verify')
  const broken = redactDeadLetter('commands', message('not json{').m)
  assertEquals(broken.type, null)
  assertEquals(broken.commandId, null)
})

test('redactError removes urls and long tokens and cuts the length', () => {
  const out = redactError(`see https://a.example.net/x ${'a'.repeat(40)} ${'word '.repeat(80)}`)
  assertEquals(out.includes('https'), false)
  assertEquals(out.includes('aaaa'), false)
  assertEquals(out.length <= 160, true)
})

test('redactError scrubs scheme-less urls, 20-character tokens and long address runs', () => {
  const out = redactError(
    'failed host.example.net/path?x=1 and api.example.net ' +
      'token abcdefghij0123456789 mail a.b+c@mail.example.net ' +
      `${'a@'.repeat(200)}`
  )
  assertEquals(out.includes('example.net'), false)
  assertEquals(out.includes('abcdefghij'), false)
  assertEquals(out.includes('@mail'), false)
  assertEquals(redactError('gave up after 6 attempts'), 'gave up after 6 attempts')
})

function fakeDeps(outcomes: RecordOutcome[]) {
  const notified: Array<[DeadLetterRecord, string]> = []
  const recorded: DeadLetterRecord[] = []
  const deps: DeadLetterDeps = {
    record: (r) => {
      recorded.push(r)
      const next = outcomes.shift()
      if (!next) return Promise.reject(new Error('db down'))
      return Promise.resolve(next)
    },
    notify: (r, alert) => {
      notified.push([r, alert])
      return Promise.resolve()
    },
  }
  return { deps, notified, recorded }
}

test('a new dead letter is recorded, acked and announced once', async () => {
  const { m, calls } = message(COMMAND_BODY)
  const { deps, notified } = fakeDeps([{ recorded: true, alert: 'first' }])
  assertEquals(await settleDeadLetter('commands', m, deps), 'recorded')
  assertEquals(calls, ['ack'])
  assertEquals(notified.length, 1)
  assertEquals(notified[0]?.[1], 'first')
})

test('a record that needs no alert is acked without a notice', async () => {
  const { m, calls } = message(COMMAND_BODY)
  const { deps, notified } = fakeDeps([{ recorded: true, alert: null }])
  await settleDeadLetter('commands', m, deps)
  assertEquals(calls, ['ack'])
  assertEquals(notified.length, 0)
})

test('a redelivered message is acked with no second record or notice', async () => {
  const { deps, notified } = fakeDeps([{ recorded: true, alert: 'first' }, { recorded: false }])
  const first = message(COMMAND_BODY)
  const again = message(COMMAND_BODY)
  await settleDeadLetter('commands', first.m, deps)
  assertEquals(await settleDeadLetter('commands', again.m, deps), 'duplicate')
  assertEquals(again.calls, ['ack'])
  assertEquals(notified.length, 1)
})

test('a failed record retries the message and sends no notice', async () => {
  const { m, calls } = message(COMMAND_BODY)
  const { deps, notified } = fakeDeps([])
  assertEquals(await settleDeadLetter('commands', m, deps), 'retry')
  assertEquals(calls, ['retry'])
  assertEquals(notified.length, 0)
})

test('a batch settles every message in order', async () => {
  const a = message(COMMAND_BODY, 'a')
  const b = message(COMMAND_BODY, 'b')
  const { deps, recorded } = fakeDeps([
    { recorded: true, alert: 'first' },
    { recorded: true, alert: null },
  ])
  await consumeDeadLetterBatch('commands', [a.m, b.m], deps)
  assertEquals(
    recorded.map((r) => r.messageId),
    ['a', 'b']
  )
  assertEquals([a.calls, b.calls], [['ack'], ['ack']])
})
