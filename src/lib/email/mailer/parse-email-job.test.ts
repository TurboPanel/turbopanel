import { assertEquals } from '@std/assert'
import { stub } from '@std/testing/mock'
import nodemailer from 'nodemailer'
import type { EmailJob } from '../../../features/email/types.ts'
import { parseEmailJob } from './parse-email-job.ts'
import { createMailerSmtpSender } from './smtp-sender.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SMTP_ENV = {
  TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'smtp',
  TURBOPANEL_SYSTEM_EMAIL__FROM: 'noreply@turbopanel.local',
  TURBOPANEL_SYSTEM_EMAIL__SMTP_HOST: '203.0.113.10',
  TURBOPANEL_SYSTEM_EMAIL__SMTP_PORT: '2525',
}

const TIER_NOTICE_JOB: EmailJob = {
  type: 'server-tier-notice',
  to: 'ops@example.com',
  from: 'noreply@example.com',
  kind: 'exceeds',
  serverName: 'edge-1',
  organizationName: 'Acme',
  licenseTierLabel: 'S1',
  requiredTierLabel: 'S3',
  recommendedTierLabel: 'S3',
  unwatched: { nics: ['eth1'], drives: [], gpus: [] },
  consoleUrl: 'https://panel.example.com/org/overview',
}

const INVITATION_JOB: EmailJob = {
  type: 'invitation',
  to: 'invitee@example.com',
  from: 'noreply@example.com',
  inviterEmail: 'owner@example.com',
  organizationName: 'Acme',
  teamName: 'Ops',
  acceptUrl: 'https://panel.example.com/accept-invitation?id=abc',
}

test('parseEmailJob accepts a server-tier-notice payload', () => {
  assertEquals(parseEmailJob(TIER_NOTICE_JOB), TIER_NOTICE_JOB)
  assertEquals(
    parseEmailJob({ ...TIER_NOTICE_JOB, kind: 'overprovisioned' }),
    { ...TIER_NOTICE_JOB, kind: 'overprovisioned' },
  )
})

test('parseEmailJob accepts an invitation payload', () => {
  assertEquals(parseEmailJob(INVITATION_JOB), INVITATION_JOB)
})

const NOTIFICATION_JOB: EmailJob = {
  type: 'notification',
  to: 'ops@example.com',
  from: 'noreply@example.com',
  event: 'server.offline',
  severity: 'critical',
  title: 'Server db-1 went offline',
  body: 'The daemon stopped answering.',
  details: ['serverName=db-1'],
  organizationName: 'Acme',
  consoleUrl: 'https://panel.example.com/org/servers/s1',
  at: '2026-09-18T10:00:00.000Z',
}

test('parseEmailJob accepts a notification payload and refuses a malformed one', () => {
  assertEquals(parseEmailJob(NOTIFICATION_JOB), NOTIFICATION_JOB)
  assertEquals(
    parseEmailJob({ ...NOTIFICATION_JOB, body: null, consoleUrl: null, organizationName: null }),
    { ...NOTIFICATION_JOB, body: null, consoleUrl: null, organizationName: null },
  )
  assertEquals(parseEmailJob({ ...NOTIFICATION_JOB, severity: 'loud' }), null)
  assertEquals(parseEmailJob({ ...NOTIFICATION_JOB, details: 'serverName=db-1' }), null)
})

const SIGNUP_JOB: EmailJob = {
  type: 'signup-verification',
  to: 'new@example.com',
  from: 'noreply@example.com',
  verificationUrl: 'https://panel.example.com/verify?t=abc',
}

const OTP_JOB: EmailJob = {
  type: 'email-otp',
  to: 'ops@example.com',
  from: 'noreply@example.com',
  otp: '123456',
  otpType: 'sign-in',
}

