/**
 * The managed-health report write against a real Postgres: an unchanged
 * reading is skipped until the stored copy is five minutes old, a changed one
 * is written at once. Skipped without TURBOPANEL_DATABASE_URL, the way every
 * Postgres suite is.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import {
  environment,
  managed,
  organization,
  project,
  replica,
  server,
  workspace,
} from '../../db/schema.ts'
import type { ManagedHealthReportMember } from '../../contracts/cell-protocol.ts'
import { handleManagedHealthReport } from './health-report.ts'
import { REPLICA_DISPLAY_REFRESH_MS } from './replica-freshness.ts'

/** Jest/Mocha-shaped alias so Sonar sees the tests (see ha-recovery.hostfree.test.ts). */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()
const NOW_MS = Date.parse('2026-10-06T12:00:00.000Z')
const iso = (offsetMs: number) => new Date(NOW_MS + offsetMs).toISOString()

type Db = ReturnType<typeof createDenoDb>

async function withMember(
  fn: (ctx: { db: Db; managedId: string; memberId: string; serverId: string }) => Promise<void>
): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('health-report write tests')
    return
  }
  const db = createDenoDb()
  let organizationId: string | undefined
  let managedId: string | undefined
  try {
    const [org] = await db
      .insert(organization)
      .values({ name: 'Health Report Org' })
      .returning({ id: organization.id })
    organizationId = org!.id
    const [ws] = await db
      .insert(workspace)
      .values({ name: 'Health Report Workspace', organizationId })
      .returning({ id: workspace.id })
    const [srv] = await db
      .insert(server)
      .values({
        organizationId,
        name: 'Health Report Host',
        isConnected: true,
        statusChangedAt: new Date().toISOString(),
      })
      .returning({ id: server.id })
    const [proj] = await db
      .insert(project)
      .values({
        name: 'Health Report Project',
        workspaceId: ws!.id,
        organizationId,
        kind: 'managed',
        metadata: { code: 'postgres' },
      })
      .returning({ id: project.id })
    const [env] = await db
      .insert(environment)
      .values({ name: 'production', projectId: proj!.id, serverId: srv!.id })
      .returning({ id: environment.id })
    const [cluster] = await db
      .insert(managed)
      .values({
        environmentId: env!.id,
        serverId: srv!.id,
        name: 'Orders',
        engine: 'postgres',
        status: 'ready',
      })
      .returning({ id: managed.id })
    managedId = cluster!.id
    const [member] = await db
      .insert(replica)
      .values({
        managedId,
        serverId: srv!.id,
        role: 'replica',
        replicaClass: 'failover',
        isReadEligible: true,
        ordinal: 2,
        replicationTransport: 'datacenter',
        privatePort: 45002,
        status: 'ready',
      })
      .returning({ id: replica.id })
    await fn({ db, managedId, memberId: member!.id, serverId: srv!.id })
  } finally {
    if (managedId) {
      await db.delete(replica).where(eq(replica.managedId, managedId))
      await db.delete(managed).where(eq(managed.id, managedId))
    }
    if (organizationId) {
      const projects = await db
        .select({ id: project.id })
        .from(project)
        .where(eq(project.organizationId, organizationId))
      for (const row of projects) {
        await db.delete(environment).where(eq(environment.projectId, row.id))
        await db.delete(project).where(eq(project.id, row.id))
      }
      await db.delete(server).where(eq(server.organizationId, organizationId))
      await db.delete(workspace).where(eq(workspace.organizationId, organizationId))
      await db.delete(organization).where(eq(organization.id, organizationId))
    }
    await endDbConnection(db)
  }
}

async function stored(db: Db, memberId: string) {
  const [row] = await db
    .select({ metadata: replica.metadata, updatedAt: replica.updatedAt })
    .from(replica)
    .where(eq(replica.id, memberId))
  const display = (row!.metadata as { replicationDisplay?: Record<string, unknown> } | null)
    ?.replicationDisplay
  return { display, updatedAt: row!.updatedAt }
}

