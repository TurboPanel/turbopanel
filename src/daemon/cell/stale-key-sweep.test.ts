import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
import type { DaemonCell, DaemonCellRegistry } from '../../contracts/cell.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { key, organization, server } from '../../db/schema.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { closeSocketsWithStaleKeys } from './stale-key-sweep.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

type Db = ReturnType<typeof createDenoDb>

async function insertServer(
  db: Db,
  organizationId: string,
  opts: { connected: boolean; revoked: boolean; projectedKeyId?: 'same' | 'other' }
): Promise<string> {
  const now = new Date().toISOString()
  const [row] = await db
    .insert(server)
    .values({
      createdAt: now,
      updatedAt: now,
      organizationId,
      name: `stale-${crypto.randomUUID().slice(0, 8)}`,
      isConnected: opts.connected,
    })
    .returning({ id: server.id })
  const serverId = row!.id
  const [keyRow] = await db
    .insert(key)
    .values({
      serverId,
      algorithm: 'Ed25519',
      publicJwk: { kty: 'OKP', crv: 'Ed25519', x: crypto.randomUUID() },
      fingerprint: crypto.randomUUID(),
      revokedAt: opts.revoked ? now : null,
    })
    .returning({ id: key.id })
  if (opts.projectedKeyId) {
    const keyId = opts.projectedKeyId === 'same' ? keyRow!.id : crypto.randomUUID()
    await db
      .update(server)
      .set({ daemon: { projection: { keyId } } })
      .where(eq(server.id, serverId))
  }
  return serverId
}

function recordingRegistry(dropped: string[]): DaemonCellRegistry {
  return {
    getCell: (serverId: string) =>
      ({
        dropDaemonConnection: (reason: string) => {
          dropped.push(`${serverId}:${reason}`)
          return Promise.resolve()
        },
      }) as unknown as DaemonCell,
  } as unknown as DaemonCellRegistry
}

test('the sweep closes connected sockets whose key was revoked or replaced, and nothing else', async () => {
  if (!getDatabaseUrl()) {
    skipWithoutDatabase('stale key sweep')
    return
  }
  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'stale key sweep' })
    .returning({ id: organization.id })
  const ids: string[] = []
  try {
    const revoked = await insertServer(db, org!.id, { connected: true, revoked: true })
    const replaced = await insertServer(db, org!.id, {
      connected: true,
      revoked: false,
      projectedKeyId: 'other',
    })
    const healthy = await insertServer(db, org!.id, {
      connected: true,
      revoked: false,
      projectedKeyId: 'same',
    })
    const offline = await insertServer(db, org!.id, { connected: false, revoked: true })
    ids.push(revoked, replaced, healthy, offline)

    const dropped: string[] = []
    await closeSocketsWithStaleKeys(db, recordingRegistry(dropped))
    const ours = dropped.filter((entry) => ids.some((id) => entry.startsWith(id)))
    assertEquals(ours.sort(), [`${replaced}:stale-key`, `${revoked}:stale-key`].sort())
  } finally {
    if (ids.length > 0) await db.delete(server).where(inArray(server.id, ids))
    await db.delete(organization).where(eq(organization.id, org!.id))
    await endDbConnection(db)
  }
})
