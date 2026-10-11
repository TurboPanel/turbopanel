/**
 * Refreshing a GitLab connection's token against a real Postgres: GitLab's
 * refresh token is single-use, so concurrent callers that all find the same
 * expired token must end up with one provider refresh and the same token.
 * Skipped without TURBOPANEL_DATABASE_URL, like every Postgres suite.
 */
import { assertEquals, assertRejects } from '@std/assert'
import { eq } from 'drizzle-orm'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { forge, gitConnection, organization } from '../../db/schema.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { decryptSecret, encryptSecret } from '../../lib/secrets/data-encryption.ts'
import { deriveEncryptionSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { useUnpinnedForgeFetchForTests } from './forge-url.ts'
import { GitlabOauthTokenError, mintGitlabAccessToken } from './gitlab-oauth-token.ts'

useUnpinnedForgeFetchForTests()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()
const FIRST_REFRESH_TOKEN = 'refresh-1'

type Db = ReturnType<typeof createDenoDb>

async function withConnection(
  fn: (ctx: {
    db: Db
    connectionId: string
    secrets: Awaited<ReturnType<typeof deriveEncryptionSecretsConfig>>
  }) => Promise<void>
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping gitlab token tests: TURBOPANEL_DATABASE_URL not set')
    return
  }
  const db = createDenoDb()
  const secrets = await deriveEncryptionSecretsConfig(
    parseTestSecretsConfig('deno'),
    'data-encryption'
  )
  const [org] = await db
    .insert(organization)
    .values({ name: 'Gitlab Token Org' })
    .returning({ id: organization.id })
  const [app] = await db
    .insert(forge)
    .values({
      organizationId: org!.id,
      provider: 'gitlab',
      name: 'Gitlab Token App',
      baseUrl: 'https://gitlab.token.test',
      externalAppId: 'app-1',
      clientId: 'client-id',
      webhookRef: crypto.randomUUID().replaceAll('-', ''),
      envelopes: { clientSecretEnvelope: await encryptSecret(secrets, 'client-secret') },
    })
    .returning({ id: forge.id })
  const [connection] = await db
    .insert(gitConnection)
    .values({
      organizationId: org!.id,
      forgeId: app!.id,
      provider: 'gitlab',
      externalInstallationId: 'acct-1',
      oauthEnvelope: {
        accessTokenEnvelope: await encryptSecret(secrets, 'expired-access'),
        refreshTokenEnvelope: await encryptSecret(secrets, FIRST_REFRESH_TOKEN),
        expiresAt: '2000-01-01T00:00:00.000Z',
      },
    })
    .returning({ id: gitConnection.id })
  try {
    await fn({ db, connectionId: connection!.id, secrets })
  } finally {
    await db.delete(organization).where(eq(organization.id, org!.id))
    await endDbConnection(db)
  }
}

/** A GitLab that honours each refresh token once, the way the real one does. */
function singleUseGitlab() {
  const spent = new Set<string>()
  const calls: string[] = []
  const handler = async (_url: string, init?: RequestInit): Promise<Response> => {
    const sent = new URLSearchParams(String(init?.body)).get('refresh_token') ?? ''
    calls.push(sent)
    // A real round trip takes time; this is what lets callers overlap.
    await new Promise((resolve) => setTimeout(resolve, 50))
    if (spent.has(sent)) {
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
    }
    spent.add(sent)
    return new Response(
      JSON.stringify({
        access_token: `access-${calls.length}`,
        refresh_token: `refresh-${calls.length + 1}`,
        expires_in: 7200,
      })
    )
  }
  return { calls, handler }
}

async function withGitlab(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
  fn: () => Promise<void>
): Promise<void> {
  const original = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input instanceof Request ? input.url : input), init)) as typeof fetch
  try {
    await fn()
  } finally {
    globalThis.fetch = original
  }
}

test('concurrent mints with an expired token cause one provider refresh and share its token', async () => {
  await withConnection(async ({ db, connectionId, secrets }) => {
    const gitlab = singleUseGitlab()
    await withGitlab(gitlab.handler, async () => {
      const minted = await Promise.all(
        Array.from({ length: 6 }, () => mintGitlabAccessToken(db, secrets, connectionId))
      )
      assertEquals(gitlab.calls, [FIRST_REFRESH_TOKEN])
      assertEquals(new Set(minted.map((m) => m.token)), new Set(['access-1']))
    })
    // The rotated refresh token is what is stored, so the next refresh works.
    const [row] = await db
      .select({ oauthEnvelope: gitConnection.oauthEnvelope })
      .from(gitConnection)
      .where(eq(gitConnection.id, connectionId))
    const stored = row!.oauthEnvelope as { refreshTokenEnvelope: string }
    assertEquals(await decryptSecret(secrets, stored.refreshTokenEnvelope), 'refresh-2')
  })
})

test('a refresh that GitLab refuses leaves the stored pair alone and reports the failure', async () => {
  await withConnection(async ({ db, connectionId, secrets }) => {
    await withGitlab(
      () =>
        Promise.resolve(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })),
      async () => {
        await assertRejects(
          () => mintGitlabAccessToken(db, secrets, connectionId),
          GitlabOauthTokenError
        )
      }
    )
    const [row] = await db
      .select({ oauthEnvelope: gitConnection.oauthEnvelope })
      .from(gitConnection)
      .where(eq(gitConnection.id, connectionId))
    const stored = row!.oauthEnvelope as { refreshTokenEnvelope: string }
    assertEquals(await decryptSecret(secrets, stored.refreshTokenEnvelope), FIRST_REFRESH_TOKEN)
  })
})

test('a refresh token replaced by something outside the lock is picked up on a refusal', async () => {
  await withConnection(async ({ db, connectionId, secrets }) => {
    // The provider refuses the old token, and meanwhile the account was
    // reconnected: the stored pair is new and valid. The caller takes it.
    await withGitlab(
      async () => {
        await db
          .update(gitConnection)
          .set({
            oauthEnvelope: {
              accessTokenEnvelope: await encryptSecret(secrets, 'reconnected-access'),
              refreshTokenEnvelope: await encryptSecret(secrets, 'reconnected-refresh'),
              expiresAt: '2099-01-01T00:00:00.000Z',
            },
          })
          .where(eq(gitConnection.id, connectionId))
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
      },
      async () => {
        const minted = await mintGitlabAccessToken(db, secrets, connectionId)
        assertEquals(minted.token, 'reconnected-access')
      }
    )
  })
})
