import { describe, expect, it } from 'vitest'
import { createMailerSmtpSender } from '@turbopanel/email/smtp-sender'
import {
  resolveEmailSettings,
  resolveWorkersEmailProvider,
} from './email-settings.ts'
import { resolveWorkersEmailQueue } from '../email/mailgun/workers-queue.ts'

describe('Workers SMTP sender alias', () => {
  it('resolves smtp sender imports to the Workers shim', () => {
    expect(() => createMailerSmtpSender({ db: undefined })).toThrow(
      'SMTP not available on Workers',
    )
  })
})

describe('resolveWorkersEmailProvider', () => {
  it('treats legacy Mailgun env vars as mailgun when provider is unset', async () => {
    const resolved = await resolveEmailSettings(undefined, {
      TURBOPANEL_MAILGUN_API_KEY: 'key-abc',
      TURBOPANEL_MAILGUN_DOMAIN: 'mg.example.com',
    })

    expect(resolved.provider).toBe('smtp')
    expect(resolved.keys.PROVIDER.source).toBe('default')
    expect(resolveWorkersEmailProvider(resolved)).toBe('mailgun')
  })

  it('honors explicit smtp provider even when Mailgun credentials are present', async () => {
    const resolved = await resolveEmailSettings(undefined, {
      TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'smtp',
      TURBOPANEL_MAILGUN_API_KEY: 'key-abc',
      TURBOPANEL_MAILGUN_DOMAIN: 'mg.example.com',
    })

    expect(resolveWorkersEmailProvider(resolved)).toBe('smtp')
  })

  it('uses mailgun when provider is explicitly set to mailgun', async () => {
    const resolved = await resolveEmailSettings(undefined, {
      TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailgun',
      TURBOPANEL_MAILGUN_API_KEY: 'key-abc',
      TURBOPANEL_MAILGUN_DOMAIN: 'mg.example.com',
    })

    expect(resolveWorkersEmailProvider(resolved)).toBe('mailgun')
  })
})

describe('resolveWorkersEmailQueue', () => {
  it('builds a Mailgun queue for legacy Mailgun env vars without explicit provider', async () => {
    const queue = await resolveWorkersEmailQueue(undefined, {
      TURBOPANEL_MAILGUN_API_KEY: 'key-abc',
      TURBOPANEL_MAILGUN_DOMAIN: 'mg.example.com',
    })

    expect(queue.constructor.name).toBe('WorkersMailgunQueue')
  })

  it('returns a noop queue when provider is explicitly smtp', async () => {
    const queue = await resolveWorkersEmailQueue(undefined, {
      TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'smtp',
      TURBOPANEL_MAILGUN_API_KEY: 'key-abc',
      TURBOPANEL_MAILGUN_DOMAIN: 'mg.example.com',
    })

    expect(queue.constructor.name).toBe('NoopQueue')
  })
})

describe('rate limit and prefetch settings keys', () => {
  it('exposes RATE_LIMIT_PER_MINUTE, RATE_LIMIT_BURST, QUEUE_PREFETCH with expected defaults', async () => {
    const resolved = await resolveEmailSettings(undefined, {})
    expect(resolved.keys.RATE_LIMIT_PER_MINUTE.value).toBe('60')
    expect(resolved.keys.RATE_LIMIT_BURST.value).toBe('60')
    expect(resolved.keys.QUEUE_PREFETCH.value).toBe('1')
  })

  it('resolves RATE_LIMIT_BURST to the per-minute rate when unset', async () => {
    const resolved = await resolveEmailSettings(undefined, {
      TURBOPANEL_SYSTEM_EMAIL__RATE_LIMIT_PER_MINUTE: '30',
    })
    expect(resolved.keys.RATE_LIMIT_BURST.value).toBe('30')
  })

  it('honors an explicit burst lower than the per-minute rate', async () => {
    const resolved = await resolveEmailSettings(undefined, {
      TURBOPANEL_SYSTEM_EMAIL__RATE_LIMIT_PER_MINUTE: '100',
      TURBOPANEL_SYSTEM_EMAIL__RATE_LIMIT_BURST: '20',
    })
    expect(resolved.keys.RATE_LIMIT_BURST.value).toBe('20')
  })

  it('honors TURBOPANEL_SYSTEM_EMAIL__MAILGUN_REGION=eu', async () => {
    const resolved = await resolveEmailSettings(undefined, {
      TURBOPANEL_SYSTEM_EMAIL__MAILGUN_REGION: 'eu',
    })
    expect(resolved.mailgunRegion).toBe('eu')
    expect(resolved.mailgunApiBase).toBe('https://api.eu.mailgun.net/v3')
  })

  it('defaults Mailgun region to US API base', async () => {
    const resolved = await resolveEmailSettings(undefined, {})
    expect(resolved.mailgunRegion).toBe('us')
    expect(resolved.mailgunApiBase).toBe('https://api.mailgun.net/v3')
  })

  it('honors TURBOPANEL_SYSTEM_EMAIL__RATE_LIMIT_* and legacy alias for per-minute', async () => {
    const resolved = await resolveEmailSettings(undefined, {
      TURBOPANEL_SYSTEM_EMAIL__RATE_LIMIT_PER_MINUTE: '120',
      TURBOPANEL_SYSTEM_EMAIL__RATE_LIMIT_BURST: '200',
      TURBOPANEL_SYSTEM_EMAIL__QUEUE_PREFETCH: '5',
    })
    expect(resolved.keys.RATE_LIMIT_PER_MINUTE.value).toBe('120')
    expect(resolved.keys.RATE_LIMIT_BURST.value).toBe('200')
    expect(resolved.keys.QUEUE_PREFETCH.value).toBe('5')
  })

  it('legacy TURBOPANEL_MAILER_RATE_LIMIT_PER_MINUTE aliases into RATE_LIMIT_PER_MINUTE', async () => {
    const resolved = await resolveEmailSettings(undefined, {
      TURBOPANEL_MAILER_RATE_LIMIT_PER_MINUTE: '30',
    })
    expect(resolved.keys.RATE_LIMIT_PER_MINUTE.value).toBe('30')
  })
})
