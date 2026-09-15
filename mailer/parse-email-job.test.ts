import { assertEquals } from '@std/assert'
import { stub } from '@std/testing/mock'
import nodemailer from 'nodemailer'
import type { EmailJob } from '../src/lib/email/types.ts'
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

test('parseEmailJob rejects unknown types and incomplete tier-notice fields', () => {
  assertEquals(parseEmailJob(null), null)
  assertEquals(parseEmailJob({ type: 'invitation', to: 'a@b.co' }), null)
  assertEquals(parseEmailJob({ ...TIER_NOTICE_JOB, kind: 'unknown' }), null)
  assertEquals(parseEmailJob({ ...TIER_NOTICE_JOB, serverName: 1 }), null)
  assertEquals(
    parseEmailJob({ ...TIER_NOTICE_JOB, unwatched: { nics: ['eth0'] } }),
    null,
  )
  assertEquals(
    parseEmailJob({ ...INVITATION_JOB, acceptUrl: undefined }),
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
