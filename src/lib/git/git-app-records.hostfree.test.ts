/**
 * Coverage for the `gitapp` record layer: the sealing contract, the
 * partial-update rule, and the scope predicate that decides what an
 * organization may see.
 *
 * Host-free: writes are captured from a stubbed `insert`/`update` chain rather
 * than sent to Postgres.
 */

import { assertEquals, assertRejects } from '@std/assert'
import type { Db } from '../../db.ts'
import { deriveEncryptionSecretsConfig } from '../../client/authn/secrets.ts'
import { decryptSecret, isSealedEnvelope } from '../../client/authn/data-encryption.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import {
  createGitApp,
  defaultBaseUrlFor,
  GitAppConflictError,
  GitAppError,
  generateGitlabWebhookToken,
  generateWebhookRef,
  hashWebhookToken,
  MIN_GITLAB_WEBHOOK_TOKEN_LENGTH,
  summarizeGitApp,
  updateGitApp,
} from './git-app-records.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function secrets() {
  return deriveEncryptionSecretsConfig(parseTestSecretsConfig('deno'), 'data-encryption')
}

/** Captures the values an insert or update would have written. */
function writeCapturingDb(existing?: Record<string, unknown>) {
  const captured: { values?: Record<string, unknown>; set?: Record<string, unknown> } = {}
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(existing ? [existing] : []),
        }),
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        captured.values = values
        return { returning: () => Promise.resolve([{ ...existing, ...values, id: 'new-app' }]) }
      },
    }),
    update: () => ({
      set: (set: Record<string, unknown>) => {
        captured.set = set
        return {
          where: () => ({
            returning: () => Promise.resolve([{ ...existing, ...set }]),
          }),
        }
      },
    }),
  }
  return { db: db as unknown as Db, captured }
}

function storedRow(credentials: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'app-1',
    organizationId: null,
    provider: 'gitlab',
    name: 'Existing',
    baseUrl: 'https://gitlab.com',
    apiUrl: null,
    externalAppId: 'oauth-1',
    appSlug: null,
    clientId: 'client-1',
    redirectUri: null,
    webhookRef: 'ref-1',
    webhookTokenHash: 'old-hash',
    credentials,
  }
}

test('defaultBaseUrlFor picks the provider origin', () => {
  assertEquals(defaultBaseUrlFor('github'), 'https://github.com')
  assertEquals(defaultBaseUrlFor('gitlab'), 'https://gitlab.com')
})

test('generated refs and tokens are url-safe and unique', () => {
  const a = generateWebhookRef()
  const b = generateWebhookRef()
  assertEquals(a === b, false)
  assertEquals(/^[A-Za-z0-9_-]+$/.test(a), true)
  // A ref rides in a URL path segment, so it must need no escaping.
  assertEquals(encodeURIComponent(a), a)
  assertEquals(/^[A-Za-z0-9_-]+$/.test(generateGitlabWebhookToken()), true)
})

test('create seals every secret and never stores plaintext', async () => {
  const derived = await secrets()
  const { db, captured } = writeCapturingDb()
  await createGitApp(db, derived, {
    organizationId: null,
    provider: 'github',
    name: '  TurboPanel  ',
    externalAppId: ' 1234 ',
    privateKeyPem: 'pem-material',
    webhookSecret: 'hmac-material',
  })

  const values = captured.values as Record<string, unknown>
  assertEquals(values.name, 'TurboPanel')
  assertEquals(values.externalAppId, '1234')
  // Omitted baseUrl falls back to the provider default, non-null so the unique
  // index over (provider, base_url, external_app_id) actually applies.
  assertEquals(values.baseUrl, 'https://github.com')

  const credentials = values.credentials as Record<string, string>
  assertEquals(isSealedEnvelope(credentials.privateKeyEnvelope), true)
  assertEquals(isSealedEnvelope(credentials.webhookSecretEnvelope), true)
  assertEquals(await decryptSecret(derived, credentials.privateKeyEnvelope), 'pem-material')
  assertEquals(
    await decryptSecret(derived, credentials.webhookSecretEnvelope),
    'hmac-material',
  )
  // GitHub does not use the token digest; only GitLab does.
  assertEquals(values.webhookTokenHash, null)
})

test('a gitlab webhook token is indexed by digest and length-floored', async () => {
  const derived = await secrets()
  const token = 'a-sufficiently-long-gitlab-token'
  const { db, captured } = writeCapturingDb()
  await createGitApp(db, derived, {
    organizationId: null,
    provider: 'gitlab',
    name: 'GitLab',
    externalAppId: 'oauth-1',
    webhookSecret: token,
  })
  assertEquals(captured.values?.webhookTokenHash, await hashWebhookToken(token))

  // Short tokens are refused: the digest is a lookup index, so a low-entropy
  // value would be brute-forceable offline by anyone holding the table.
  await assertRejects(
    () =>
      createGitApp(writeCapturingDb().db, derived, {
        organizationId: null,
        provider: 'gitlab',
        name: 'GitLab',
        externalAppId: 'oauth-2',
        webhookSecret: 'x'.repeat(MIN_GITLAB_WEBHOOK_TOKEN_LENGTH - 1),
      }),
    GitAppError,
    'at least',
  )
})

