import { assertEquals } from 'jsr:@std/assert'
import {
  createDenoMailgunQueue,
  resolveDenoMailgunQueue,
} from './deno-mailgun-queue.ts'
import type { EmailJob } from '../types.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const sampleJob: EmailJob = {
  type: 'email-otp',
  to: 'ops@example.com',
  from: 'noreply@example.com',
  otp: '123456',
  otpType: 'sign-in',
}

test('resolveDenoMailgunQueue returns null for non-mailgun providers', async () => {
  assertEquals(
    await resolveDenoMailgunQueue(undefined, {
      TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'smtp',
      TURBOPANEL_SYSTEM_EMAIL__SMTP_HOST: '127.0.0.1',
      TURBOPANEL_SYSTEM_EMAIL__SMTP_PORT: '1025',
    }),
    null,
  )
  assertEquals(
    await resolveDenoMailgunQueue(undefined, {
      TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailpit',
    }),
    null,
  )
})

test('resolveDenoMailgunQueue returns null when mailgun credentials are missing', async () => {
  assertEquals(
    await resolveDenoMailgunQueue(undefined, {
      TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailgun',
      TURBOPANEL_SYSTEM_EMAIL__MAILGUN_DOMAIN: 'mg.example.com',
    }),
    null,
  )
  assertEquals(
    await resolveDenoMailgunQueue(undefined, {
      TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailgun',
      TURBOPANEL_SYSTEM_EMAIL__MAILGUN_API_KEY: '   ',
      TURBOPANEL_SYSTEM_EMAIL__MAILGUN_DOMAIN: 'mg.example.com',
    }),
    null,
  )
})

test('resolveDenoMailgunQueue builds a queue when credentials are present', async () => {
  const queue = await resolveDenoMailgunQueue(undefined, {
    TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailgun',
    TURBOPANEL_SYSTEM_EMAIL__MAILGUN_API_KEY: 'key-test-only',
    TURBOPANEL_SYSTEM_EMAIL__MAILGUN_DOMAIN: 'mg.example.com',
  })
  assertEquals(queue?.constructor.name, 'DenoMailgunQueue')
})

test('createDenoMailgunQueue enqueue is a no-op for non-mailgun providers', async () => {
  const queue = createDenoMailgunQueue({
    db: undefined,
    env: { TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailpit' },
  })
  await queue.enqueue(sampleJob)
})

test('createDenoMailgunQueue enqueue is a no-op when credentials are blank', async () => {
  const queue = createDenoMailgunQueue({
    db: undefined,
    env: {
      TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailgun',
      TURBOPANEL_SYSTEM_EMAIL__MAILGUN_API_KEY: '   ',
      TURBOPANEL_SYSTEM_EMAIL__MAILGUN_DOMAIN: 'mg.example.com',
    },
  })
  await queue.enqueue(sampleJob)
})
