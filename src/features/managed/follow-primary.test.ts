/**
 * The follow-primary database helpers against a real Postgres: default engine
 * port lookup, outstanding repoint commands, and publish/enqueue. Skipped
 * without TURBOPANEL_DATABASE_URL, the way every Postgres suite is.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import {
  command,
  datacenter,
  environment,
  ip,
  managed,
  network,
  organization,
  project,
  replica,
  server,
  workspace,
} from '../../db/schema.ts'
import type { CommandEnvelope } from '../commands/envelope.ts'
import type { CommandQueue } from '../commands/queue.ts'
import {
  createCommandRecord,
  getCommandDispatchPayload,
  transitionCommand,
} from '../commands/command-records.ts'
import { enqueueFollowPrimaryOnReplicas } from './follow-primary.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

type ReplicaSpec = {
  status?: string | null
  replicaClass?: 'failover' | 'read'
}

type Cluster = {
  db: ReturnType<typeof createDenoDb>
  organizationId: string
  managedId: string
  primaryMemberId: string
  replicaMemberIds: string[]
  replicaServerIds: string[]
  actorId: string
}

function collectingQueue(): CommandQueue & { sent: CommandEnvelope[] } {
  const sent: CommandEnvelope[] = []
  return {
    sent,
    enqueue: (envelope) => {
      sent.push(envelope)
      return Promise.resolve()
    },
  }
}

function rejectingQueue(): CommandQueue {
  return {
    enqueue: () => Promise.reject(new Error('broker down')),
  }
}

async function withCluster(
  opts: { engine?: string; replicas?: ReplicaSpec[] },
  fn: (cluster: Cluster) => Promise<void>
): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('follow-primary query tests')
    return
  }
  const db = createDenoDb()
  let organizationId: string | undefined
  const replicaSpecs = opts.replicas ?? [{ status: 'ready' }]
  try {
    const [org] = await db
      .insert(organization)
      .values({ name: 'Follow Primary Org' })
      .returning({ id: organization.id })
    organizationId = org!.id
    const [ws] = await db
      .insert(workspace)
      .values({ name: 'Follow Primary Workspace', organizationId })
      .returning({ id: workspace.id })
    const [primaryServer] = await db
      .insert(server)
      .values({
        organizationId,
        name: 'Follow Primary Writer',
        isConnected: true,
        statusChangedAt: new Date().toISOString(),
      })
      .returning({ id: server.id })
    const replicaServers = await Promise.all(
      replicaSpecs.map((_, index) =>
        db
          .insert(server)
          .values({
            organizationId,
            name: `Follow Primary Replica ${index + 1}`,
            isConnected: true,
            statusChangedAt: new Date().toISOString(),
          })
          .returning({ id: server.id })
      )
    )
    const replicaServerIds = replicaServers.map((rows) => rows[0]!.id)
    const [proj] = await db
      .insert(project)
      .values({
        name: 'Follow Primary Project',
        workspaceId: ws!.id,
        organizationId,
        metadata: { type: 'managed', code: opts.engine ?? 'postgres' },
      })
      .returning({ id: project.id })
    const [env] = await db
      .insert(environment)
      .values({ name: 'Production', projectId: proj!.id, serverId: primaryServer!.id })
      .returning({ id: environment.id })
    const [cluster] = await db
      .insert(managed)
      .values({
        environmentId: env!.id,
        serverId: primaryServer!.id,
        name: 'Orders',
        engine: opts.engine ?? 'postgres',
        status: 'ready',
      })
      .returning({ id: managed.id })
    const now = new Date().toISOString()
    const [dc] = await db
      .insert(datacenter)
      .values({
        organizationId,
        name: 'Follow Primary DC',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: datacenter.id })
    const [net] = await db
      .insert(network)
      .values({
        organizationId,
        datacenterId: dc!.id,
        kind: 'datacenter',
        cidr: '10.91.0.0/24',
        name: 'Follow Primary LAN',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: network.id })
    const serverIds = [primaryServer!.id, ...replicaServerIds]
    await Promise.all(
      serverIds.map((serverId, index) =>
        db.insert(ip).values({
          organizationId: organizationId!,
          datacenterId: dc!.id,
          networkId: net!.id,
          serverId: serverId!,
          address: `10.91.0.${10 + index}`,
          allocation: 'dedicated',
          scope: 'datacenter',
          createdAt: now,
          updatedAt: now,
        })
      )
    )
    const [primaryMember] = await db
      .insert(replica)
      .values({
        managedId: cluster!.id,
        serverId: primaryServer!.id,
        role: 'primary',
        isReadEligible: false,
        ordinal: 1,
        privatePort: 45001,
        status: 'ready',
      })
      .returning({ id: replica.id })
    const replicaMembers = await Promise.all(
      replicaSpecs.map((spec, index) =>
        db
          .insert(replica)
          .values({
            managedId: cluster!.id,
            serverId: replicaServerIds[index]!,
            role: 'replica',
            replicaClass: spec.replicaClass ?? 'failover',
            isReadEligible: true,
            ordinal: index + 2,
            replicationTransport: 'datacenter',
            privatePort: 45002 + index,
            status: spec.status ?? 'ready',
          })
          .returning({ id: replica.id })
      )
    )
    await fn({
      db,
      organizationId,
      managedId: cluster!.id,
      primaryMemberId: primaryMember!.id,
      replicaMemberIds: replicaMembers.map((rows) => rows[0]!.id),
      replicaServerIds,
      actorId: primaryServer!.id,
    })
  } finally {
    if (organizationId) await removeOrganization(db, organizationId)
    await endDbConnection(db)
  }
}

async function removeOrganization(
  db: ReturnType<typeof createDenoDb>,
  organizationId: string
): Promise<void> {
  const servers = await db
    .select({ id: server.id })
    .from(server)
    .where(eq(server.organizationId, organizationId))
  const serverIds = servers.map((row) => row.id)
  const projects = await db
    .select({ id: project.id })
    .from(project)
    .where(eq(project.organizationId, organizationId))
  const environments = (
    await Promise.all(
      projects.map((row) =>
        db.select({ id: environment.id }).from(environment).where(eq(environment.projectId, row.id))
      )
    )
  ).flat()
  const clusters = (
    await Promise.all(
      environments.map((row) =>
        db.select({ id: managed.id }).from(managed).where(eq(managed.environmentId, row.id))
      )
    )
  ).flat()
  await Promise.all(
    clusters.map(async (row) => {
      await db.delete(replica).where(eq(replica.managedId, row.id))
      await db.delete(managed).where(eq(managed.id, row.id))
    })
  )
  await Promise.all(serverIds.map((id) => db.delete(command).where(eq(command.serverId, id))))
  await Promise.all(
    environments.map((row) => db.delete(environment).where(eq(environment.id, row.id)))
  )
  await Promise.all(projects.map((row) => db.delete(project).where(eq(project.id, row.id))))
  await db.delete(ip).where(eq(ip.organizationId, organizationId))
  await db.delete(network).where(eq(network.organizationId, organizationId))
  await db.delete(datacenter).where(eq(datacenter.organizationId, organizationId))
  await db.delete(server).where(eq(server.organizationId, organizationId))
  await db.delete(workspace).where(eq(workspace.organizationId, organizationId))
  await db.delete(organization).where(eq(organization.id, organizationId))
}

async function failoverCommandsForManaged(
  db: ReturnType<typeof createDenoDb>,
  managedId: string
): Promise<Array<{ id: string; status: string | null; context: unknown; serverId: string }>> {
  const rows = await db
    .select({
      id: command.id,
      status: command.status,
      context: command.context,
      serverId: command.serverId,
    })
    .from(command)
    .where(eq(command.name, 'managed.ha.failover'))
  return rows.filter((row) => {
    const context = row.context
    if (typeof context !== 'object' || context === null || Array.isArray(context)) return false
    return (context as { managedId?: unknown }).managedId === managedId
  })
}

async function insertFollowPrimaryCommand(
  db: ReturnType<typeof createDenoDb>,
  params: {
    serverId: string
    actorId: string
    managedId: string
    memberId?: string
    context?: unknown
    status?: 'queued' | 'succeeded' | 'failed'
  }
): Promise<string> {
  const record = await createCommandRecord(db, {
    serverId: params.serverId,
    actorType: 'system',
    actorId: params.actorId,
    type: 'managed.ha.failover',
    payload: {
      managedId: params.managedId,
      sourceMemberId: params.memberId ?? params.serverId,
      targetMemberId: params.actorId,
      phase: 'repoint',
      targetHost: '203.0.113.10',
      targetPort: 5432,
    },
    ...(params.context !== undefined
      ? { context: params.context }
      : {
          context: {
            managedId: params.managedId,
            ...(params.memberId ? { memberId: params.memberId } : {}),
          },
        }),
  })
  if (params.status && params.status !== 'queued') {
    await transitionCommand(db, record.id, { status: params.status })
  }
  return record.id
}

test('loadEngineDefaultPort finds the postgres listener and publishes a repoint', async () => {
  await withCluster({}, async (c) => {
    const queue = collectingQueue()
    await enqueueFollowPrimaryOnReplicas(c.db, queue, {
      managedId: c.managedId,
      newPrimaryMemberId: c.primaryMemberId,
      actorId: c.actorId,
      engine: 'postgres',
    })
    const rows = await failoverCommandsForManaged(c.db, c.managedId)
    assertEquals(rows.length, 1)
    assertEquals(rows[0]?.status, 'queued')
    assertEquals(rows[0]?.serverId, c.replicaServerIds[0])
    const context = rows[0]?.context as { memberId?: string; managedId?: string }
    assertEquals(context.memberId, c.replicaMemberIds[0])
    assertEquals(context.managedId, c.managedId)
    const payload = (await getCommandDispatchPayload(c.db, rows[0]!.id)) as {
      phase?: string
      targetMemberId?: string
      sourceMemberId?: string
    }
    assertEquals(payload.phase, 'repoint')
    assertEquals(payload.targetMemberId, c.primaryMemberId)
    assertEquals(payload.sourceMemberId, c.replicaMemberIds[0])
    assertEquals(queue.sent.length, 1)
    assertEquals(queue.sent[0]?.commandId, rows[0]?.id)
    assertEquals(queue.sent[0]?.type, 'managed.ha.failover')
  })
})

test('loadEngineDefaultPort is a no-op when the engine has no default port', async () => {
  await withCluster({ engine: 'redis' }, async (c) => {
    const queue = collectingQueue()
    await enqueueFollowPrimaryOnReplicas(c.db, queue, {
      managedId: c.managedId,
      newPrimaryMemberId: c.primaryMemberId,
      actorId: c.actorId,
    })
    assertEquals(await failoverCommandsForManaged(c.db, c.managedId), [])
    assertEquals(queue.sent.length, 0)
  })
})

test('outstandingFollowPrimaryMemberIds counts queued repoints and ignores terminal ones', async () => {
  await withCluster({ replicas: [{ status: 'ready' }, { status: 'ready' }] }, async (c) => {
    const queuedMemberId = c.replicaMemberIds[0]!
    const terminalMemberId = c.replicaMemberIds[1]!
    await insertFollowPrimaryCommand(c.db, {
      serverId: c.replicaServerIds[0]!,
      actorId: c.actorId,
      managedId: c.managedId,
      memberId: queuedMemberId,
      status: 'queued',
    })
    await insertFollowPrimaryCommand(c.db, {
      serverId: c.replicaServerIds[1]!,
      actorId: c.actorId,
      managedId: c.managedId,
      memberId: terminalMemberId,
      status: 'succeeded',
    })
    await insertFollowPrimaryCommand(c.db, {
      serverId: c.replicaServerIds[1]!,
      actorId: c.actorId,
      managedId: c.managedId,
      context: { managedId: c.managedId },
      status: 'queued',
    })
    await insertFollowPrimaryCommand(c.db, {
      serverId: c.replicaServerIds[0]!,
      actorId: c.actorId,
      managedId: c.managedId,
      context: [{ managedId: c.managedId, memberId: queuedMemberId }],
      status: 'queued',
    })
    const queue = collectingQueue()
    await enqueueFollowPrimaryOnReplicas(c.db, queue, {
      managedId: c.managedId,
      newPrimaryMemberId: c.primaryMemberId,
      actorId: c.actorId,
    })
    const published = (await failoverCommandsForManaged(c.db, c.managedId)).filter((row) => {
      const context = row.context as { memberId?: string }
      return context.memberId === terminalMemberId && row.status === 'queued'
    })
    assertEquals(published.length, 1)
    assertEquals(published[0]?.serverId, c.replicaServerIds[1])
    const skipped = (await failoverCommandsForManaged(c.db, c.managedId)).filter((row) => {
      const context = row.context as { memberId?: string }
      return (
        context.memberId === queuedMemberId && queue.sent.some((item) => item.commandId === row.id)
      )
    })
    assertEquals(skipped.length, 0)
  })
})

test('publishFollowPrimaryCommand marks the record failed when the queue rejects', async () => {
  await withCluster({}, async (c) => {
    await enqueueFollowPrimaryOnReplicas(c.db, rejectingQueue(), {
      managedId: c.managedId,
      newPrimaryMemberId: c.primaryMemberId,
      actorId: c.actorId,
    })
    const rows = await failoverCommandsForManaged(c.db, c.managedId)
    assertEquals(rows.length, 1)
    assertEquals(rows[0]?.status, 'failed')
    const context = rows[0]?.context as { memberId?: string }
    assertEquals(context.memberId, c.replicaMemberIds[0])
  })
})

test('enqueueFollowPrimaryOnReplicas with default deps skips the new primary, old primary, unhealthy members, and outstanding repoints', async () => {
  await withCluster(
    {
      replicas: [
        { status: 'needs_resync' },
        { status: 'failed' },
        { status: 'ready' },
        { status: 'ready' },
      ],
    },
    async (c) => {
      const outstandingMemberId = c.replicaMemberIds[2]!
      const healthyMemberId = c.replicaMemberIds[3]!
      await insertFollowPrimaryCommand(c.db, {
        serverId: c.replicaServerIds[2]!,
        actorId: c.actorId,
        managedId: c.managedId,
        memberId: outstandingMemberId,
        status: 'queued',
      })
      const queue = collectingQueue()
      await enqueueFollowPrimaryOnReplicas(c.db, queue, {
        managedId: c.managedId,
        newPrimaryMemberId: c.primaryMemberId,
        actorId: c.actorId,
        engine: 'postgres',
      })
      const published = (await failoverCommandsForManaged(c.db, c.managedId)).filter((row) =>
        queue.sent.some((item) => item.commandId === row.id)
      )
      assertEquals(published.length, 1)
      const context = published[0]?.context as { memberId?: string }
      assertEquals(context.memberId, healthyMemberId)
      assertEquals(published[0]?.serverId, c.replicaServerIds[3])
      const payload = (await getCommandDispatchPayload(c.db, published[0]!.id)) as {
        phase?: string
      }
      assertEquals(payload.phase, 'repoint')
    }
  )
})
