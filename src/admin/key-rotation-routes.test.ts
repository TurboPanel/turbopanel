/**
 * Postgres-backed coverage for passkey-approved key changes: the first marks,
 * a rotation, the refusals in between, the stored chain and the delete guard.
 */
import { assert, assertEquals, assertNotEquals, assertRejects } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../app/app.ts'
import { ADMIN_API_PREFIX } from '../app/surfaces.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../client/authn/crypto.ts'
import { createAdminAccessMiddleware } from '../client/authn/middleware.ts'
import { deletePasskey, PasskeyMarkedError } from '../client/authn/passkeys.ts'
import { createSession } from '../client/authn/session-store.ts'
import { createDenoDb, type Db, endDbConnection } from '../db/connection.ts'
import { approver, passkey, setting, statement, user } from '../db/schema.ts'
import { base64urlDecode, base64urlEncode } from '../lib/encoding/base64url.ts'
import {
  ensurePanelIdentity,
  PANEL_IDENTITY_SETTING_KEY,
  type PanelIdentity,
  resolvePanelIdentityFromDb,
} from '../lib/panel-identity/identity.ts'
import { listLiveStatements } from '../lib/panel-identity/keyset-store.ts'
import { deriveEncryptionSecretsConfig, deriveSecretsConfig } from '../lib/secrets/secrets.ts'
import { skipWithoutDatabase } from '../test-fixtures/require-service.test.support.ts'
import { parseTestSecretsConfig } from '../test-fixtures/secrets.ts'
import {
  createSoftPasskey,
  type SoftPasskey,
  softAssert,
} from '../test-fixtures/software-authenticator.ts'
import { registerKeyRotationRoutes } from './key-rotation-routes.ts'

const test = Deno.test.bind(Deno)
const dbUrl = Deno.env.get('TURBOPANEL_DATABASE_URL')
const BASE = `http://localhost${ADMIN_API_PREFIX}/instance/identity`

type Credential = { soft: SoftPasskey; credentialId: string; rowId: string }

/** A sign-in passkey row holding the soft authenticator's key, as registration stores it. */
async function insertPasskey(db: Db, userId: string, soft: SoftPasskey): Promise<Credential> {
  const raw = base64urlDecode(soft.passkey.pub)
  const jwk =
    soft.passkey.alg === 'EdDSA'
      ? { kty: 'OKP', crv: 'Ed25519', x: soft.passkey.pub }
      : {
          kty: 'EC',
          crv: 'P-256',
          x: base64urlEncode(raw.subarray(1, 33)),
          y: base64urlEncode(raw.subarray(33, 65)),
        }
  // The soft authenticator's id is SHA-256 of a random credential id it does
  // not keep; pick a credential id and re-derive the rotation id from it.
  const credentialId = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)))
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', base64urlDecode(credentialId))
  )
  soft.passkey.id = base64urlEncode(digest)
  const [row] = await db
    .insert(passkey)
    .values({
      userId,
      name: soft.passkey.alg,
      publicKey: JSON.stringify(jwk),
      credentialId,
      deviceType: soft.passkey.alg === 'EdDSA' ? 'singleDevice' : 'multiDevice',
      isBackedUp: false,
    })
    .returning({ id: passkey.id })
  return { soft, credentialId, rowId: row!.id }
}

async function approvalsFor(
  credentials: Credential[],
  prepared: { challenge: string; rpId: string }
) {
  return await Promise.all(
    credentials.map(async (cred) => {
      const a = await softAssert(cred.soft, {
        rpId: prepared.rpId,
        challenge: prepared.challenge,
      })
      return {
        credentialId: cred.credentialId,
        authenticatorData: a.authenticatorData,
        clientDataJSON: a.clientDataJSON,
        signature: a.signature,
      }
    })
  )
}

