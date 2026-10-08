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
import {
  hasOutstandingManagedApplyForMember,
  loadManagedApplyCluster,
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
      .values({ name: 'Production', projectId: proj!.id, serverId })
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
