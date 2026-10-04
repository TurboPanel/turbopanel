import { assertEquals, assertStringIncludes } from '@std/assert'
import { parseEmailJob } from '../../lib/email/mailer/parse-email-job.ts'
import { createChannelVerificationEmail, resolveEmailTemplate } from './templates.ts'
import type { EmailJob } from './types.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

type VerificationJob = Extract<EmailJob, { type: 'channel-verification' }>

const JOB: VerificationJob = {
  type: 'channel-verification',
  to: 'oncall@example.com',
  from: 'noreply@example.com',
  verifyUrl: 'https://panel.example.com/api/client/v1/notification-channels/verify/abc?x=<y>',
  channelLabel: 'Ops "pager"',
  organizationName: 'Acme <Inc>',
  requestedByEmail: 'owner@example.com',
}

const FORBIDDEN_WORDS = /\b(console|instance|node|fleet)\b/i

test('the verification email names who asked, escapes every field and links the address', () => {
  const { subject, html, text } = createChannelVerificationEmail(JOB)
  assertEquals(subject, 'Confirm this address for TurboPanel notifications')
  assertStringIncludes(html, 'owner@example.com')
  assertStringIncludes(html, 'Acme &lt;Inc&gt;')
  assertStringIncludes(html, 'Ops &quot;pager&quot;')
  assertEquals(html.includes('<Inc>'), false)
  assertEquals(html.includes('x=<y>'), false)
  assertStringIncludes(html, 'x=&lt;y&gt;')
  assertStringIncludes(text, `${JOB.verifyUrl}`)
  assertStringIncludes(text, 'expires in one day')
})

test('a personal channel does not mention an organization', () => {
  const { text } = createChannelVerificationEmail({ ...JOB, organizationName: null })
  assertStringIncludes(text, 'send notifications to this address')
  assertEquals(text.includes(' for Acme'), false)
})

test('the verification email keeps to the product vocabulary', () => {
  const { subject, html, text } = createChannelVerificationEmail(JOB)
  for (const part of [subject, html, text]) {
    assertEquals(FORBIDDEN_WORDS.test(part), false)
  }
})

test('resolveEmailTemplate and the mailer parser both know the job type', () => {
  assertEquals(resolveEmailTemplate(JOB)?.subject, createChannelVerificationEmail(JOB).subject)
  assertEquals(parseEmailJob(JOB), JOB)
  assertEquals(parseEmailJob({ ...JOB, organizationName: null }), {
    ...JOB,
    organizationName: null,
  })
})

test('the parser refuses a verification job with a missing or mistyped field', () => {
  assertEquals(parseEmailJob({ ...JOB, verifyUrl: undefined }), null)
  assertEquals(parseEmailJob({ ...JOB, channelLabel: 3 }), null)
  assertEquals(parseEmailJob({ ...JOB, organizationName: 7 }), null)
  assertEquals(parseEmailJob({ ...JOB, organizationName: undefined }), null)
  assertEquals(parseEmailJob({ ...JOB, requestedByEmail: null }), null)
})