test('an unchanged reading is skipped, a changed one is written, an old unchanged one is written again', async () => {
  await withMember(async ({ db, managedId, memberId, serverId }) => {
    const report = (nowMs: number, state: string, extra: Record<string, unknown> = {}) =>
      handleManagedHealthReport(db, {
        reporterServerId: serverId,
        members: [
          {
            managedId,
            memberId,
            replication: {
              state,
              observedAt: new Date(nowMs - 1000).toISOString(),
              lagBytes: 0,
              receivedLsn: '0/5000148',
              replayLsn: '0/5000148',
              receiptAgeSeconds: 0.25,
              receiptAgeLimitSeconds: 5,
              ...extra,
            } as ManagedHealthReportMember['replication'],
          },
        ],
        nowMs,
      })

    // First report: nothing stored yet, so it is written.
    await report(NOW_MS, 'streaming')
    const first = await stored(db, memberId)
    assertEquals(first.display?.observedAt, iso(-1000))

    // 30 s later, same state: skipped (observedAt and updatedAt do not move).
    await report(NOW_MS + 30_000, 'streaming')
    const skipped = await stored(db, memberId)
    assertEquals(skipped.display?.observedAt, iso(-1000))
    assertEquals(skipped.updatedAt, first.updatedAt)

    // A different state is written at once.
    await report(NOW_MS + 60_000, 'catching_up')
    const changed = await stored(db, memberId)
    assertEquals(changed.display?.state, 'catching_up')
    assertEquals(changed.display?.observedAt, iso(59_000))

    // Same state again, still inside the interval: skipped.
    await report(NOW_MS + 60_000 + REPLICA_DISPLAY_REFRESH_MS - 2000, 'catching_up')
    assertEquals((await stored(db, memberId)).display?.observedAt, iso(59_000))

    // Same state once the stored copy is five minutes old: written.
    const at = NOW_MS + 60_000 + REPLICA_DISPLAY_REFRESH_MS
    await report(at, 'catching_up')
    assertEquals(
      (await stored(db, memberId)).display?.observedAt,
      new Date(at - 1000).toISOString()
    )
  })
})

test('moving positions, daemon-internal fields and lag jitter inside a bucket do not force a write', async () => {
  await withMember(async ({ db, managedId, memberId, serverId }) => {
    const report = (nowMs: number, reading: Record<string, unknown>) =>
      handleManagedHealthReport(db, {
        reporterServerId: serverId,
        members: [
          {
            managedId,
            memberId,
            replication: {
              state: 'streaming',
              observedAt: new Date(nowMs - 1000).toISOString(),
              ...reading,
            } as ManagedHealthReportMember['replication'],
          },
        ],
        nowMs,
      })
    await report(NOW_MS, {
      lagBytes: 1000,
      receiveLagBytes: 1000,
      receivedLsn: '0/5000148',
      replayLsn: '0/5000148',
      receiptAgeSeconds: 0.25,
      receiptAgeLimitSeconds: 5,
    })
    const first = await stored(db, memberId)

    // Only receiptAgeSeconds, the WAL positions and lag inside the same MiB moved: skipped.
    await report(NOW_MS + 30_000, {
      lagBytes: 5000,
      receiveLagBytes: 70_000,
      receivedLsn: '0/5000200',
      replayLsn: '0/5000200',
      receiptAgeSeconds: 3.141592,
      receiptAgeLimitSeconds: 5,
    })
    const skipped = await stored(db, memberId)
    assertEquals(skipped.display, first.display)
    assertEquals(skipped.updatedAt, first.updatedAt)
    assertEquals('receiptAgeSeconds' in (skipped.display ?? {}), false)

    // Lag in another MiB bucket is a change: written with the exact value.
    await report(NOW_MS + 60_000, { lagBytes: 5_000_000, receivedLsn: '0/6000000' })
    const moved = await stored(db, memberId)
    assertEquals(moved.display?.lagBytes, 5_000_000)
    assertEquals(moved.display?.receivedLsn, '0/6000000')
  })
})
