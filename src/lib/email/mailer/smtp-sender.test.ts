import { assertEquals } from '@std/assert'
import { stub } from '@std/testing/mock'
import nodemailer from 'nodemailer'
import type { EmailJob } from '../../../features/email/types.ts'
import {
  buildSmtpTransportOptions,
  createMailerSmtpSender,
  isEncryptionUnavailableError,
  isRecipientRejected,
  MailerSmtpSender,
} from './smtp-sender.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SIGNUP_JOB: EmailJob = {
  type: 'signup-verification',
  to: 'ops@example.com',
  from: 'ignored@example.com',
  verificationUrl: 'https://panel.example.com/verify?token=abc',
}

const OTP_JOB: EmailJob = {
  type: 'email-otp',
  to: 'ops@example.com',
  from: 'ignored@example.com',
  otp: '123456',
  otpType: 'sign-in',
}

const SMTP_ENV = {
  TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'smtp',
  TURBOPANEL_SYSTEM_EMAIL__FROM: 'noreply@turbopanel.local',
  TURBOPANEL_SYSTEM_EMAIL__SMTP_HOST: '203.0.113.10',
  TURBOPANEL_SYSTEM_EMAIL__SMTP_PORT: '2525',
}

type CapturedTransport = {
  options: Record<string, unknown>
  sendMail: (mail: Record<string, unknown>) => Promise<unknown>
}

function installTransportStub(
  sendMail: (mail: Record<string, unknown>) => Promise<unknown> = () =>
    Promise.resolve({ messageId: 'test' })
): { transports: CapturedTransport[]; restore: () => void } {
  const transports: CapturedTransport[] = []
  const createStub = stub(nodemailer, 'createTransport', ((options: Record<string, unknown>) => {
    const transport = { options, sendMail }
    transports.push(transport)
    return transport
  }) as unknown as typeof nodemailer.createTransport)
  return {
    transports,
    restore: () => createStub.restore(),
  }
}

function smtpSender(env: Record<string, string | undefined> = SMTP_ENV): MailerSmtpSender {
  return createMailerSmtpSender({ db: undefined, env })
}

function assertFailure(result: { success: boolean; error?: string; permanent?: boolean }): {
  error: string
  permanent: boolean
} {
  if (result.success) throw new TypeError('expected a failed send')
  if (typeof result.error !== 'string') throw new TypeError('expected an error string')
  if (typeof result.permanent !== 'boolean') {
    throw new TypeError('expected a permanent flag')
  }
  return { error: result.error, permanent: result.permanent }
}

test('createMailerSmtpSender returns a MailerSmtpSender', () => {
  const sender = smtpSender()
  assertEquals(sender instanceof MailerSmtpSender, true)
})

test('omitted env falls back to Deno.env for SMTP delivery', async () => {
  const keys = [
    'TURBOPANEL_SYSTEM_EMAIL__PROVIDER',
    'TURBOPANEL_SYSTEM_EMAIL__FROM',
    'TURBOPANEL_SYSTEM_EMAIL__SMTP_HOST',
    'TURBOPANEL_SYSTEM_EMAIL__SMTP_PORT',
    'TURBOPANEL_SYSTEM_EMAIL__SMTP_USER',
    'TURBOPANEL_SYSTEM_EMAIL__SMTP_PASS',
  ] as const
  const previous = Object.fromEntries(keys.map((key) => [key, Deno.env.get(key)]))
  for (const [key, value] of Object.entries(SMTP_ENV)) {
    Deno.env.set(key, value)
  }
  const { restore } = installTransportStub()
  try {
    const result = await createMailerSmtpSender({ db: undefined }).sendJob(SIGNUP_JOB)
    assertEquals(result, { success: true })
  } finally {
    restore()
    for (const key of keys) {
      const value = previous[key]
      if (value === undefined) Deno.env.delete(key)
      else Deno.env.set(key, value)
    }
  }
})

test('sendJob delivers signup-verification over mailpit-smtp via nodemailer', async () => {
  const { transports, restore } = installTransportStub()
  try {
    const result = await smtpSender({
      TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailpit-smtp',
      TURBOPANEL_SYSTEM_EMAIL__FROM: 'noreply@turbopanel.local',
      TURBOPANEL_SYSTEM_EMAIL__MAILPIT_SMTP_PORT: '1025',
    }).sendJob(SIGNUP_JOB)
    assertEquals(result, { success: true })
    assertEquals(transports[0]?.options.host, '127.0.0.1')
    assertEquals(transports[0]?.options.port, 1025)
  } finally {
    restore()
  }
})