test('create rejects an empty name or external app id', async () => {
  const derived = await secrets()
  for (const input of [
    { name: '   ', externalAppId: '1' },
    { name: 'ok', externalAppId: '  ' },
  ]) {
    await assertRejects(
      () =>
        createGitApp(writeCapturingDb().db, derived, {
          organizationId: null,
          provider: 'github',
          ...input,
        }),
      GitAppError,
    )
  }
})

test('an update that omits a secret keeps the sealed one', async () => {
  const derived = await secrets()
  const existing = storedRow({
    clientSecretEnvelope: 'tpsecret.v1.sealed-client',
    webhookSecretEnvelope: 'tpsecret.v1.sealed-webhook',
  })
  const { db, captured } = writeCapturingDb(existing)

  await updateGitApp(db, derived, 'app-1', { name: 'Renamed' })

  const set = captured.set as Record<string, unknown>
  assertEquals(set.name, 'Renamed')
  // The whole point: a settings form can save a rename without the operator
  // re-pasting a key it was never shown.
  assertEquals(set.credentials, {
    clientSecretEnvelope: 'tpsecret.v1.sealed-client',
    webhookSecretEnvelope: 'tpsecret.v1.sealed-webhook',
  })
  // An untouched GitLab token must not desync from its digest.
  assertEquals('webhookTokenHash' in set, false)
})

test('an explicit null clears a secret and its digest together', async () => {
  const derived = await secrets()
  const { db, captured } = writeCapturingDb(
    storedRow({ webhookSecretEnvelope: 'tpsecret.v1.sealed-webhook' }),
  )

  await updateGitApp(db, derived, 'app-1', { webhookSecret: null })

  const set = captured.set as Record<string, unknown>
  assertEquals(set.credentials, {})
  // Leaving a stale digest behind would let the fallback lookup resolve to an
  // app whose stored secret can no longer verify anything.
  assertEquals(set.webhookTokenHash, null)
})

test('rotating a gitlab token rewrites the digest in the same write', async () => {
  const derived = await secrets()
  const rotated = 'a-brand-new-sufficiently-long-token'
  const { db, captured } = writeCapturingDb(
    storedRow({ webhookSecretEnvelope: 'tpsecret.v1.sealed-webhook' }),
  )

  await updateGitApp(db, derived, 'app-1', { webhookSecret: rotated })
  assertEquals(captured.set?.webhookTokenHash, await hashWebhookToken(rotated))
})

test('updating a row that is gone answers null', async () => {
  const derived = await secrets()
  assertEquals(await updateGitApp(writeCapturingDb().db, derived, 'missing', {}), null)
})

test('create adopts a ref minted before the row existed', async () => {
  const derived = await secrets()
  const { db, captured } = writeCapturingDb()

  // The manifest flow bakes the ref into GitHub's webhook URL before the App
  // exists, so the row has to be born with that exact ref — correcting it
  // afterwards would leave a window where every delivery 401s.
  await createGitApp(db, derived, {
    organizationId: null,
    provider: 'github',
    name: 'TurboPanel',
    externalAppId: '1234',
    webhookRef: 'pending-ref',
  })
  assertEquals(captured.values?.webhookRef, 'pending-ref')

  // Without one, a fresh ref is generated.
  const plain = writeCapturingDb()
  await createGitApp(plain.db, derived, {
    organizationId: null,
    provider: 'github',
    name: 'TurboPanel',
    externalAppId: '1234',
  })
  assertEquals(typeof plain.captured.values?.webhookRef, 'string')
  assertEquals(plain.captured.values?.webhookRef === 'pending-ref', false)
})

test('a unique violation becomes an opaque conflict, not a 500', async () => {
  const derived = await secrets()
  // All three unique keys are instance-global, so a distinguishable error
  // would let one organization probe another's registrations — and for the
  // GitLab token digest that would be an online oracle for the one secret
  // that authenticates a delivery.
  const conflicting = {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    }),
    insert: () => ({
      values: () => ({
        returning: () => Promise.reject(Object.assign(new Error('dup'), { code: '23505' })),
      }),
    }),
  } as unknown as Db

  const error = await assertRejects(
    () =>
      createGitApp(conflicting, derived, {
        organizationId: null,
        provider: 'github',
        name: 'TurboPanel',
        externalAppId: '1234',
      }),
    GitAppConflictError,
  )
  // Says nothing about who holds the existing row, or which key collided.
  assertEquals(error.message.includes('organization'), false)
  assertEquals(error.message.includes('webhook'), false)
})

test('a non-unique database error is not swallowed as a conflict', async () => {
  const derived = await secrets()
  const broken = {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    }),
    insert: () => ({
      values: () => ({
        returning: () => Promise.reject(Object.assign(new Error('down'), { code: '08006' })),
      }),
    }),
  } as unknown as Db

  await assertRejects(
    () =>
      createGitApp(broken, derived, {
        organizationId: null,
        provider: 'github',
        name: 'TurboPanel',
        externalAppId: '1234',
      }),
    Error,
    'down',
  )
})

test('summarize reports presence, never the sealed material', () => {
  const summary = summarizeGitApp(
    storedRow({
      privateKeyEnvelope: 'tpsecret.v1.a',
      webhookSecretEnvelope: 'tpsecret.v1.b',
      // deno-lint-ignore no-explicit-any
    }) as any,
  )
  assertEquals(summary.hasPrivateKey, true)
  assertEquals(summary.hasWebhookSecret, true)
  assertEquals(summary.hasClientSecret, false)
  assertEquals('credentials' in summary, false)
  assertEquals(summary.webhookRef, 'ref-1')
})