test('marks, a rotation and the refusals around them', async () => {
  if (!dbUrl) {
    skipWithoutDatabase('key rotation route tests')
    return
  }
  const db = createDenoDb()
  const createdUsers: string[] = []
  try {
    const sessionSecrets = await deriveSecretsConfig(
      parseTestSecretsConfig('deno'),
      'session-signing'
    )
    const dataEncryption = await deriveEncryptionSecretsConfig(
      parseTestSecretsConfig('deno'),
      'data-encryption'
    )
    await db.delete(approver)
    await db.delete(statement)
    await db.delete(setting).where(eq(setting.key, PANEL_IDENTITY_SETTING_KEY))
    let identity: PanelIdentity = await ensurePanelIdentity(db, dataEncryption)
    const firstKid = identity.current.kid

    const [root] = await db
      .insert(user)
      .values({
        email: `root-${crypto.randomUUID()}@example.test`,
        isEmailVerified: true,
        role: 'superadmin',
      })
      .returning({ id: user.id })
    createdUsers.push(root!.id)
    const a = await insertPasskey(db, root!.id, await createSoftPasskey('ES256'))
    const b = await insertPasskey(db, root!.id, await createSoftPasskey('EdDSA'))
    const stranger = await insertPasskey(db, root!.id, await createSoftPasskey('ES256'))

    const app = new Hono<AppEnv>()
    app.use('*', (c, next) => {
      c.set('db', db)
      return next()
    })
    const admin = new Hono<AppEnv>()
    admin.use('*', createAdminAccessMiddleware(sessionSecrets))
    registerKeyRotationRoutes(admin, {
      secrets: sessionSecrets,
      runtime: 'deno',
      dataEncryption,
      panelIdentity: () => Promise.resolve(identity),
      onIdentityChanged: async () => {
        identity = (await resolvePanelIdentityFromDb(db, dataEncryption)) ?? identity
      },
    })
    app.route(ADMIN_API_PREFIX, admin)
    const { token } = await createSession(db, root!.id, {})
    const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, sessionSecrets)}`
    const post = async (path: string, body: unknown) => {
      const res = await app.request(`${BASE}${path}`, {
        method: 'POST',
        headers: { Cookie: cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return { status: res.status, body: await res.json() }
    }

    // Rotate Key needs two marked passkeys.
    assertEquals((await post('/statements/prepare', { kind: 'rotate' })).status, 409)

    // Genesis: both passkeys prove possession in one statement.
    const genesis = await post('/statements/prepare', {
      kind: 'passkeys',
      mark: [a.rowId, b.rowId],
    })
    assertEquals(genesis.status, 200, JSON.stringify(genesis.body))
    assertEquals(genesis.body.possessionCredentialIds.length, 2)
    const onlyOne = await post('/statements', {
      statement: genesis.body.statement,
      approvals: await approvalsFor([a], genesis.body),
    })
    assertEquals(onlyOne.status, 422)
    const marked = await post('/statements', {
      statement: genesis.body.statement,
      approvals: await approvalsFor([a, b], genesis.body),
    })
    assertEquals(marked.status, 200, JSON.stringify(marked.body))
    assertEquals(marked.body.keyset, 2)
    await assertRejects(() => deletePasskey(db, root!.id, a.rowId), PasskeyMarkedError)

    // Rotation: a passkey that is not marked cannot approve; a marked one can.
    const rotate = await post('/statements/prepare', { kind: 'rotate' })
    assertEquals(rotate.status, 200, JSON.stringify(rotate.body))
    assertEquals(rotate.body.oldFingerprint, firstKid)
    const forged = await post('/statements', {
      statement: rotate.body.statement,
      approvals: await approvalsFor([stranger], rotate.body),
    })
    assertEquals(forged.status, 422)
    const rotated = await post('/statements', {
      statement: rotate.body.statement,
      approvals: await approvalsFor([b], rotate.body),
    })
    assertEquals(rotated.status, 200, JSON.stringify(rotated.body))
    assertEquals(identity.current.kid, rotate.body.newFingerprint)
    assertNotEquals(identity.current.kid, firstKid)
    assertEquals(identity.keyset, 3)

    // The same approval again is refused: the key set moved on.
    const replay = await post('/statements', {
      statement: rotate.body.statement,
      approvals: await approvalsFor([b], rotate.body),
    })
    assert(replay.status === 409 || replay.status === 422, String(replay.status))

    const chain = await listLiveStatements(db, 0)
    assertEquals(chain.length, 2)
    assertEquals(chain[1]!.statement, rotate.body.statement)
    assertEquals((await listLiveStatements(db, 2)).length, 1)
  } finally {
    await db.delete(approver)
    await db.delete(statement)
    if (createdUsers.length > 0) {
      await db.delete(passkey).where(inArray(passkey.userId, createdUsers))
      await db.delete(user).where(inArray(user.id, createdUsers))
    }
    await db.delete(setting).where(eq(setting.key, PANEL_IDENTITY_SETTING_KEY))
    await endDbConnection(db)
  }
})
