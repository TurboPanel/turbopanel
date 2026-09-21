import { assertEquals, assertRejects, assertThrows } from '@std/assert'
import nodemailerShim from './nodemailer-shim.ts'
import {
  createMailerSmtpSender,
  MailerSmtpSender,
} from './smtp-sender-shim.ts'
import type { EmailJob } from '../types.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SMTP_UNAVAILABLE = 'SMTP not available on Workers'

const sampleJob: EmailJob = {
  type: 'email-otp',
  to: 'ops@example.com',
  from: 'noreply@example.com',
  otp: '123456',
  otpType: 'sign-in',
}

test('nodemailer Workers shim rejects createTransport', () => {
  assertThrows(
    () => nodemailerShim.createTransport(),
    Error,
    SMTP_UNAVAILABLE,
  )
})

test('smtp-sender Workers shim constructor and factory reject', () => {
  assertThrows(
    () => new MailerSmtpSender({}),
    Error,
    SMTP_UNAVAILABLE,
  )
  assertThrows(
    () => createMailerSmtpSender({}),
    Error,
    SMTP_UNAVAILABLE,
  )
})

test('smtp-sender Workers shim sendJob rejects even when invoked on the prototype', async () => {
  await assertRejects(
    () => MailerSmtpSender.prototype.sendJob(sampleJob),
    Error,
    SMTP_UNAVAILABLE,
  )
  assertEquals(typeof MailerSmtpSender.prototype.sendJob, 'function')
})