test('sendJob delivers signup-verification over configured SMTP with auth', async () => {
  const sent: Record<string, unknown>[] = []
  const { transports, restore } = installTransportStub((mail) => {
    sent.push(mail)
    return Promise.resolve({ messageId: 'ok' })
  })
  try {
    const result = await smtpSender({
      ...SMTP_ENV,
      TURBOPANEL_SYSTEM_EMAIL__SMTP_USER: 'relay',
      TURBOPANEL_SYSTEM_EMAIL__SMTP_PASS: 'relay-pass',
    }).sendJob(SIGNUP_JOB)
    assertEquals(result, { success: true })
    assertEquals(transports.length, 1)
    assertEquals(transports[0]?.options.host, '203.0.113.10')
    assertEquals(transports[0]?.options.port, 2525)
    assertEquals(transports[0]?.options.secure, false)
    assertEquals(transports[0]?.options.auth, { user: 'relay', pass: 'relay-pass' })
    assertEquals(sent[0]?.from, 'noreply@turbopanel.local')
    assertEquals(sent[0]?.to, 'ops@example.com')
    assertEquals(typeof sent[0]?.subject, 'string')
    assertEquals(typeof sent[0]?.html, 'string')
    assertEquals(typeof sent[0]?.text, 'string')
  } finally {
    restore()
  }
})

test('sendJob delivers email-otp and omits auth when credentials are blank', async () => {
  const { transports, restore } = installTransportStub()
  try {
    const result = await smtpSender({
      ...SMTP_ENV,
      TURBOPANEL_SYSTEM_EMAIL__SMTP_USER: '',
      TURBOPANEL_SYSTEM_EMAIL__SMTP_PASS: '',
    }).sendJob(OTP_JOB)
    assertEquals(result, { success: true })
    assertEquals(transports[0]?.options.auth, undefined)
  } finally {
    restore()
  }
})

test('sendJob reuses the transporter when the SMTP signature is unchanged', async () => {
  const { transports, restore } = installTransportStub()
  try {
    const sender = smtpSender()
    assertEquals(await sender.sendJob(SIGNUP_JOB), { success: true })
    assertEquals(await sender.sendJob(OTP_JOB), { success: true })
    assertEquals(transports.length, 1)
  } finally {
    restore()
  }
})

test('sendJob rebuilds the transporter when SMTP settings change', async () => {
  const { transports, restore } = installTransportStub()
  const env = { ...SMTP_ENV }
  try {
    const sender = smtpSender(env)
    assertEquals(await sender.sendJob(SIGNUP_JOB), { success: true })
    env.TURBOPANEL_SYSTEM_EMAIL__SMTP_HOST = '203.0.113.20'
    assertEquals(await sender.sendJob(OTP_JOB), { success: true })
    assertEquals(transports.length, 2)
    assertEquals(transports[1]?.options.host, '203.0.113.20')
  } finally {
    restore()
  }
})

test('sendJob falls back to Mailpit SMTP when no SMTP config is set', async () => {
  const cases: Array<{ env: Record<string, string | undefined>; port: number }> = [
    { env: { TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'smtp' }, port: 1025 },
    {
      env: {
        TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'smtp',
        TURBOPANEL_SYSTEM_EMAIL__MAILPIT_SMTP_PORT: '1125',
      },
      port: 1125,
    },
    {
      env: {
        TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'smtp',
        TURBOPANEL_SYSTEM_EMAIL__MAILPIT_SMTP_PORT: 'not-a-port',
        SMTP_PORT: '2025',
      },
      port: 2025,
    },
    {
      env: {
        TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'smtp',
        TURBOPANEL_SYSTEM_EMAIL__MAILPIT_SMTP_PORT: 'not-a-port',
        SMTP_PORT: 'also-bad',
      },
      port: 1025,
    },
  ]

  for (const { env, port } of cases) {
    const { transports, restore } = installTransportStub()
    try {
      const result = await smtpSender(env).sendJob(SIGNUP_JOB)
      assertEquals(result, { success: true })
      assertEquals(transports[0]?.options.host, 'localhost')
      assertEquals(transports[0]?.options.port, port)
      assertEquals(transports[0]?.options.tls, { rejectUnauthorized: false })
    } finally {
      restore()
    }
  }
})

test('sendJob rejects a non-smtp provider as permanent', async () => {
  const result = await smtpSender({
    TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailgun',
  }).sendJob(SIGNUP_JOB)
  const failure = assertFailure(result)
  assertEquals(failure.permanent, true)
  assertEquals(failure.error.includes('not smtp'), true)
})

