/**
 * The re-seed helpers' SQL against a real Postgres: the cluster lookup and the
 * "is a managed.apply already queued for this member" check. Skipped without
 * TURBOPANEL_DATABASE_URL, the way every Postgres suite is.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import {
  command,
  environment,
  managed,
  organization,
  project,
  replica,
  server,
  workspace,
} from '../../db/schema.ts'
import { createCommandRecord, transitionCommand } from '../commands/command-records.ts'
import { processCommandEnvelope } from '../commands/consumer.ts'
import { getCommandRecord } from '../commands/command-records.ts'
import { findRecoveryById, insertRecovery, updateRecovery } from './recovery-records.ts'
import { RESEED_GUARD_METADATA_KEY, reseedSupersededReason } from './reseed-guard.ts'
import {
  bumpedPrimaryEpochMetadata,
  keepLivePrimaryEpoch,
  loadPrimaryEpoch,
} from './primary-epoch.ts'
import {
  recordNewPrimaryReplayPosition,
  recordOldPrimaryFinalPosition,
} from './switchover-position.ts'
import { evaluateFinalPosition } from './switchover-evidence.ts'
import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import {
  claimReseed,
  hasOutstandingManagedApplyForMember,
  loadManagedApplyCluster,
  reseedDemotedPrimaryAfterSwitchover,
} from './reseed-demoted-primary.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

type Fixture = {
  db: ReturnType<typeof createDenoDb>
  organizationId: string
  environmentId: string
  managedId: string
  serverId: string
  memberIds: string[]
}

async function withCluster(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('reseed-demoted-primary query tests')
    return
  }
  const db = createDenoDb()
  let organizationId: string | undefined
  let serverId: string | undefined
  try {
    const [org] = await db
      .insert(organization)
      .values({ name: 'Reseed Org' })
      .returning({ id: organization.id })
    organizationId = org!.id
    const [ws] = await db
      .insert(workspace)
      .values({ name: 'Reseed Workspace', organizationId })
      .returning({ id: workspace.id })
    const [srv] = await db
      .insert(server)
      .values({
        organizationId,
        name: 'Reseed Writer',
        isConnected: true,
        statusChangedAt: new Date().toISOString(),
      })
      .returning({ id: server.id })
    serverId = srv!.id
    const [replicaSrv] = await db
      .insert(server)
      .values({
        organizationId,
        name: 'Reseed Replica',
        isConnected: true,
        statusChangedAt: new Date().toISOString(),
      })
      .returning({ id: server.id })
    const [proj] = await db
      .insert(project)
      .values({
        name: 'Reseed Project',
        workspaceId: ws!.id,
        organizationId,
        metadata: { type: 'managed', code: 'postgres' },
      })
      .returning({ id: project.id })
    const [env] = await db
      .insert(environment)
      .values({ name: 'production', projectId: proj!.id, serverId })
      .returning({ id: environment.id })
    const [cluster] = await db
      .insert(managed)
      .values({
        environmentId: env!.id,
        serverId,
        name: 'Orders',
        engine: 'postgres',
        status: 'ready',
        options: { settings: {}, databases: ['postgres'] },
      })
      .returning({ id: managed.id })
    const members = await Promise.all(
      [1, 2].map((ordinal) =>
        db
          .insert(replica)
          .values({
            managedId: cluster!.id,
            serverId: ordinal === 1 ? serverId! : replicaSrv!.id,
            role: ordinal === 1 ? 'primary' : 'replica',
            isReadEligible: ordinal !== 1,
            ordinal,
            privatePort: 45000 + ordinal,
            status: 'ready',
          })
          .returning({ id: replica.id })
      )
    )
    await fn({
      db,
      organizationId,
      environmentId: env!.id,
      managedId: cluster!.id,
      serverId,
      memberIds: members.map((rows) => rows[0]!.id),
    })
  } finally {
    if (serverId) await db.delete(command).where(eq(command.serverId, serverId))
    if (organizationId) {
      const projects = await db
        .select({ id: project.id })
        .from(project)
        .where(eq(project.organizationId, organizationId))
      for (const proj of projects) {
        const envs = await db
          .select({ id: environment.id })
          .from(environment)
          .where(eq(environment.projectId, proj.id))
        for (const env of envs) {
          const clusters = await db
            .select({ id: managed.id })
            .from(managed)
            .where(eq(managed.environmentId, env.id))
          for (const row of clusters) {
            await db.delete(replica).where(eq(replica.managedId, row.id))
            await db.delete(managed).where(eq(managed.id, row.id))
          }
          await db.delete(environment).where(eq(environment.id, env.id))
        }
        await db.delete(project).where(eq(project.id, proj.id))
      }
      await db.delete(server).where(eq(server.organizationId, organizationId))
      await db.delete(workspace).where(eq(workspace.organizationId, organizationId))
      await db.delete(organization).where(eq(organization.id, organizationId))
    }
    await endDbConnection(db)
  }
}

async function queueApply(
  f: Fixture,
  params: {
    context: Record<string, unknown>
    metadata?: Record<string, unknown>
    status?: 'succeeded' | 'failed'
  }
): Promise<void> {
  const record = await createCommandRecord(f.db, {
    serverId: f.serverId,
    actorType: 'system',
    actorId: f.serverId,
    type: 'managed.apply',
    payload: { managedId: f.managedId },
    context: params.context,
    ...(params.metadata === undefined ? {} : { metadata: params.metadata }),
  })
  if (params.status) await transitionCommand(f.db, record.id, { status: params.status })
}

test('loadManagedApplyCluster joins the environment and project to find the organization', async () => {
  await withCluster(async (f) => {
    const cluster = await loadManagedApplyCluster(f.db, f.managedId)
    assertEquals(cluster?.id, f.managedId)
    assertEquals(cluster?.environmentId, f.environmentId)
    assertEquals(cluster?.organizationId, f.organizationId)
    assertEquals(cluster?.engine, 'postgres')
    assertEquals(cluster?.serverId, f.serverId)
    assertEquals(await loadManagedApplyCluster(f.db, '00000000-0000-4000-8000-0000000000ff'), null)
  })
})

test('a queued managed.apply for the member counts, by context memberId', async () => {
  await withCluster(async (f) => {
    const [primaryId, replicaId] = f.memberIds
    assertEquals(await hasOutstandingManagedApplyForMember(f.db, f.managedId, replicaId!), false)
    await queueApply(f, { context: { managedId: f.managedId, memberId: replicaId } })
    assertEquals(await hasOutstandingManagedApplyForMember(f.db, f.managedId, replicaId!), true)
    assertEquals(await hasOutstandingManagedApplyForMember(f.db, f.managedId, primaryId!), false)
  })
})

test('a queued managed.apply counts through pendingStandbyApplies metadata', async () => {
  await withCluster(async (f) => {
    const [, replicaId] = f.memberIds
    await queueApply(f, {
      context: { managedId: f.managedId },
      metadata: { pendingStandbyApplies: [{ memberId: replicaId }] },
    })
    assertEquals(await hasOutstandingManagedApplyForMember(f.db, f.managedId, replicaId!), true)
  })
})

test('finished applies and applies for another cluster do not count', async () => {
  await withCluster(async (f) => {
    const [, replicaId] = f.memberIds
    await queueApply(f, {
      context: { managedId: f.managedId, memberId: replicaId },
      status: 'succeeded',
    })
    await queueApply(f, {
      context: { managedId: f.managedId, memberId: replicaId },
      status: 'failed',
    })
    await queueApply(f, {
      context: { managedId: '00000000-0000-4000-8000-0000000000fe', memberId: replicaId },
    })
    assertEquals(await hasOutstandingManagedApplyForMember(f.db, f.managedId, replicaId!), false)
  })
})

test('the re-seed outcome is written on the recovery row next to what was already there', async () => {
  await withCluster(async (f) => {
    const [primaryId, replicaId] = f.memberIds
    const created = await insertRecovery(f.db, {
      managedId: f.managedId,
      kind: 'switchover',
      sourcePrimaryMemberId: primaryId!,
      targetMemberId: replicaId!,
      state: 'repointing',
      metadata: { fenced: true, forced: true },
    })
    await reseedDemotedPrimaryAfterSwitchover(f.db, undefined, {}, created, replicaId!)
    const stored = await findRecoveryById(f.db, created.id)
    assertEquals(stored?.metadata.fenced, true)
    assertEquals(stored?.metadata.reseedState, 'skipped')
    assertEquals(stored?.metadata.reseedNote, 'switchover was forced')
  })
})

async function switchoverFixture(f: Fixture) {
  const [oldPrimaryId, newPrimaryId] = f.memberIds as [string, string]
  // After the switchover: the second member is the primary, the first is the
  // former primary waiting for its re-seed.
  await f.db
    .update(replica)
    .set({ role: 'replica', status: 'needs_resync' })
    .where(eq(replica.id, oldPrimaryId))
  await f.db
    .update(replica)
    .set({ role: 'primary', status: 'ready' })
    .where(eq(replica.id, newPrimaryId))
  const created = await insertRecovery(f.db, {
    managedId: f.managedId,
    kind: 'switchover',
    sourcePrimaryMemberId: oldPrimaryId,
    targetMemberId: newPrimaryId,
    state: 'repointing',
    metadata: { fenced: true },
  })
  return {
    oldPrimaryId,
    newPrimaryId,
    recoveryId: created.id,
    guard: {
      recoveryId: created.id,
      managedId: f.managedId,
      sourceMemberId: oldPrimaryId,
      targetMemberId: newPrimaryId,
    },
  }
}

test('two claims of the same re-seed race and exactly one wins', async () => {
  await withCluster(async (f) => {
    const { recoveryId } = await switchoverFixture(f)
    const results = await Promise.all([
      claimReseed(f.db, recoveryId),
      claimReseed(f.db, recoveryId),
    ])
    assertEquals(results.filter(Boolean).length, 1)
    const stored = await findRecoveryById(f.db, recoveryId)
    assertEquals(stored?.metadata.reseedState, 'queued')
    assertEquals(stored?.metadata.fenced, true)
  })
})

test('the wipe is refused once the new primary, the former primary or the latest recovery changed', async () => {
  await withCluster(async (f) => {
    const { guard, newPrimaryId, oldPrimaryId, recoveryId } = await switchoverFixture(f)
    assertEquals(await reseedSupersededReason(f.db, guard), null)

    // A second recovery started after this switchover.
    await updateRecovery(f.db, recoveryId, { state: 'completed' })
    const later = await insertRecovery(f.db, {
      managedId: f.managedId,
      kind: 'switchover',
      sourcePrimaryMemberId: newPrimaryId,
      targetMemberId: oldPrimaryId,
      state: 'fencing',
    })
    assertEquals(
      await reseedSupersededReason(f.db, guard),
      'another recovery started after the switchover'
    )
    await updateRecovery(f.db, later.id, { state: 'completed' })

    // The new primary was demoted again.
    await f.db.update(replica).set({ role: 'replica' }).where(eq(replica.id, newPrimaryId))
    assertEquals(
      await reseedSupersededReason(f.db, guard),
      'the new primary is no longer the ready primary'
    )
    await f.db
      .update(replica)
      .set({ role: 'primary', status: 'failed' })
      .where(eq(replica.id, newPrimaryId))
    assertEquals(
      await reseedSupersededReason(f.db, guard),
      'the new primary is no longer the ready primary'
    )
  })
})

test('a queued wipe whose switchover was overtaken is cancelled before it is sent', async () => {
  await withCluster(async (f) => {
    const { guard, newPrimaryId } = await switchoverFixture(f)
    await f.db.update(managed).set({ status: 'applying' }).where(eq(managed.id, f.managedId))
    // The new primary was demoted by another switchover before the command ran.
    await f.db.update(replica).set({ role: 'replica' }).where(eq(replica.id, newPrimaryId))
    const record = await createCommandRecord(f.db, {
      serverId: f.serverId,
      actorType: 'system',
      actorId: f.serverId,
      type: 'managed.apply',
      payload: { managedId: f.managedId },
      context: { managedId: f.managedId, memberId: guard.sourceMemberId },
      metadata: { [RESEED_GUARD_METADATA_KEY]: guard },
    })
    await processCommandEnvelope(f.db, {} as DaemonCellRegistry, {
      commandId: record.id,
      serverId: f.serverId,
      type: 'managed.apply',
      attempt: 1,
      queuedAt: record.queuedAt ?? record.createdAt,
    })
    const after = await getCommandRecord(f.db, record.id)
    assertEquals(after?.status, 'failed')
    assertEquals(after?.errorCode, 'reseed_superseded')
    const [row] = await f.db
      .select({ status: managed.status })
      .from(managed)
      .where(eq(managed.id, f.managedId))
    assertEquals(row?.status, 'ready')
  })
})

test('the epoch goes up by one with each bump, keeps the other metadata and restarts from a damaged value', async () => {
  await withCluster(async (f) => {
    assertEquals(await loadPrimaryEpoch(f.db, f.managedId), 0)
    const bump = () =>
      f.db
        .update(managed)
        .set({ metadata: bumpedPrimaryEpochMetadata() })
        .where(eq(managed.id, f.managedId))
    await bump()
    assertEquals(await loadPrimaryEpoch(f.db, f.managedId), 1)
    await f.db
      .update(managed)
      .set({ metadata: { host: 'db.internal', primaryEpoch: 41 } })
      .where(eq(managed.id, f.managedId))
    await bump()
    assertEquals(await loadPrimaryEpoch(f.db, f.managedId), 42)
    const [row] = await f.db
      .select({ metadata: managed.metadata })
      .from(managed)
      .where(eq(managed.id, f.managedId))
    assertEquals((row?.metadata as { host?: string }).host, 'db.internal')
    await f.db
      .update(managed)
      .set({ metadata: { primaryEpoch: 'oops' } })
      .where(eq(managed.id, f.managedId))
    await bump()
    assertEquals(await loadPrimaryEpoch(f.db, f.managedId), 1)
  })
})

test('the wipe is refused once the primary epoch moved after it was queued', async () => {
  await withCluster(async (f) => {
    const { guard } = await switchoverFixture(f)
    assertEquals(await reseedSupersededReason(f.db, { ...guard, epoch: 0 }), null)
    await f.db
      .update(managed)
      .set({ metadata: bumpedPrimaryEpochMetadata() })
      .where(eq(managed.id, f.managedId))
    assertEquals(
      await reseedSupersededReason(f.db, { ...guard, epoch: 0 }),
      'the primary changed after the re-seed was queued'
    )
    assertEquals(await reseedSupersededReason(f.db, { ...guard, epoch: 1 }), null)
    // A guard with no valid epoch cannot be proven current, so the wipe is skipped.
    assertEquals(
      await reseedSupersededReason(f.db, guard),
      'the re-seed carries no valid primary epoch'
    )
  })
})

test('both reported positions are stored on a Postgres switchover and prove the final position', async () => {
  await withCluster(async (f) => {
    const { recoveryId } = await switchoverFixture(f)
    await recordOldPrimaryFinalPosition(f.db, recoveryId, {
      engine: 'postgres',
      lsn: '0/7258050',
      timeline: 1,
    })
    await recordNewPrimaryReplayPosition(f.db, recoveryId, {
      engine: 'postgres',
      lsn: '0/7258050',
      timeline: 2,
    })
    const stored = await findRecoveryById(f.db, recoveryId)
    assertEquals(stored?.metadata.fenced, true)
    assertEquals(stored?.metadata.oldPrimaryFinalLsn, '0/7258050')
    assertEquals(stored?.metadata.newPrimaryTimeline, 2)
    assertEquals(evaluateFinalPosition(stored!.metadata).caughtUp, true)
  })
})

test('a position that is malformed, from another engine, for another kind or after the decision is not stored', async () => {
  await withCluster(async (f) => {
    const { recoveryId, newPrimaryId, oldPrimaryId } = await switchoverFixture(f)
    const attempts = [
      { engine: 'postgres', lsn: 'nonsense', timeline: 1 },
      { engine: 'postgres', lsn: '0/7258050', timeline: 0 },
      { engine: 'postgres', lsn: '0/7258050', timeline: 1.5 },
      { engine: 'postgres', lsn: '0/7258050' },
      { engine: 'mysql', lsn: '0/7258050', timeline: 1 },
    ]
    for (const attempt of attempts) {
      await recordOldPrimaryFinalPosition(f.db, recoveryId, attempt as never)
      await recordNewPrimaryReplayPosition(f.db, recoveryId, attempt)
    }
    const untouched = await findRecoveryById(f.db, recoveryId)
    assertEquals(untouched?.metadata.oldPrimaryFinalLsn, undefined)
    assertEquals(untouched?.metadata.newPrimaryReplayLsn, undefined)

    await updateRecovery(f.db, recoveryId, {
      metadata: { fenced: true, reseedState: 'skipped', reseedNote: 'decided' },
    })
    await recordNewPrimaryReplayPosition(f.db, recoveryId, {
      engine: 'postgres',
      lsn: '0/7258050',
      timeline: 2,
    })
    assertEquals(
      (await findRecoveryById(f.db, recoveryId))?.metadata.newPrimaryReplayLsn,
      undefined
    )
    await updateRecovery(f.db, recoveryId, { state: 'completed' })
    const failover = await insertRecovery(f.db, {
      managedId: f.managedId,
      kind: 'automatic-failover',
      sourcePrimaryMemberId: oldPrimaryId,
      targetMemberId: newPrimaryId,
      state: 'promoting',
    })
    await recordNewPrimaryReplayPosition(f.db, failover.id, {
      engine: 'postgres',
      lsn: '0/7258050',
      timeline: 2,
    })
    assertEquals(
      (await findRecoveryById(f.db, failover.id))?.metadata.newPrimaryReplayLsn,
      undefined
    )
  })
})

test('a metadata rewrite built from an earlier read keeps the epoch the row holds now', async () => {
  await withCluster(async (f) => {
    // The rewrite was prepared while the epoch was still 0.
    const prepared = { host: 'db.internal', replicationUsername: 'tp_repl' }
    await f.db
      .update(managed)
      .set({ metadata: bumpedPrimaryEpochMetadata() })
      .where(eq(managed.id, f.managedId))
    await f.db
      .update(managed)
      .set({ metadata: keepLivePrimaryEpoch(prepared) })
      .where(eq(managed.id, f.managedId))
    assertEquals(await loadPrimaryEpoch(f.db, f.managedId), 1)
    const [row] = await f.db
      .select({ metadata: managed.metadata })
      .from(managed)
      .where(eq(managed.id, f.managedId))
    assertEquals(row?.metadata, { ...prepared, primaryEpoch: 1 })

    // A row that never had an epoch gets none added.
    await f.db.update(managed).set({ metadata: null }).where(eq(managed.id, f.managedId))
    await f.db
      .update(managed)
      .set({ metadata: keepLivePrimaryEpoch(prepared) })
      .where(eq(managed.id, f.managedId))
    const [fresh] = await f.db
      .select({ metadata: managed.metadata })
      .from(managed)
      .where(eq(managed.id, f.managedId))
    assertEquals(fresh?.metadata, prepared)
  })
})
