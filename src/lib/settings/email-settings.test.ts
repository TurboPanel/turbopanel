import { describe, expect, it } from 'vitest'
import { createMailerSmtpSender } from '@turbopanel/email/smtp-sender'
import {
  emailSettingsToApiShape,
  isEmailActiveForRuntime,
  resolveEmailSettings,
  SYSTEM_EMAIL_DB_KEY,
  updateEmailSettings,
} from './email-settings.ts'
import { resolveWorkersEmailQueue } from '../email/mailgun/workers-queue.ts'
import {
  isSealedEnvelope,
  parseSecretEnvelope,
} from '../../client/authn/data-encryption.ts'
import {
  deriveEncryptionSecretsConfig,
  parseSecretsEnv,
} from '../../client/authn/secrets.ts'
import { reencryptAtRestSecrets } from '../../admin/reencrypt-secrets.ts'
import { setting } from '../db/schema.ts'
import type { Db } from '../../db.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'

const V1_SECRET = TEST_ONLY_TURBOPANEL_SECRET
const V2_SECRET = 'Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll2_Mm3Nn4Oo5Pp6Qq7'

async function deriveDataEncryptionSecrets(secretsList: string) {
  const config = parseSecretsEnv(undefined, secretsList, 'workers')
  return deriveEncryptionSecretsConfig(config, 'data-encryption')
}

/**
 * Minimal in-memory stand-in for the drizzle `Db` covering only the `setting`
 * table chains used by `updateEmailSettings` / `resolveEmailSettings` /
 * `reencryptAtRestSecrets`. Other tables resolve to empty result sets so the
 * unrelated re-encrypt sweeps short-circuit.
 */
function createFakeSettingDb() {
  let stored: Record<string, unknown> | undefined

  const makeSelect = () => {
    let target: unknown = null
    const builder = {
      from(table: unknown) {
        target = table
        return builder
      },
      where() {
        return builder
      },
      for() {
        return builder
      },
      orderBy() {
        return builder
      },
      limit(): Promise<Array<{ value: unknown }>> {
        if (target === setting && stored !== undefined) {
          return Promise.resolve([{ value: stored }])
        }
        return Promise.resolve([])
      },
    }
    return builder
  }

  const db = {
    select() {
      return makeSelect()
    },
    insert(table: unknown) {
      return {
        values(row: { key: string; value: Record<string, unknown> }) {
          return {
            onConflictDoUpdate() {
              if (table === setting) stored = row.value
              return Promise.resolve(undefined)
            },
          }
        },
      }
    },
    update(table: unknown) {
      const builder = {
        set(values: { value?: Record<string, unknown> }) {
          if (table === setting && values.value) stored = values.value
          return builder
        },
        where() {
          return builder
        },
        returning(): Promise<Array<{ key: string }>> {
          return Promise.resolve([{ key: SYSTEM_EMAIL_DB_KEY }])
        },
      }
      return builder
    },
    delete(table: unknown) {
      return {
        where() {
          if (table === setting) stored = undefined
          return Promise.resolve(undefined)
        },
      }
    },
    transaction(fn: (tx: unknown) => Promise<unknown>) {
      return fn(db)
    },
    getStored(): Record<string, unknown> | undefined {
      return stored
    },
    seedStored(value: Record<string, unknown>) {
      stored = value
    },
  }
  return db
}

describe('Workers SMTP sender alias', () => {
  it('resolves smtp sender imports to the Workers shim', () => {
    expect(() => createMailerSmtpSender({ db: undefined })).toThrow(
      'SMTP not available on Workers',
    )
  })
})

