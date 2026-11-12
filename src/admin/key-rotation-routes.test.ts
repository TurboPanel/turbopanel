/**
 * Postgres-backed coverage for passkey-approved key changes: the first marks,
 * a rotation, the refusals in between, the stored chain and the delete guard.
 */
import { assert, assertEquals, assertNotEquals, assertRejects } from '@std/assert'
import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../app/app.ts'
import { ADMIN_API_PREFIX } from '../app/surfaces.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../client/authn/crypto.ts'
import { createAdminAccessMiddleware } from '../client/authn/middleware.ts'
import { deletePasskey, PasskeyMarkedError } from '../client/authn/passkeys.ts'
import { createSession } from '../client/authn/session-store.ts'
import { createDenoDb, type Db, endDbConnection } from '../db/connection.ts'
import { audit, custodian, passkey, rotation, setting, user } from '../db/schema.ts'
import { base64urlDecode, base64urlEncode } from '../lib/encoding/base64url.ts'
import {
  ensurePanelIdentity,
  PANEL_IDENTITY_SETTING_KEY,
  type PanelIdentity,
  resolvePanelIdentityFromDb,
} from '../lib/panel-identity/identity.ts'
import { fingerprintRawPublicKey } from '../lib/panel-identity/fingerprint.ts'
import { listLiveStatements } from '../lib/panel-identity/keyset-store.ts'
import { deriveEncryptionSecretsConfig, deriveSecretsConfig } from '../lib/secrets/secrets.ts'
import { skipWithoutDatabase } from '../test-fixtures/require-service.test.support.ts'
import { parseTestSecretsConfig } from '../test-fixtures/secrets.ts'
import {
  createSoftPasskey,
  type SoftPasskey,
  softAssert,
  softPanelKey,
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
  prepared: { challenge: string; rpId: string },
  origin?: string
) {
  return await Promise.all(
    credentials.map(async (cred) => {
      const a = await softAssert(cred.soft, {
        rpId: prepared.rpId,
        challenge: prepared.challenge,
        ...(origin === undefined ? {} : { origin }),
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

/** The configured address of the control plane under test (no hostname row is stored for it). */
const ORIGIN = 'https://rotation.example.test'

type Answer = { status: number; body: Awaited<ReturnType<Response['json']>> }

type Harness = {
  db: Db
  rootId: string
  /** The identity the routes load; a test swaps it to stand for a new High Availability secret. */
  key: { loaded: PanelIdentity }
  a: Credential
  b: Credential
  stranger: Credential
  post: (path: string, body: unknown) => Promise<Answer>
  del: (path: string) => Promise<Answer>
  get: (path: string) => Promise<Answer>
}

/** A clean chain, one superadmin with three sign-in passkeys, and the routes on `runtime`. */
async function withRotationRoutes(
  runtime: 'deno' | 'workers',
  run: (h: Harness) => Promise<void>
): Promise<void> {
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
    await db.delete(custodian)
    await db.delete(rotation)
    await db.delete(setting).where(eq(setting.key, PANEL_IDENTITY_SETTING_KEY))
    const key = { loaded: await ensurePanelIdentity(db, dataEncryption) }

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
      runtime,
      dataEncryption,
      panelIdentity: () => Promise.resolve(key.loaded),
      onIdentityChanged: async () => {
        key.loaded = (await resolvePanelIdentityFromDb(db, dataEncryption)) ?? key.loaded
      },
      configuredOrigin: () => Promise.resolve(ORIGIN),
    })
    app.route(ADMIN_API_PREFIX, admin)
    const { token } = await createSession(db, root!.id, {})
    const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, sessionSecrets)}`
    const send = async (method: string, path: string, body?: unknown): Promise<Answer> => {
      const res = await app.request(`${BASE}${path}`, {
        method,
        headers: { Cookie: cookie, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      return { status: res.status, body: await res.json() }
    }
    await run({
      db,
      rootId: root!.id,
      key,
      a,
      b,
      stranger,
      post: (path, body) => send('POST', path, body),
      del: (path) => send('DELETE', path),
      get: (path) => send('GET', path),
    })
  } finally {
    await db.delete(custodian)
    await db.delete(rotation)
    if (createdUsers.length > 0) {
      await db.delete(passkey).where(inArray(passkey.userId, createdUsers))
      await db.delete(user).where(inArray(user.id, createdUsers))
    }
    await db.delete(setting).where(eq(setting.key, PANEL_IDENTITY_SETTING_KEY))
    await endDbConnection(db)
  }
}

/** The first marks: both passkeys prove possession in one statement (key set 2). */
async function markBoth(h: Harness): Promise<void> {
  const genesis = await h.post('/statements/prepare', {
    kind: 'passkeys',
    mark: [h.a.rowId, h.b.rowId],
  })
  assertEquals(genesis.status, 200, JSON.stringify(genesis.body))
  assertEquals(genesis.body.rpId, new URL(ORIGIN).hostname)
  assertEquals(genesis.body.possessionCredentialIds.length, 2)
  const onlyOne = await h.post('/statements', {
    statement: genesis.body.statement,
    approvals: await approvalsFor([h.a], genesis.body),
  })
  assertEquals(onlyOne.status, 422)
  const marked = await h.post('/statements', {
    statement: genesis.body.statement,
    approvals: await approvalsFor([h.a, h.b], genesis.body),
  })
  assertEquals(marked.status, 200, JSON.stringify(marked.body))
  assertEquals(marked.body.keyset, 2)
}

test('marks, a rotation and the refusals around them', async () => {
  if (!dbUrl) {
    skipWithoutDatabase('key rotation route tests')
    return
  }
  await withRotationRoutes('deno', async (h) => {
    const { db } = h
    const firstKid = h.key.loaded.current.kid

    // Rotate Key needs two marked passkeys.
    assertEquals((await h.post('/statements/prepare', { kind: 'rotate' })).status, 409)

    await markBoth(h)
    await assertRejects(() => deletePasskey(db, h.rootId, h.a.rowId), PasskeyMarkedError)
    // Someone else's id answers "not found", marked or not.
    assertEquals(await deletePasskey(db, crypto.randomUUID(), h.a.rowId), false)

    // Rotation: a passkey that is not marked cannot approve; a marked one can.
    const rotate = await h.post('/statements/prepare', { kind: 'rotate' })
    assertEquals(rotate.status, 200, JSON.stringify(rotate.body))
    assertEquals(rotate.body.oldFingerprint, firstKid)
    const forged = await h.post('/statements', {
      statement: rotate.body.statement,
      approvals: await approvalsFor([h.stranger], rotate.body),
    })
    assertEquals(forged.status, 422)
    // An approval made on another address of the same hostname is refused here.
    const elsewhere = await h.post('/statements', {
      statement: rotate.body.statement,
      approvals: await approvalsFor([h.b], rotate.body, `${ORIGIN}:9000`),
    })
    assertEquals([elsewhere.status, elsewhere.body.error], [422, 'approval_origin'])
    // Malformed input is a refusal, not a server error.
    const garbled = await h.post('/statements', {
      statement: rotate.body.statement,
      approvals: [{ ...(await approvalsFor([h.b], rotate.body))[0], credentialId: 'A' }],
    })
    assertEquals(garbled.status, 422)
    const rotated = await h.post('/statements', {
      statement: rotate.body.statement,
      approvals: await approvalsFor([h.b], rotate.body),
    })
    assertEquals(rotated.status, 200, JSON.stringify(rotated.body))
    assertEquals(h.key.loaded.current.kid, rotate.body.newFingerprint)
    assertNotEquals(h.key.loaded.current.kid, firstKid)
    assertEquals(h.key.loaded.keyset, 3)

    // The same approval again is refused: the key set moved on.
    const replay = await h.post('/statements', {
      statement: rotate.body.statement,
      approvals: await approvalsFor([h.b], rotate.body),
    })
    assert(replay.status === 409 || replay.status === 422, String(replay.status))

    const chain = await listLiveStatements(db, 0)
    assertEquals(chain.length, 2)
    assertEquals(chain[1]!.statement, rotate.body.statement)
    assertEquals((await listLiveStatements(db, 2)).length, 1)
    // The old key signed the rotation (and the first marks), exactly as servers check it.
    assertEquals(rotated.body.envelope.keySig, chain[1]!.keySig)
    assertEquals(
      await fingerprintRawPublicKey(base64urlDecode(chain[1]!.keySig!.pub)),
      rotate.body.oldFingerprint
    )
    assert(chain[0]!.keySig)

    // Emergency Revoke moves to a key made for it, never to an earlier pending one.
    const abandoned = await h.post('/statements/prepare', { kind: 'rotate' })
    const revoke = await h.post('/statements/prepare', { kind: 'revoke' })
    assertEquals([abandoned.status, revoke.status], [200, 200])
    assertNotEquals(revoke.body.newFingerprint, abandoned.body.newFingerprint)
    assertEquals([rotate.body.approvalsNeeded, revoke.body.approvalsNeeded], [1, 2])
    // A revoke has no old-key signature: one passkey is refused, two different ones pass.
    const oneApproval = await h.post('/statements', {
      statement: revoke.body.statement,
      approvals: await approvalsFor([h.a], revoke.body),
    })
    assertEquals([oneApproval.status, oneApproval.body.error], [422, 'approval_refused'])
    const revoked = await h.post('/statements', {
      statement: revoke.body.statement,
      approvals: await approvalsFor([h.a, h.b], revoke.body),
    })
    assertEquals(revoked.status, 200, JSON.stringify(revoked.body))
    assertEquals(revoked.body.envelope.keySig, undefined)
    assertEquals(h.key.loaded.current.kid, revoke.body.newFingerprint)
  })
})

test('High Availability: a waiting key change blocks other changes and can be cancelled', async () => {
  if (!dbUrl) {
    skipWithoutDatabase('key rotation route tests')
    return
  }
  await withRotationRoutes('workers', async (h) => {
    const { db } = h
    await markBoth(h)

    // Prepared before the rotation: an unmark for the same next key set.
    const unmark = await h.post('/statements/prepare', {
      kind: 'passkeys',
      unmark: [h.b.soft.passkey.id],
    })
    assertEquals(unmark.status, 200, JSON.stringify(unmark.body))

    // The rotation command's key: approved, then waiting for the secret.
    const newKey = await softPanelKey()
    const rotate = await h.post('/statements/prepare', { kind: 'rotate', newKey: newKey.pub })
    assertEquals(rotate.status, 200, JSON.stringify(rotate.body))
    assertEquals(rotate.body.newFingerprint, newKey.kid)
    const approved = await h.post('/statements', {
      statement: rotate.body.statement,
      approvals: await approvalsFor([h.a], rotate.body),
    })
    assertEquals(approved.status, 200, JSON.stringify(approved.body))
    assertEquals([approved.body.state, approved.body.keyset], ['awaiting_key', 3])
    // A waiting change keeps its old-key signature inside the control plane.
    assertEquals(approved.body.envelope.keySig, undefined)
    const download = await h.get('/statements/3')
    assertEquals([download.status, download.body.keySig], [200, undefined])
    // Servers are not served a waiting statement.
    assertEquals((await listLiveStatements(db, 0)).length, 1)

    // While it waits nothing else is prepared or approved.
    const blockedPrepare = await h.post('/statements/prepare', {
      kind: 'passkeys',
      unmark: [h.b.soft.passkey.id],
    })
    assertEquals([blockedPrepare.status, blockedPrepare.body.error], [409, 'awaiting_key'])
    const blockedApprove = await h.post('/statements', {
      statement: unmark.body.statement,
      approvals: await approvalsFor([h.a], unmark.body),
    })
    assertEquals([blockedApprove.status, blockedApprove.body.error], [409, 'awaiting_key'])
    assertEquals((await db.select({ id: custodian.id }).from(custodian)).length, 2)

    // Cancel: only the waiting key set, and it leaves an audit row.
    assertEquals((await h.del('/statements/2')).status, 409)
    assertEquals((await h.del('/statements/9')).status, 404)
    const cancelled = await h.del('/statements/3')
    assertEquals(cancelled.status, 200, JSON.stringify(cancelled.body))
    assertEquals(cancelled.body, { ok: true, keyset: 3, cancelled: true })
    assertEquals((await db.select({ id: rotation.id }).from(rotation)).length, 1)
    const audits = await db
      .select({ context: audit.context })
      .from(audit)
      .where(and(eq(audit.action, 'panel.key.cancel'), eq(audit.actorUserId, h.rootId)))
    assertEquals(audits.length, 1)
    assertEquals((audits[0]!.context as Record<string, unknown>).newFingerprint, newKey.kid)
    assertEquals((await h.del('/statements/3')).status, 404)

    // The way is free again: the same key set number is used by the next change.
    const again = await h.post('/statements/prepare', { kind: 'rotate', newKey: newKey.pub })
    assertEquals([again.status, again.body.keyset], [200, 3])
    const reapproved = await h.post('/statements', {
      statement: again.body.statement,
      approvals: await approvalsFor([h.b], again.body),
    })
    assertEquals(reapproved.status, 200, JSON.stringify(reapproved.body))

    // The secret now holds the new key: the change goes live and can no longer be cancelled.
    h.key.loaded = {
      ...h.key.loaded,
      current: { ...h.key.loaded.current, kid: newKey.kid },
    }
    const tooLate = await h.del('/statements/3')
    assertEquals([tooLate.status, tooLate.body.error], [409, 'not_waiting'])
    const chain = await listLiveStatements(db, 0)
    assertEquals(chain.length, 2)
    assertEquals(chain[1]!.statement, again.body.statement)
    // Live now: served with the signature the old key made at approval.
    assertEquals(
      await fingerprintRawPublicKey(base64urlDecode(chain[1]!.keySig!.pub)),
      again.body.oldFingerprint
    )
  })
})
