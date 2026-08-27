/**
 * Coverage for webhook app resolution — the step that decides *whose* secret a
 * delivery is verified against once an instance may hold several apps.
 *
 * Host-free: the only database work is the `gitapp` read, stubbed here.
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db.ts'
import { deriveEncryptionSecretsConfig } from '../../client/authn/secrets.ts'
import { encryptSecret } from '../../client/authn/data-encryption.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { hashWebhookToken } from './forge-records.ts'
import {
  candidatesUnconfigured,
  githubTargetAppId,
  GITHUB_HOOK_TARGET_ID_HEADER,
  GITHUB_HOOK_TARGET_TYPE_HEADER,
  resolveGithubWebhookForge,
  resolveGitlabWebhookForge,
  selectVerifiedApp,
} from './resolve-webhook-forge.ts'

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

type RowInput = {
  id: string
  provider?: 'github' | 'gitlab'
  externalAppId?: string
  baseUrl?: string
  webhookRef?: string
  webhookSecretEnvelope?: string
  webhookTokenHash?: string | null
}

function row(input: RowInput): Record<string, unknown> {
  return {
    id: input.id,
    organizationId: null,
    provider: input.provider ?? 'github',
    name: input.id,
    baseUrl: input.baseUrl ?? 'https://github.com',
    apiUrl: null,
    externalAppId: input.externalAppId ?? '1234',
    appSlug: null,
    clientId: null,
    redirectUri: null,
    webhookRef: input.webhookRef ?? `${input.id}-ref`,
    webhookTokenHash: input.webhookTokenHash ?? null,
    envelopes: input.webhookSecretEnvelope
      ? { webhookSecretEnvelope: input.webhookSecretEnvelope }
      : {},
  }
}

/**
 * The resolver issues two shapes of read: `.limit(1)` for the ref and token
 * lookups, and an `.orderBy()` list for the App-id fallback. Both land here.
 */
function stubDb(rows: Array<Record<string, unknown>>): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(rows.slice(0, 1)),
          orderBy: () => Promise.resolve(rows),
        }),
      }),
    }),
  } as unknown as Db
}

function headers(values: Record<string, string>) {
  return { get: (name: string) => values[name.toLowerCase()] ?? null }
}

const APP_HEADERS = headers({
  [GITHUB_HOOK_TARGET_TYPE_HEADER]: 'integration',
  [GITHUB_HOOK_TARGET_ID_HEADER]: '1234',
})

test('githubTargetAppId reads the App id only for app-targeted webhooks', () => {
  assertEquals(githubTargetAppId(APP_HEADERS), '1234')
  // `app` is the newer spelling of the same target type.
  assertEquals(
    githubTargetAppId(headers({
      [GITHUB_HOOK_TARGET_TYPE_HEADER]: 'app',
      [GITHUB_HOOK_TARGET_ID_HEADER]: '77',
    })),
    '77',
  )
  // A repository webhook's target id is a repository id, not an App id — using
  // it to select an app would be a category error.
  assertEquals(
    githubTargetAppId(headers({
      [GITHUB_HOOK_TARGET_TYPE_HEADER]: 'repository',
      [GITHUB_HOOK_TARGET_ID_HEADER]: '99',
    })),
    null,
  )
  assertEquals(githubTargetAppId(headers({})), null)
})

test('a path ref resolves the app outright', async () => {
  const db = stubDb([row({ id: 'app-a' })])
  const resolved = await resolveGithubWebhookForge(db, await secrets(), 'app-a-ref', headers({}))
  assertEquals(resolved.ok, true)
  assertEquals(resolved.ok && resolved.candidates.map((app) => app.id), ['app-a'])
})

test('a ref that disagrees with the delivery App id is refused', async () => {
  // The URL says one app, the credentials say another: accepting either would
  // route a verified delivery to the wrong tenant.
  const db = stubDb([row({ id: 'app-a', externalAppId: '9999' })])
  const resolved = await resolveGithubWebhookForge(
    db,
    await secrets(),
    'app-a-ref',
    APP_HEADERS,
  )
  assertEquals(resolved, { ok: false, reason: 'ref_header_mismatch' })
})

test('a ref pointing at a gitlab app is not a github candidate', async () => {
  const db = stubDb([row({ id: 'app-a', provider: 'gitlab' })])
  const resolved = await resolveGithubWebhookForge(db, await secrets(), 'app-a-ref', headers({}))
  assertEquals(resolved, { ok: false, reason: 'unresolved' })
})