describe('isEmailActiveForRuntime', () => {
  it('treats explicit mailgun provider as active when credentials are configured', async () => {
    const resolved = await resolveEmailSettings(undefined, {
      TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailgun',
      TURBOPANEL_SYSTEM_EMAIL__MAILGUN_API_KEY: 'key-abc',
      TURBOPANEL_SYSTEM_EMAIL__MAILGUN_DOMAIN: 'mg.example.com',
    })

    expect(isEmailActiveForRuntime(resolved, 'workers')).toBe(true)
    expect(isEmailActiveForRuntime(resolved, 'deno')).toBe(true)
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
  it('builds a Mailgun queue when provider is mailgun with credentials', async () => {
    const queue = await resolveWorkersEmailQueue(undefined, {
      TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailgun',
      TURBOPANEL_SYSTEM_EMAIL__MAILGUN_API_KEY: 'key-abc',
      TURBOPANEL_SYSTEM_EMAIL__MAILGUN_DOMAIN: 'mg.example.com',
    })

    expect(queue.constructor.name).toBe('WorkersMailgunQueue')
  })

  it('returns a noop queue when provider is explicitly smtp', async () => {
    const queue = await resolveWorkersEmailQueue(undefined, {
      TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'smtp',
      TURBOPANEL_SYSTEM_EMAIL__SMTP_HOST: '127.0.0.1',
      TURBOPANEL_SYSTEM_EMAIL__SMTP_PORT: '1025',
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

  it('honors TURBOPANEL_SYSTEM_EMAIL__RATE_LIMIT_* settings', async () => {
    const resolved = await resolveEmailSettings(undefined, {
      TURBOPANEL_SYSTEM_EMAIL__RATE_LIMIT_PER_MINUTE: '120',
      TURBOPANEL_SYSTEM_EMAIL__RATE_LIMIT_BURST: '200',
      TURBOPANEL_SYSTEM_EMAIL__QUEUE_PREFETCH: '5',
    })
    expect(resolved.keys.RATE_LIMIT_PER_MINUTE.value).toBe('120')
    expect(resolved.keys.RATE_LIMIT_BURST.value).toBe('200')
    expect(resolved.keys.QUEUE_PREFETCH.value).toBe('5')
  })
})

describe('DB-backed email secret encryption', () => {
  const MAILGUN_KEY = 'mailgun-super-secret-key'
  const SMTP_PASS = 'smtp-super-secret-password'

  it('seals MAILGUN_API_KEY / SMTP_PASS at rest but resolves plaintext in-process', async () => {
    const secrets = await deriveDataEncryptionSecrets(`1:${V1_SECRET}`)
    const fakeDb = createFakeSettingDb()

    const resolved = await updateEmailSettings(
      fakeDb as unknown as Db,
      {},
      {
        TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailgun',
        TURBOPANEL_SYSTEM_EMAIL__MAILGUN_API_KEY: MAILGUN_KEY,
        TURBOPANEL_SYSTEM_EMAIL__MAILGUN_DOMAIN: 'mg.example.com',
        TURBOPANEL_SYSTEM_EMAIL__SMTP_PASS: SMTP_PASS,
      },
      secrets,
    )

    const stored = fakeDb.getStored() as Record<string, string>
    // Stored secret values are sealed envelopes, never plaintext.
    expect(stored.MAILGUN_API_KEY).not.toContain(MAILGUN_KEY)
    expect(stored.SMTP_PASS).not.toContain(SMTP_PASS)
    expect(isSealedEnvelope(stored.MAILGUN_API_KEY)).toBe(true)
    expect(isSealedEnvelope(stored.SMTP_PASS)).toBe(true)
    // Non-secret keys stay plaintext.
    expect(stored.MAILGUN_DOMAIN).toBe('mg.example.com')

    // The update result and a fresh resolve both decrypt back to plaintext.
    expect(resolved.mailgunApiKey).toBe(MAILGUN_KEY)
    const reResolved = await resolveEmailSettings(fakeDb as unknown as Db, {}, secrets)
    expect(reResolved.mailgunApiKey).toBe(MAILGUN_KEY)
    expect(reResolved.keys.SMTP_PASS.value).toBe(SMTP_PASS)
  })

  it('masks DB secret values in emailSettingsToApiShape()', async () => {
    const secrets = await deriveDataEncryptionSecrets(`1:${V1_SECRET}`)
    const fakeDb = createFakeSettingDb()

    await updateEmailSettings(
      fakeDb as unknown as Db,
      {},
      {
        TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailgun',
        TURBOPANEL_SYSTEM_EMAIL__MAILGUN_API_KEY: MAILGUN_KEY,
        TURBOPANEL_SYSTEM_EMAIL__SMTP_PASS: SMTP_PASS,
      },
      secrets,
    )

    const resolved = await resolveEmailSettings(fakeDb as unknown as Db, {}, secrets)
    const api = emailSettingsToApiShape(resolved)
    expect(api.TURBOPANEL_SYSTEM_EMAIL__MAILGUN_API_KEY).toEqual({
      source: 'db',
      value: '***',
    })
    expect(api.TURBOPANEL_SYSTEM_EMAIL__SMTP_PASS).toEqual({
      source: 'db',
      value: '***',
    })
  })

  it('re-encrypts stored email secrets after key rotation', async () => {
    const v1 = await deriveDataEncryptionSecrets(`1:${V1_SECRET}`)
    const rotated = await deriveDataEncryptionSecrets(`2:${V2_SECRET},1:${V1_SECRET}`)
    const fakeDb = createFakeSettingDb()

    await updateEmailSettings(
      fakeDb as unknown as Db,
      {},
      {
        TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailgun',
        TURBOPANEL_SYSTEM_EMAIL__MAILGUN_API_KEY: MAILGUN_KEY,
        TURBOPANEL_SYSTEM_EMAIL__SMTP_PASS: SMTP_PASS,
      },
      v1,
    )

    const before = fakeDb.getStored() as Record<string, string>
    expect(parseSecretEnvelope(before.MAILGUN_API_KEY)?.keyVersion).toBe(1)
    expect(parseSecretEnvelope(before.SMTP_PASS)?.keyVersion).toBe(1)

    const summary = await reencryptAtRestSecrets(fakeDb as unknown as Db, rotated)
    expect(summary.reencrypted).toBe(2)

    const after = fakeDb.getStored() as Record<string, string>
    expect(parseSecretEnvelope(after.MAILGUN_API_KEY)?.keyVersion).toBe(2)
    expect(parseSecretEnvelope(after.SMTP_PASS)?.keyVersion).toBe(2)

    const afterResolved = await resolveEmailSettings(fakeDb as unknown as Db, {}, rotated)
    expect(afterResolved.mailgunApiKey).toBe(MAILGUN_KEY)
    expect(afterResolved.keys.SMTP_PASS.value).toBe(SMTP_PASS)
  })

  it('keeps env-var secrets masked without decryption', async () => {
    const resolved = await resolveEmailSettings(undefined, {
      TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailgun',
      TURBOPANEL_SYSTEM_EMAIL__MAILGUN_API_KEY: 'env-key',
      TURBOPANEL_SYSTEM_EMAIL__MAILGUN_DOMAIN: 'mg.example.com',
    })
    // Env-provided secret is usable in-process but masked in the API shape.
    expect(resolved.mailgunApiKey).toBe('env-key')
    const api = emailSettingsToApiShape(resolved)
    expect(api.TURBOPANEL_SYSTEM_EMAIL__MAILGUN_API_KEY).toEqual({
      source: 'env',
      value: null,
    })
  })

  it('does not activate plaintext DB secret values', async () => {
    const secrets = await deriveDataEncryptionSecrets(`1:${V1_SECRET}`)
    const fakeDb = createFakeSettingDb()
    fakeDb.seedStored({
      PROVIDER: 'mailgun',
      MAILGUN_API_KEY: 'plaintext-mailgun-key',
      MAILGUN_DOMAIN: 'mg.example.com',
      SMTP_PASS: 'plaintext-smtp-pass',
    })

    const resolved = await resolveEmailSettings(
      fakeDb as unknown as Db,
      {},
      secrets,
    )

    expect(resolved.mailgunApiKey).toBeUndefined()
    expect(resolved.keys.MAILGUN_API_KEY.source).toBe('default')
    expect(resolved.keys.MAILGUN_API_KEY.value).toBe('')
    expect(resolved.keys.SMTP_PASS.source).toBe('default')
    expect(resolved.keys.SMTP_PASS.value).toBe('')
    expect(isEmailActiveForRuntime(resolved, 'workers')).toBe(false)
    expect(isEmailActiveForRuntime(resolved, 'deno')).toBe(false)
  })
})