test('sendJob rejects an attempted but invalid SMTP config as permanent', async () => {
  const result = await smtpSender({
    TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'smtp',
    TURBOPANEL_SYSTEM_EMAIL__SMTP_HOST: '203.0.113.10',
    TURBOPANEL_SYSTEM_EMAIL__SMTP_PORT: 'not-a-port',
  }).sendJob(SIGNUP_JOB)
  const failure = assertFailure(result)
  assertEquals(failure.permanent, true)
  assertEquals(failure.error, 'invalid SMTP configuration')
})

test('sendJob rejects unknown job types as permanent', async () => {
  const { restore } = installTransportStub()
  try {
    const result = await smtpSender().sendJob({
      type: 'not-a-real-type',
      to: 'ops@example.com',
      from: 'noreply@example.com',
    } as unknown as EmailJob)
    const failure = assertFailure(result)
    assertEquals(failure.permanent, true)
    assertEquals(failure.error.includes('unknown job type'), true)
  } finally {
    restore()
  }
})

test('sendJob rejects a malformed from address as permanent', async () => {
  const result = await smtpSender({
    ...SMTP_ENV,
    TURBOPANEL_SYSTEM_EMAIL__FROM: 'not-an-email',
  }).sendJob(SIGNUP_JOB)
  const failure = assertFailure(result)
  assertEquals(failure.permanent, true)
  assertEquals(failure.error.includes('malformed from address'), true)
})

test('sendJob classifies SMTP transport errors', async () => {
  const cases: Array<{ thrown: unknown; permanent: boolean; error: string }> = [
    {
      thrown: Object.assign(new Error('mailbox gone'), { responseCode: 550 }),
      permanent: true,
      error: 'mailbox gone',
    },
    {
      thrown: Object.assign(new Error('bad envelope'), { code: 'EENVELOPE' }),
      permanent: true,
      error: 'bad envelope',
    },
    {
      thrown: Object.assign(new Error('auth failed'), { code: 'EAUTH' }),
      permanent: true,
      error: 'auth failed',
    },
    {
      thrown: Object.assign(new Error('api rejected'), { command: 'API' }),
      permanent: true,
      error: 'api rejected',
    },
    {
      thrown: Object.assign(new Error('auth command'), { command: 'AUTH' }),
      permanent: true,
      error: 'auth command',
    },
    {
      thrown: Object.assign(new Error('try later'), { responseCode: 421 }),
      permanent: false,
      error: 'try later',
    },
    { thrown: new Error('connection reset'), permanent: false, error: 'connection reset' },
    { thrown: 'smtp down', permanent: false, error: 'smtp down' },
    { thrown: 42, permanent: false, error: '42' },
  ]

  for (const { thrown, permanent, error } of cases) {
    const { restore } = installTransportStub(() => Promise.reject(thrown))
    try {
      const result = await smtpSender().sendJob(OTP_JOB)
      const failure = assertFailure(result)
      assertEquals(failure.permanent, permanent)
      assertEquals(failure.error, error)
    } finally {
      restore()
    }
  }
})

test('sendJob treats a throwing settings db as a transient failure', async () => {
  const db = {
    select: () => {
      throw new Error('db down')
    },
  }
  const result = await createMailerSmtpSender({
    db: db as never,
    env: SMTP_ENV,
  }).sendJob(SIGNUP_JOB)
  const failure = assertFailure(result)
  assertEquals(failure.permanent, false)
  assertEquals(failure.error, 'db down')
})

test('only a refused recipient with a dead-address status code counts as rejected', () => {
  const refused = (response: string, responseCode = 550, command = 'RCPT TO') =>
    Object.assign(new Error('refused'), { response, responseCode, command })
  // Unknown mailbox or domain, on one line or spread over a multi-line reply.
  assertEquals(isRecipientRejected(refused('550 5.1.1 <a@example.com>: User unknown')), true)
  assertEquals(
    isRecipientRejected(
      refused('550-5.1.1 The address does not exist.\n550 5.1.1 Check for typos.')
    ),
    true
  )
  assertEquals(isRecipientRejected(refused('550 5.1.2 Host unknown')), true)
  assertEquals(isRecipientRejected(refused('551 5.1.6 User has moved')), true)
  assertEquals(isRecipientRejected(refused('553 5.1.3 Bad recipient address syntax')), true)
  // A policy or relay refusal says nothing about the address.
  assertEquals(isRecipientRejected(refused('550 5.7.1 Relaying denied')), false)
  assertEquals(
    isRecipientRejected(refused('550 5.7.26 Unauthenticated email is not accepted')),
    false
  )
  // A bare 550 with no enhanced code, a sender-address code, another command, another code.
  assertEquals(isRecipientRejected(refused('550 Mailbox unavailable')), false)
  assertEquals(isRecipientRejected(refused('550 5.1.8 Sender address rejected')), false)
  assertEquals(isRecipientRejected(refused('550 5.1.1 no', 550, 'MAIL FROM')), false)
  assertEquals(isRecipientRejected(refused('450 4.1.1 try later', 450)), false)
  assertEquals(
    isRecipientRejected(
      Object.assign(new Error('no reply text'), { responseCode: 550, command: 'RCPT TO' })
    ),
    false
  )
  assertEquals(isRecipientRejected(null), false)
})

