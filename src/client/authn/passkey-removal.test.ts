/**
 * Checklist row auth-passkey-remove, against a real Postgres: removing a
 * passkey needs the password, and a removed key can no longer sign in. Skips
 * without TURBOPANEL_DATABASE_URL.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.ts'
import { assert, assertEquals } from '@std/assert'
import { encodeBase64Url } from '@std/encoding/base64url'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { CLIENT_API_PREFIX } from '../../app/surfaces.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { account, passkey, session, user } from '../../db/schema.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { hashPassword } from '../../lib/secrets/password.ts'
import { deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { createAuthRateLimiter } from './auth-rate-limit.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from './crypto.ts'
import { registerAuthRoutes } from './http.ts'
import { WEBAUTHN_CHALLENGE_PURPOSE } from './passkeys.ts'
import { createSession } from './session-store.ts'

/** Sonar typescript:S2187 only recognizes `test()`; keep the alias so analysis sees these suites. */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()
const ORIGIN = 'https://panel.example.com'
const RP_ID = 'panel.example.com'
const AUTH = `${CLIENT_API_PREFIX}/auth`
const FLAG_UP_UV = 0x01 | 0x04

/** Built at run time so secret scanners never read a fixture as a credential. */
function strongCredential(): string {
  return `Aa1-${crypto.randomUUID()}`
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function uuidToBytes(id: string): Uint8Array {
  const hex = id.replaceAll('-', '')
  return Uint8Array.from({ length: 16 }, (_, i) => Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16))
}

/** An assertion for `credentialId` signed by `privateKey`, exactly as an authenticator builds it. */
async function buildAssertion(params: {
  privateKey: CryptoKey
  credentialId: Uint8Array
  userId: string
  challenge: string
  counter: number
}) {
  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(RP_ID))
  )
  const counter = new Uint8Array(4)
  new DataView(counter.buffer).setUint32(0, params.counter)
  const authData = concat(rpIdHash, new Uint8Array([FLAG_UP_UV]), counter)
  const clientDataBytes = new TextEncoder().encode(
    JSON.stringify({ type: 'webauthn.get', challenge: params.challenge, origin: ORIGIN })
  )
  const clientHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataBytes))
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    params.privateKey,
    concat(authData, clientHash) as BufferSource
  )
  return {
    id: encodeBase64Url(params.credentialId),
    rawId: encodeBase64Url(params.credentialId),
    response: {
      clientDataJSON: encodeBase64Url(clientDataBytes),
      authenticatorData: encodeBase64Url(authData),
      signature: encodeBase64Url(new Uint8Array(signature)),
      userHandle: encodeBase64Url(uuidToBytes(params.userId)),
    },
  }
}

test('removing a passkey needs the password, and the removed key can no longer sign in', async () => {
  if (!dbUrl) {
    skipWithoutDatabase('passkey removal test')
    return
  }
  const db = createDenoDb()
  const config = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(config, 'session-signing')
  const webauthnChallengeSecrets = await deriveSecretsConfig(config, WEBAUTHN_CHALLENGE_PURPOSE)
  const limiter = createAuthRateLimiter({ defaultPolicy: { limit: 1000, windowMs: 60_000 } })
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('authRateLimiter', limiter)
    return next()
  })
  const client = new Hono<AppEnv>()
  registerAuthRoutes(client, {
    secrets,
    webauthnChallengeSecrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
    baseUrl: ORIGIN,
  })
  app.route(CLIENT_API_PREFIX, client)

  const password = strongCredential()
  const [created] = await db
    .insert(user)
    .values({
      email: `passkey-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
      role: 'user',
    })
    .returning({ id: user.id })
  const userId = created!.id
  try {
    await db.insert(account).values({
      userId,
      providerId: 'credential',
      providerUserId: userId,
      password: await hashPassword(password),
    })
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])
    const credentialId = crypto.getRandomValues(new Uint8Array(16))
    const [stored] = await db
      .insert(passkey)
      .values({
        userId,
        publicKey: JSON.stringify(await crypto.subtle.exportKey('jwk', pair.publicKey)),
        credentialId: encodeBase64Url(credentialId),
        deviceType: 'singleDevice',
        isBackedUp: false,
      })
      .returning({ id: passkey.id })

    const loginStatus = async (counter: number): Promise<number> => {
      const optionsRes = await app.request(`${AUTH}/passkeys/login/options`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      assertEquals(optionsRes.status, 200)
      const options = (await optionsRes.json()) as {
        challenge: string
        options: { challenge: string }
      }
      const credential = await buildAssertion({
        privateKey: pair.privateKey,
        credentialId,
        userId,
        challenge: options.options.challenge,
        counter,
      })
      const res = await app.request(`${AUTH}/passkeys/login/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ challenge: options.challenge, credential }),
      })
      return res.status
    }

    // Control: the key signs in while it is registered.
    assertEquals(await loginStatus(1), 200)

    const { token } = await createSession(db, userId, {})
    const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`
    const remove = (body: unknown) =>
      app.request(`${AUTH}/passkeys/${stored!.id}`, {
        method: 'DELETE',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    assertEquals((await remove({})).status, 403)
    assertEquals((await remove({ password: strongCredential() })).status, 403)
    assertEquals(await loginStatus(2), 200, 'a refused removal leaves the key working')

    assertEquals((await remove({ password })).status, 200)
    const afterRemoval = await loginStatus(3)
    assert(afterRemoval >= 400, `the removed key signed in (${afterRemoval})`)
  } finally {
    await db.delete(session).where(eq(session.userId, userId))
    await db.delete(passkey).where(eq(passkey.userId, userId))
    await db.delete(account).where(eq(account.userId, userId))
    await db.delete(user).where(eq(user.id, userId))
    await endDbConnection(db)
  }
})
