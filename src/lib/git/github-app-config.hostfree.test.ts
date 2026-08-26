/**
 * Host-free coverage for GitHub App config helpers (mock Db).
 */

import { assertEquals, assertRejects } from '@std/assert'
import type { Db } from '../../db.ts'
import {
  GITHUB_APP_SETTING_KEY,
  GithubAppConfigError,
  getGithubAppConfigSummary,
  setGithubAppConfig,
} from './github-app-config.ts'
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

test('getGithubAppConfigSummary reports presence without decrypting', async () => {
  const db = mockSettingDb({
    appId: ' 99 ',
    appSlug: 'turbopanel',
    clientId: 'cid',
    privateKeyEnvelope: 'tpsecret:1:abc',
    webhookSecretEnvelope: 'tpsecret:1:def',
  })
  const summary = await getGithubAppConfigSummary(db)
  assertEquals(summary, {
    appId: '99',
    appSlug: 'turbopanel',
    clientId: 'cid',
    hasPrivateKey: true,
    hasWebhookSecret: true,
  })
})

test('getGithubAppConfigSummary returns empty flags for a missing row', async () => {
  const db = mockSettingDb(undefined)
  const summary = await getGithubAppConfigSummary(db)
  assertEquals(summary, {
    appId: null,
    appSlug: null,
    clientId: null,
    hasPrivateKey: false,
    hasWebhookSecret: false,
  })
})

test('setGithubAppConfig rejects empty appId and privateKeyPem', async () => {
  const db = mockSettingDb({})
  await assertRejects(
    () => setGithubAppConfig(db, secrets, { appId: '   ' }),
    GithubAppConfigError,
    'appId must not be empty',
  )
  await assertRejects(
    () => setGithubAppConfig(db, secrets, { privateKeyPem: '   ' }),
    GithubAppConfigError,
    'privateKeyPem must not be empty',
  )
})

test('setGithubAppConfig deletes the row when every field is cleared', async () => {
  const db = mockSettingDb({ appSlug: 'old' })
  await setGithubAppConfig(db, secrets, {
    appSlug: null,
    clientId: null,
    webhookSecret: null,
  })
  assertEquals(db.deleted, true)
  assertEquals(GITHUB_APP_SETTING_KEY, 'TURBOPANEL_GITHUB_APP')
})