test('transport options follow the encryption mode and port', () => {
  const opts = (security: 'auto' | 'tls' | 'starttls' | 'none', port: number) =>
    buildSmtpTransportOptions({ host: 'mail.example.com', port, security })
  assertEquals(opts('auto', 465).secure, true)
  assertEquals(opts('auto', 587).secure, false)
  assertEquals(opts('auto', 587).requireTLS, true)
  assertEquals(opts('tls', 587).secure, true)
  assertEquals(opts('starttls', 465).requireTLS, true)
  assertEquals(opts('none', 25).ignoreTLS, true)
  assertEquals(opts('none', 25).requireTLS, undefined)
  for (const mode of ['auto', 'tls', 'starttls', 'none'] as const) {
    assertEquals('tls' in opts(mode, 587), false)
  }
})

test('mailpit transport keeps its plain legacy options', () => {
  const co = buildSmtpTransportOptions({ host: '127.0.0.1', port: 1025 })
  assertEquals(co.secure, false)
  assertEquals(co.requireTLS, undefined)
  assertEquals(co.ignoreTLS, undefined)
})

test('sendJob builds a STARTTLS-required transport by default and a new one when the mode changes', async () => {
  const { transports, restore } = installTransportStub()
  try {
    await smtpSender().sendJob(SIGNUP_JOB)
    assertEquals(transports[0]?.options.requireTLS, true)
    const sender = smtpSender({ ...SMTP_ENV, TURBOPANEL_SYSTEM_EMAIL__SMTP_SECURITY: 'none' })
    await sender.sendJob(SIGNUP_JOB)
    assertEquals(transports[1]?.options.ignoreTLS, true)
  } finally {
    restore()
  }
})

test('transport cache is keyed by the encryption mode', async () => {
  const env: Record<string, string | undefined> = { ...SMTP_ENV }
  const { transports, restore } = installTransportStub()
  try {
    const sender = smtpSender(env)
    await sender.sendJob(SIGNUP_JOB)
    await sender.sendJob(SIGNUP_JOB)
    assertEquals(transports.length, 1)
    env.TURBOPANEL_SYSTEM_EMAIL__SMTP_SECURITY = 'tls'
    await sender.sendJob(SIGNUP_JOB)
    assertEquals(transports.length, 2)
    assertEquals(transports[1]?.options.secure, true)
  } finally {
    restore()
  }
})

test('a server that cannot do the required encryption is a permanent, clear error', async () => {
  const refused = Object.assign(new Error('Error upgrading connection with STARTTLS'), {
    code: 'ETLS',
    command: 'STARTTLS',
    responseCode: 502,
  })
  const { restore } = installTransportStub(() => Promise.reject(refused))
  try {
    const failure = assertFailure(await smtpSender().sendJob(SIGNUP_JOB))
    assertEquals(failure.permanent, true)
    assertEquals(failure.error.startsWith('the mail server did not offer encryption'), true)
  } finally {
    restore()
  }
})

test('encryption errors: only refusals and certificate or protocol failures are permanent', () => {
  const tls = (message: string, command: string, responseCode?: number) =>
    Object.assign(new Error(message), { code: 'ETLS', command, responseCode })
  assertEquals(isEncryptionUnavailableError(tls('x', 'STARTTLS', 554)), true)
  assertEquals(isEncryptionUnavailableError(tls('x', 'STARTTLS', 454)), false)
  assertEquals(
    isEncryptionUnavailableError(tls('Error initiating TLS - wrong version number', 'CONN')),
    true
  )
  assertEquals(
    isEncryptionUnavailableError(tls('Error initiating TLS - self-signed certificate', 'STARTTLS')),
    true
  )
  assertEquals(isEncryptionUnavailableError(tls('Connection closed unexpectedly', 'CONN')), false)
  assertEquals(
    isEncryptionUnavailableError(Object.assign(new Error('x'), { code: 'ESOCKET' })),
    false
  )
})
