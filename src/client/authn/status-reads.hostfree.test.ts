import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import { resolveConfiguredProviders } from '../../features/settings/auth-provider-settings.ts'
import { resolveEmailActivePresence } from '../../features/settings/email-settings.ts'
import { getClientPublicStatus, resolveEffectiveSignupEnabled } from './install-state.ts'

/** Collect bound parameter values from a drizzle `where` condition. */
function paramValues(node: unknown, out: unknown[] = []): unknown[] {
  if (node === null || typeof node !== 'object') return out
  const chunks = (node as { queryChunks?: unknown[] }).queryChunks
  if (Array.isArray(chunks)) {
    for (const chunk of chunks) paramValues(chunk, out)
  } else if ('value' in node && 'encoder' in node) {
    out.push((node as { value: unknown }).value)
  }
  return out
}

/** Fake `Db` that answers `setting` reads by key and counts them. */
function fakeSettingDb(rows: Record<string, unknown>) {
  const reads: string[] = []
  const db = {
    select() {
      let key = ''
      const builder = {
        from: () => builder,
        where(cond: unknown) {
          key = String(paramValues(cond)[0])
          return builder
        },
        limit() {
          reads.push(key)
          return Promise.resolve(key in rows ? [{ value: rows[key] }] : [])
        },
      }
      return builder
    },
  }
  return { db: db as unknown as Db, reads }
}

const scenarios: Array<{ name: string; rows: Record<string, unknown> }> = [
  { name: 'empty settings', rows: {} },
  {
    name: 'signup on, mailgun and github configured',
    rows: {
      IS_SIGNUP_ENABLED: '1',
      SYSTEM_EMAIL: {
        PROVIDER: 'mailgun',
        MAILGUN_DOMAIN: 'mg.example.net',
        MAILGUN_API_KEY: 'enc:v1:1:sealed',
      },
      SYSTEM_AUTH_PROVIDERS: { GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'enc:v1:1:sealed' },
    },
  },
  { name: 'signup off only', rows: { IS_SIGNUP_ENABLED: '0' } },
]

for (const { name, rows } of scenarios) {
  Deno.test(`workers /status matches the sequential reads: ${name}`, async () => {
    const sequential = fakeSettingDb(rows)
    const expected = {
      isSignupEnabled: await resolveEffectiveSignupEnabled(sequential.db, 'workers', undefined),
      isSignupEmailVerificationEnabled: await resolveEmailActivePresence(
        sequential.db,
        {},
        'workers'
      ),
      authProviders: await resolveConfiguredProviders(sequential.db, {}),
    }
    const together = fakeSettingDb(rows)
    const actual = await getClientPublicStatus(together.db, 'workers', undefined, {}, true)
    assertEquals(actual, { ok: true, runtime: 'workers', ...expected, billingEnabled: true })
    assertEquals([...together.reads].sort(), [...sequential.reads].sort())
  })
}
