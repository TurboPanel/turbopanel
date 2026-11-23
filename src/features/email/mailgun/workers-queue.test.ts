import { assertEquals } from '@std/assert'
import { createNoopQueue, isNoopEmailQueue } from '../noop-queue.ts'
import { resolveWorkersEmailQueue } from './workers-queue.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('resolveWorkersEmailQueue returns noop when mailgun credentials are missing', async () => {
  const queue = await resolveWorkersEmailQueue(undefined, {
    TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailgun',
    TURBOPANEL_SYSTEM_EMAIL__MAILGUN_DOMAIN: 'mg.example.com',
  })
  assertEquals(isNoopEmailQueue(queue), true)
  assertEquals(queue.constructor.name, 'NoopQueue')
})

test('resolveWorkersEmailQueue builds Mailpit and Mailgun queues', async () => {
  const mailpitQueue = await resolveWorkersEmailQueue(undefined, {
    TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailpit-api',
    TURBOPANEL_SYSTEM_EMAIL__MAILPIT_API_URL: 'http://127.0.0.1:8025',
  })
  assertEquals(mailpitQueue.constructor.name, 'WorkersMailpitQueue')

  const mailgunQueue = await resolveWorkersEmailQueue(undefined, {
    TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailgun',
    TURBOPANEL_SYSTEM_EMAIL__MAILGUN_API_KEY: 'key-test-only',
    TURBOPANEL_SYSTEM_EMAIL__MAILGUN_DOMAIN: 'mg.example.com',
  })
  assertEquals(mailgunQueue.constructor.name, 'WorkersMailgunQueue')
})

test('resolveWorkersEmailQueue defaults to mailgun when no provider is set', async () => {
  const queue = await resolveWorkersEmailQueue(undefined, {
    TURBOPANEL_SYSTEM_EMAIL__MAILGUN_API_KEY: 'key-test-only',
    TURBOPANEL_SYSTEM_EMAIL__MAILGUN_DOMAIN: 'mg.example.com',
  })
  assertEquals(queue.constructor.name, 'WorkersMailgunQueue')
})

test('resolveWorkersEmailQueue returns noop for mailpit-api without API URL', async () => {
  const queue = await resolveWorkersEmailQueue(undefined, {
    TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailpit-api',
  })
  assertEquals(isNoopEmailQueue(queue), true)
})

test('resolveWorkersEmailQueue returns noop for smtp provider', async () => {
  const queue = await resolveWorkersEmailQueue(undefined, {
    TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'smtp',
    TURBOPANEL_SYSTEM_EMAIL__SMTP_HOST: '127.0.0.1',
    TURBOPANEL_SYSTEM_EMAIL__SMTP_PORT: '1025',
  })
  assertEquals(queue, createNoopQueue())
})

test('resolveWorkersEmailQueue returns noop when mailgun api key is blank', async () => {
  const queue = await resolveWorkersEmailQueue(undefined, {
    TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailgun',
    TURBOPANEL_SYSTEM_EMAIL__MAILGUN_API_KEY: '   ',
    TURBOPANEL_SYSTEM_EMAIL__MAILGUN_DOMAIN: 'mg.example.com',
  })
  assertEquals(isNoopEmailQueue(queue), true)
})
