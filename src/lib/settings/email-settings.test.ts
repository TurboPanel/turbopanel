import { describe, expect, it } from 'vitest'
import { createMailerSmtpSender } from '@turbopanel/email/smtp-sender'
import {
  resolveEmailSettings,
  resolveWorkersEmailProvider,
  isEmailActiveForRuntime,
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

  it('uses mailpit when provider is explicitly set to mailpit', async () => {
    const resolved = await resolveEmailSettings(undefined, {
      TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailpit',
    })

    expect(resolveWorkersEmailProvider(resolved)).toBe('mailpit')
  })
})

describe('isEmailActiveForRuntime', () => {
  it('treats legacy Mailgun env-only config as active on Workers', async () => {
    const resolved = await resolveEmailSettings(undefined, {
      TURBOPANEL_MAILGUN_API_KEY: 'key-abc',
      TURBOPANEL_MAILGUN_DOMAIN: 'mg.example.com',
    })

    expect(isEmailActiveForRuntime(resolved, 'workers')).toBe(true)
    expect(isEmailActiveForRuntime(resolved, 'deno')).toBe(false)
  })

  it('treats mailpit provider as active on both runtimes', async () => {
    const resolved = await resolveEmailSettings(undefined, {
      TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailpit',
    })

    expect(isEmailActiveForRuntime(resolved, 'workers')).toBe(true)
    expect(isEmailActiveForRuntime(resolved, 'deno')).toBe(true)
  })

  it('requires SMTP host and port when provider is smtp', async () => {
    const withoutSmtp = await resolveEmailSettings(undefined, {
      TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'smtp',
    })
    expect(isEmailActiveForRuntime(withoutSmtp, 'deno')).toBe(false)
    expect(isEmailActiveForRuntime(withoutSmtp, 'workers')).toBe(false)

    const withSmtp = await resolveEmailSettings(undefined, {
      TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'smtp',
      TURBOPANEL_SYSTEM_EMAIL__SMTP_HOST: '127.0.0.1',
      TURBOPANEL_SYSTEM_EMAIL__SMTP_PORT: '1025',
    })
    expect(isEmailActiveForRuntime(withSmtp, 'deno')).toBe(true)
    expect(isEmailActiveForRuntime(withSmtp, 'workers')).toBe(true)
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

  it('builds a Mailpit queue when provider is mailpit', async () => {
    const queue = await resolveWorkersEmailQueue(undefined, {
      TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailpit',
      MAILPIT_API_URL: 'http://127.0.0.1:8025',
    })

    expect(queue.constructor.name).toBe('WorkersMailpitQueue')
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