test('without a ref the App id header selects every matching app', async () => {
  // A numeric App id is unique per origin, not globally, so github.com and a
  // GHES instance can both hold one — both are candidates.
  const db = stubDb([
    row({ id: 'dotcom', externalAppId: '1234' }),
    row({ id: 'ghes', externalAppId: '1234', baseUrl: 'https://github.acme.test' }),
  ])
  const resolved = await resolveGithubWebhookForge(db, await secrets(), null, APP_HEADERS)
  assertEquals(resolved.ok && resolved.candidates.map((app) => app.id), ['dotcom', 'ghes'])
})

test('a delivery naming no app at all is refused', async () => {
  const resolved = await resolveGithubWebhookForge(stubDb([]), await secrets(), null, headers({}))
  assertEquals(resolved, { ok: false, reason: 'unresolved' })
})

test('selectVerifiedApp keeps the candidate whose secret actually verifies', async () => {
  const derived = await secrets()
  const first = row({
    id: 'first',
    webhookSecretEnvelope: await encryptSecret(derived, 'wrong'),
  })
  const second = row({
    id: 'second',
    webhookSecretEnvelope: await encryptSecret(derived, 'right'),
  })
  const resolved = await resolveGithubWebhookForge(
    stubDb([first, second]),
    derived,
    null,
    APP_HEADERS,
  )
  if (!resolved.ok) throw new TypeError('expected candidates')

  const picked = await selectVerifiedApp(
    resolved.candidates,
    (secret) => Promise.resolve(secret === 'right'),
  )
  assertEquals(picked?.id, 'second')

  // Nothing verifies → null, never a fallback to the first candidate.
  assertEquals(await selectVerifiedApp(resolved.candidates, () => Promise.resolve(false)), null)
})

test('candidatesUnconfigured separates a config gap from a rejection', async () => {
  const derived = await secrets()
  const resolved = await resolveGithubWebhookForge(
    stubDb([row({ id: 'bare' })]),
    derived,
    'bare-ref',
    headers({}),
  )
  if (!resolved.ok) throw new TypeError('expected candidates')
  assertEquals(candidatesUnconfigured(resolved.candidates), true)

  const configured = await resolveGithubWebhookForge(
    stubDb([
      row({ id: 'set', webhookSecretEnvelope: await encryptSecret(derived, 'shh') }),
    ]),
    derived,
    'set-ref',
    headers({}),
  )
  if (!configured.ok) throw new TypeError('expected candidates')
  assertEquals(candidatesUnconfigured(configured.candidates), false)
})

test('gitlab resolves by ref, then by token digest', async () => {
  const derived = await secrets()
  const token = 'a-long-enough-gitlab-token-value'
  const gitlabRow = row({
    id: 'gl',
    provider: 'gitlab',
    baseUrl: 'https://gitlab.com',
    webhookSecretEnvelope: await encryptSecret(derived, token),
    webhookTokenHash: await hashWebhookToken(token),
  })

  const byRef = await resolveGitlabWebhookForge(stubDb([gitlabRow]), derived, 'gl-ref', null)
  assertEquals(byRef.ok && byRef.candidates.map((app) => app.id), ['gl'])

  const byToken = await resolveGitlabWebhookForge(stubDb([gitlabRow]), derived, null, token)
  assertEquals(byToken.ok && byToken.candidates.map((app) => app.id), ['gl'])

  // No ref and no token is not something to guess at.
  assertEquals(
    await resolveGitlabWebhookForge(stubDb([gitlabRow]), derived, null, '  '),
    { ok: false, reason: 'unresolved' },
  )
})

test('a github ref is not a gitlab candidate', async () => {
  const db = stubDb([row({ id: 'gh', provider: 'github' })])
  assertEquals(
    await resolveGitlabWebhookForge(db, await secrets(), 'gh-ref', null),
    { ok: false, reason: 'unresolved' },
  )
})

test('hashWebhookToken is deterministic and domain-separated', async () => {
  const a = await hashWebhookToken('token-value')
  assertEquals(a, await hashWebhookToken('token-value'))
  assertEquals(a.length, 64)

  // Not a bare SHA-256 of the token: the digest is prefixed, so it cannot be
  // confused with any other hash of the same secret.
  const bare = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode('token-value') as BufferSource,
  )
  const bareHex = Array.from(new Uint8Array(bare))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  assertEquals(a === bareHex, false)
})