test('parseEmailJob accepts signup-verification and email-otp payloads', () => {
  assertEquals(parseEmailJob(SIGNUP_JOB), SIGNUP_JOB)
  assertEquals(parseEmailJob(OTP_JOB), OTP_JOB)
  assertEquals(
    parseEmailJob({ ...OTP_JOB, otpType: 'email-verification' }),
    { ...OTP_JOB, otpType: 'email-verification' },
  )
  assertEquals(
    parseEmailJob({ ...OTP_JOB, otpType: 'forget-password' }),
    { ...OTP_JOB, otpType: 'forget-password' },
  )
})

test('parseEmailJob rejects unknown types and incomplete payloads', () => {
  assertEquals(parseEmailJob(null), null)
  assertEquals(parseEmailJob({ type: 'invitation', to: 'a@b.co' }), null)
  assertEquals(parseEmailJob({ ...TIER_NOTICE_JOB, kind: 'unknown' }), null)
  assertEquals(parseEmailJob({ ...TIER_NOTICE_JOB, serverName: 1 }), null)
  assertEquals(
    parseEmailJob({ ...TIER_NOTICE_JOB, unwatched: { nics: ['eth0'] } }),
    null,
  )
  assertEquals(parseEmailJob({ ...TIER_NOTICE_JOB, unwatched: 'eth0' }), null)
  assertEquals(
    parseEmailJob({ ...INVITATION_JOB, acceptUrl: undefined }),
    null,
  )
  assertEquals(parseEmailJob({ ...INVITATION_JOB, inviterEmail: 1 }), null)
  assertEquals(parseEmailJob({ ...INVITATION_JOB, organizationName: 1 }), null)
  assertEquals(parseEmailJob({ ...INVITATION_JOB, teamName: 1 }), null)
  assertEquals(parseEmailJob({ ...SIGNUP_JOB, verificationUrl: 1 }), null)
  assertEquals(parseEmailJob({ ...OTP_JOB, otp: 123456 }), null)
  assertEquals(parseEmailJob({ ...OTP_JOB, otpType: 'sms' }), null)
  assertEquals(parseEmailJob({ ...NOTIFICATION_JOB, event: 1 }), null)
  assertEquals(parseEmailJob({ ...NOTIFICATION_JOB, title: 1 }), null)
  assertEquals(parseEmailJob({ ...NOTIFICATION_JOB, body: 1 }), null)
  assertEquals(parseEmailJob({ ...NOTIFICATION_JOB, organizationName: 1 }), null)
  assertEquals(parseEmailJob({ ...NOTIFICATION_JOB, consoleUrl: 1 }), null)
  assertEquals(parseEmailJob({ ...NOTIFICATION_JOB, at: 1 }), null)
  assertEquals(
    parseEmailJob({ type: 'carrier-pigeon', to: 'a@b.co', from: 'c@d.co' }),
    null,
  )
})

test('parsed server-tier-notice and invitation jobs dispatch through the SMTP sender', async () => {
  const sent: Array<{ to?: unknown; subject?: unknown }> = []
  const createStub = stub(
    nodemailer,
    'createTransport',
    (() => ({
      sendMail: (mail: { to?: unknown; subject?: unknown }) => {
        sent.push(mail)
        return Promise.resolve({ messageId: 'ok' })
      },
    })) as typeof nodemailer.createTransport,
  )
  try {
    const sender = createMailerSmtpSender({ db: undefined, env: SMTP_ENV })
    const tierNotice = parseEmailJob(TIER_NOTICE_JOB)
    const invitation = parseEmailJob(INVITATION_JOB)
    if (!tierNotice || !invitation) {
      throw new TypeError('expected both job types to parse')
    }
    assertEquals(await sender.sendJob(tierNotice), { success: true })
    assertEquals(await sender.sendJob(invitation), { success: true })
    assertEquals(sent.length, 2)
    assertEquals(sent[0]?.to, TIER_NOTICE_JOB.to)
    assertEquals(sent[1]?.to, INVITATION_JOB.to)
    assertEquals(typeof sent[0]?.subject, 'string')
    assertEquals(typeof sent[1]?.subject, 'string')
  } finally {
    createStub.restore()
  }
})
