import { assertEquals } from 'jsr:@std/assert'
import { resolveEmailSettings } from '../../settings/email-settings.ts'
import { createNoopQueue, isNoopEmailQueue } from '../noop-queue.ts'
import { emailQueueFromResolvedSettings } from './workers-queue.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('emailQueueFromResolvedSettings returns noop when mailgun credentials are missing', async () => {
  const resolved = await resolveEmailSettings(undefined, {
    TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailgun',
    TURBOPANEL_SYSTEM_EMAIL__MAILGUN_DOMAIN: 'mg.example.com',
  })
  const queue = emailQueueFromResolvedSettings(resolved, {})
  assertEquals(isNoopEmailQueue(queue), true)
  assertEquals(queue.constructor.name, 'NoopQueue')
})

test('emailQueueFromResolvedSettings builds Mailpit and Mailgun queues', async () => {
  const mailpitResolved = await resolveEmailSettings(undefined, {
    TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailpit',
  })
  const mailpitQueue = emailQueueFromResolvedSettings(mailpitResolved, {
    MAILPIT_API_URL: 'http://127.0.0.1:8025',
  })
  assertEquals(mailpitQueue.constructor.name, 'WorkersMailpitQueue')

  const mailgunResolved = await resolveEmailSettings(undefined, {
    TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailgun',
    TURBOPANEL_SYSTEM_EMAIL__MAILGUN_API_KEY: 'key-test-only',
    TURBOPANEL_SYSTEM_EMAIL__MAILGUN_DOMAIN: 'mg.example.com',
  })
  const mailgunQueue = emailQueueFromResolvedSettings(mailgunResolved, {})
  assertEquals(mailgunQueue.constructor.name, 'WorkersMailgunQueue')
})

test('emailQueueFromResolvedSettings returns noop for smtp provider', async () => {
  const resolved = await resolveEmailSettings(undefined, {
    TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'smtp',
    TURBOPANEL_SYSTEM_EMAIL__SMTP_HOST: '127.0.0.1',
    TURBOPANEL_SYSTEM_EMAIL__SMTP_PORT: '1025',
  })
  const queue = emailQueueFromResolvedSettings(resolved, {})
  assertEquals(queue, createNoopQueue())
})
