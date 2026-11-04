import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { organization, server } from '../../db/schema.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { DAEMON_SEALED_SECRETS_FEATURE } from '../../lib/version-wire.ts'
import { listSealedSecretsState, setDaemonSealingKey } from './daemon-sealing-key.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const KEY = { kid: 'K'.repeat(43), pub: 'P'.repeat(43), reportedAt: '2026-11-01T00:00:00.000Z' }

test('a registration stores the key and adds the feature a stale hello dropped', async () => {
  if (!getDatabaseUrl()) {
    skipWithoutDatabase('daemon sealing key registration')
    return
  }
  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'sealing key registration' })
    .returning({ id: organization.id })
  const now = new Date().toISOString()
  const [row] = await db
    .insert(server)
    .values({
      createdAt: now,
      updatedAt: now,
      organizationId: org!.id,
      name: `seal-${crypto.randomUUID().slice(0, 8)}`,
      isConnected: true,
      // What a control plane that did not know the feature stored from hello.
      daemon: { projection: { features: ['tunnel-status-v1'] } },
    })
    .returning({ id: server.id })
  try {
    const before = (await listSealedSecretsState(db)).find((entry) => entry.id === row!.id)
    assertEquals(before?.receivesPlaintext, true)
    assertEquals(before?.advertisesSealedSecrets, false)

    await setDaemonSealingKey(db, row!.id, KEY)
    // A second registration does not add the feature twice.
    await setDaemonSealingKey(db, row!.id, KEY)

    const [stored] = await db
      .select({ daemon: server.daemon, kid: server.sealingKeyKid })
      .from(server)
      .where(eq(server.id, row!.id))
    assertEquals(stored?.kid, KEY.kid)
    assertEquals(stored?.daemon, {
      projection: { features: ['tunnel-status-v1', DAEMON_SEALED_SECRETS_FEATURE] },
    })
    const after = (await listSealedSecretsState(db)).find((entry) => entry.id === row!.id)
    assertEquals(after?.advertisesSealedSecrets, true)
    assertEquals(after?.sealingKey?.kid, KEY.kid)
    assertEquals(after?.receivesPlaintext, false)

    // A later hello that leaves the feature out does not bring plaintext back.
    await db
      .update(server)
      .set({ daemon: { projection: { features: [] } } })
      .where(eq(server.id, row!.id))
    const stripped = (await listSealedSecretsState(db)).find((entry) => entry.id === row!.id)
    assertEquals(stripped?.advertisesSealedSecrets, false)
    assertEquals(stripped?.receivesPlaintext, false)
  } finally {
    await db.delete(server).where(eq(server.id, row!.id))
    await db.delete(organization).where(eq(organization.id, org!.id))
    await endDbConnection(db)
  }
})
