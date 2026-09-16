/**
 * Database-backed proof that moving the daemon key to its own table closes
 * the lost-update race this migration exists for (schema-child-tables,
 * Road-to-0.1.x): a daemon heartbeat projecting through `projectServerDaemon`
 * can no longer silently un-revoke a key that was just revoked, because the
 * jsonb patch it writes has nothing key-shaped in it to begin with. Skips
 * without `TURBOPANEL_DATABASE_URL`; the migrations must be applied.
 */

import { assertEquals, assertExists } from '@std/assert'
import { eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb, endDbConnection } from '../../db.ts'
import { organization, server } from '../../lib/db/schema.ts'
import {
  attachDaemonStateToServer,
  DaemonKeyRevokedError,
  getServerDaemonStateByServerId,
  revokeDaemonKey,
} from './server-identity-db.ts'
import { projectServerDaemon } from '../cell/postgres-projection.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

async function withEnrolledServer(
  fn: (ctx: { db: ReturnType<typeof createDenoDb>; serverId: string }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping key-table race tests: TURBOPANEL_DATABASE_URL not set')
    return
  }
  const run = `key-race-${crypto.randomUUID().slice(0, 8)}`
  const db = createDenoDb()
  const [org] = await db.insert(organization).values({ name: `Key race ${run}` })
    .returning({ id: organization.id })
  const [srv] = await db.insert(server).values({ organizationId: org!.id })
    .returning({ id: server.id })
  const serverId = srv!.id
  await attachDaemonStateToServer(db, serverId, {
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'race-test' },
    fingerprint: `fp-${run}`,
  })
  try {
    await fn({ db, serverId })
  } finally {
    // server.organization_id is RESTRICT, not CASCADE — the server row
    // (and its cascaded key row) must go before the organization.
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(organization).where(eq(organization.id, org!.id))
    await endDbConnection(db)
  }
}

test('projectServerDaemon flips status for a server whose server.daemon is null but which has a key row', async () => {
  await withEnrolledServer(async ({ db, serverId }) => {
    const before = await getServerDaemonStateByServerId(db, serverId)
    assertExists(before)
    assertEquals(before.status.connected, false)

    const wrote = await projectServerDaemon(db, serverId, { kind: 'online', identity: {} })
    assertEquals(wrote, true)

    const after = await getServerDaemonStateByServerId(db, serverId)
    assertExists(after)
    assertEquals(after.status.connected, true)
    // The key survives a heartbeat write untouched — it was never in the jsonb to lose.
    assertEquals(after.key.id, before.key.id)
    assertEquals(after.key.fingerprint, before.key.fingerprint)
  })
})

test('revokeDaemonKey then a heartbeat projection: revokedAt stays set — the race this table exists to close', async () => {
  await withEnrolledServer(async ({ db, serverId }) => {
    await revokeDaemonKey(db, serverId)
    const revoked = await getServerDaemonStateByServerId(db, serverId)
    assertExists(revoked)
    assertExists(revoked.key.revokedAt)

    // A heartbeat lands after the revoke — the old whole-jsonb-replace
    // writer would have silently restored the pre-revoke key here.
    const wrote = await projectServerDaemon(db, serverId, {
      kind: 'daemon-build',
      daemonBuild: { commit: 'abc123', buildId: 'build-1' },
    })
    assertEquals(wrote, true)

    const after = await getServerDaemonStateByServerId(db, serverId)
    assertExists(after)
    assertExists(after.key.revokedAt)
    assertEquals(after.key.revokedAt, revoked.key.revokedAt)
  })
})

test('attachDaemonStateToServer refuses to replace a revoked key at the row — the atomic half of sticky revocation', async () => {
  await withEnrolledServer(async ({ db, serverId }) => {
    await revokeDaemonKey(db, serverId)
    const revoked = await getServerDaemonStateByServerId(db, serverId)
    assertExists(revoked)
    assertExists(revoked.key.revokedAt)

    // Straight to the upsert, past the enroll route's pre-check — the shape
    // of a revoke that commits between an enroll's read and its write.
    let thrown: unknown = null
    try {
      await attachDaemonStateToServer(db, serverId, {
        publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'attacker-fresh-key' },
        fingerprint: `fp-attacker-${crypto.randomUUID().slice(0, 8)}`,
      })
    } catch (err) {
      thrown = err
    }
    assertEquals(thrown instanceof DaemonKeyRevokedError, true)

    // Nothing moved: same key id, same fingerprint, still revoked, and the
    // server columns the same transaction would have rewritten are untouched.
    const after = await getServerDaemonStateByServerId(db, serverId)
    assertExists(after)
    assertEquals(after.key.id, revoked.key.id)
    assertEquals(after.key.fingerprint, revoked.key.fingerprint)
    assertEquals(after.key.revokedAt, revoked.key.revokedAt)
  })
})
