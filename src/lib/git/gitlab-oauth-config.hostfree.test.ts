/**
 * Host-free coverage for GitLab OAuth config helpers (mock Db).
 */

import { assertEquals, assertRejects } from '@std/assert'
import type { Db } from '../../db.ts'
import {
  GITLAB_DEFAULT_BASE_URL,
  GITLAB_OAUTH_SETTING_KEY,
  GitlabOauthConfigError,
  getGitlabOauthConfigSummary,
  setGitlabOauthConfig,
} from './gitlab-oauth-config.ts'
import type { DerivedSecretsConfig } from '../../client/authn/secrets.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const secrets = {
  current: { version: 1, key: new Uint8Array(32) },
} as unknown as DerivedSecretsConfig

function mockSettingDb(value: unknown): Db & { deleted: boolean } {
  let deleted = false
  const db = {
    get deleted() {
      return deleted
    },
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(value === undefined ? [] : [{ value }]),
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: () => Promise.resolve(undefined),
      }),
    }),
    delete: () => ({
      where: () => {
        deleted = true
        return Promise.resolve(undefined)
      },
    }),
  }
  return db as unknown as Db & { deleted: boolean }
}

test('getGitlabOauthConfigSummary normalizes baseUrl and reports secrets', async () => {
  const db = mockSettingDb({
    clientId: 'gitlab-client',
    redirectUri: 'https://203.0.113.5/callback',
    baseUrl: 'https://git.self-hosted.lan///',
    clientSecretEnvelope: 'tpsecret:1:secret',
    webhookSecretEnvelope: 'tpsecret:1:hook',
  })
  const summary = await getGitlabOauthConfigSummary(db)
  assertEquals(summary, {
    clientId: 'gitlab-client',
    redirectUri: 'https://203.0.113.5/callback',
    baseUrl: 'https://git.self-hosted.lan',
    hasClientSecret: true,
    hasWebhookSecret: true,
  })
})

test('getGitlabOauthConfigSummary defaults baseUrl to gitlab.com', async () => {
  const db = mockSettingDb({ clientId: 'only-id' })
  const summary = await getGitlabOauthConfigSummary(db)
  assertEquals(summary.baseUrl, GITLAB_DEFAULT_BASE_URL)
  assertEquals(summary.hasClientSecret, false)
})

test('setGitlabOauthConfig rejects empty clientId and clientSecret', async () => {
  const db = mockSettingDb({})
  await assertRejects(
    () => setGitlabOauthConfig(db, secrets, { clientId: '  ' }),
    GitlabOauthConfigError,
    'clientId must not be empty',
  )
  await assertRejects(
    () => setGitlabOauthConfig(db, secrets, { clientSecret: '  ' }),
    GitlabOauthConfigError,
    'clientSecret must not be empty',
  )
})

test('setGitlabOauthConfig rejects non-http baseUrl on write', async () => {
  const db = mockSettingDb({ clientId: 'id', clientSecretEnvelope: 'x' })
  await assertRejects(
    () => setGitlabOauthConfig(db, secrets, { baseUrl: 'ftp://203.0.113.1' }),
    GitlabOauthConfigError,
    'http(s)',
  )
})

test('setGitlabOauthConfig deletes the row when every field is cleared', async () => {
  const db = mockSettingDb({ redirectUri: 'https://203.0.113.1/cb' })
  await setGitlabOauthConfig(db, secrets, {
    redirectUri: null,
    baseUrl: null,
    webhookSecret: null,
  })
  assertEquals(db.deleted, true)
  assertEquals(GITLAB_OAUTH_SETTING_KEY, 'TURBOPANEL_GITLAB_OAUTH')
})
