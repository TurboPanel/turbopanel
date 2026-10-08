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
  cancelNonTerminalCommand,
  createCommandRecord,
  getCommandDispatchPayload,
  transitionCommand,
} from '../commands/command-records.ts'
import { enqueueFollowPrimaryOnReplicas, handleFollowPrimaryFailure } from './follow-primary.ts'

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
  connected?: boolean
}

type Cluster = {
  db: ReturnType<typeof createDenoDb>
  organizationId: string
  managedId: string
  primaryMemberId: string
  primaryServerId: string
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
      replicaSpecs.map((spec, index) =>
        db
          .insert(server)
          .values({
            organizationId,
            name: `Follow Primary Replica ${index + 1}`,
            isConnected: spec.connected !== false,
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
      primaryServerId: primaryServer!.id,
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
    targetMemberId?: string
    context?: unknown
    status?: 'queued' | 'succeeded' | 'failed'
  }
): Promise<string> {
  const targetMemberId = params.targetMemberId ?? params.actorId
  const record = await createCommandRecord(db, {
    serverId: params.serverId,
    actorType: 'system',
    actorId: params.actorId,
    type: 'managed.ha.failover',
    payload: {
      managedId: params.managedId,
      sourceMemberId: params.memberId ?? params.serverId,
      targetMemberId,
      phase: 'repoint',
      engine: 'postgres',
      targetHost: '203.0.113.10',
      targetPort: 5432,
    },
    ...(params.context !== undefined
      ? { context: params.context }
      : {
          context: {
            managedId: params.managedId,
            targetMemberId,
            ...(params.memberId ? { memberId: params.memberId } : {}),
          },
        }),
  })
  if (params.status && params.status !== 'queued') {
    await transitionCommand(db, record.id, { status: params.status })
  }
  return record.id
}

async function payloadFor(
  db: ReturnType<typeof createDenoDb>,
  commandId: string
): Promise<Record<string, unknown>> {
  return (await getCommandDispatchPayload(db, commandId)) as Record<string, unknown>
}

test('loadManagedEnginePort finds the postgres listener and publishes slot-ensure plus a replica repoint', async () => {
  await withCluster({}, async (c) => {
    const queue = collectingQueue()
    await enqueueFollowPrimaryOnReplicas(c.db, queue, {
      managedId: c.managedId,
      newPrimaryMemberId: c.primaryMemberId,
      actorId: c.actorId,
    })
    const rows = await failoverCommandsForManaged(c.db, c.managedId)
    assertEquals(rows.length, 2)
    assertEquals(queue.sent.length, 2)
    const slotRow = rows.find((row) => row.serverId === c.primaryServerId)
    const replicaRow = rows.find((row) => row.serverId === c.replicaServerIds[0])
    assertEquals(slotRow?.status, 'queued')
    assertEquals((slotRow?.context as { memberId?: string }).memberId, c.primaryMemberId)
    const slotPayload = await payloadFor(c.db, slotRow!.id)
    assertEquals(slotPayload.phase, 'repoint')
    assertEquals(slotPayload.engine, 'postgres')
    assertEquals(slotPayload.sourceMemberId, c.primaryMemberId)
    assertEquals(slotPayload.targetMemberId, c.primaryMemberId)
    assertEquals(slotPayload.ensureSlots, ['tp_member_2'])
    assertEquals(slotPayload.targetHost, undefined)
    assertEquals(replicaRow?.status, 'queued')
    const replicaContext = replicaRow?.context as { memberId?: string; managedId?: string }
    assertEquals(replicaContext.memberId, c.replicaMemberIds[0])
    assertEquals(replicaContext.managedId, c.managedId)
    const replicaPayload = await payloadFor(c.db, replicaRow!.id)
    assertEquals(replicaPayload.phase, 'repoint')
    assertEquals(replicaPayload.engine, 'postgres')
    assertEquals(replicaPayload.targetMemberId, c.primaryMemberId)
    assertEquals(replicaPayload.sourceMemberId, c.replicaMemberIds[0])
    assertEquals(
      queue.sent.map((item) => item.type),
      ['managed.ha.failover', 'managed.ha.failover']
    )
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
      targetMemberId: c.primaryMemberId,
      status: 'queued',
    })
    await insertFollowPrimaryCommand(c.db, {
      serverId: c.replicaServerIds[1]!,
      actorId: c.actorId,
      managedId: c.managedId,
      memberId: terminalMemberId,
      targetMemberId: c.primaryMemberId,
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
    assertEquals(rows.length, 2)
    assertEquals(
      rows.map((row) => row.status).sort((a, b) => (a ?? '').localeCompare(b ?? '')),
      ['failed', 'failed']
    )
  })
})

test('enqueueFollowPrimaryOnReplicas with default deps skips the new primary, old primary, unhealthy members, and outstanding repoints', async () => {
  await withCluster(
    {
      replicas: [
        { status: 'needs_resync' },
        { status: 'failed' },
        { status: 'provisioning' },
        { status: 'ready' },
        { status: 'ready' },
      ],
    },
    async (c) => {
      const outstandingMemberId = c.replicaMemberIds[3]!
      const healthyMemberId = c.replicaMemberIds[4]!
      await insertFollowPrimaryCommand(c.db, {
        serverId: c.replicaServerIds[3]!,
        actorId: c.actorId,
        managedId: c.managedId,
        memberId: outstandingMemberId,
        targetMemberId: c.primaryMemberId,
        status: 'queued',
      })
      const queue = collectingQueue()
      await enqueueFollowPrimaryOnReplicas(c.db, queue, {
        managedId: c.managedId,
        newPrimaryMemberId: c.primaryMemberId,
        actorId: c.actorId,
      })
      const published = (await failoverCommandsForManaged(c.db, c.managedId)).filter((row) =>
        queue.sent.some((item) => item.commandId === row.id)
      )
      const replicaPublished = published.filter((row) => row.serverId !== c.primaryServerId)
      assertEquals(replicaPublished.length, 1)
      const context = replicaPublished[0]?.context as { memberId?: string }
      assertEquals(context.memberId, healthyMemberId)
      assertEquals(replicaPublished[0]?.serverId, c.replicaServerIds[4])
      const slotRow = published.find((row) => row.serverId === c.primaryServerId)
      const slotPayload = await payloadFor(c.db, slotRow!.id)
      assertEquals(slotPayload.ensureSlots, ['tp_member_5', 'tp_member_6'])
      assertEquals(slotPayload.engine, 'postgres')
    }
  )
})

test('a non-terminal repoint to a different target is cancelled and replaced', async () => {
  await withCluster({ replicas: [{ status: 'ready' }] }, async (c) => {
    const staleTarget = '00000000-0000-4000-8000-0000000000aa'
    const staleId = await insertFollowPrimaryCommand(c.db, {
      serverId: c.replicaServerIds[0]!,
      actorId: c.actorId,
      managedId: c.managedId,
      memberId: c.replicaMemberIds[0],
      targetMemberId: staleTarget,
      status: 'queued',
    })
    const queue = collectingQueue()
    await enqueueFollowPrimaryOnReplicas(c.db, queue, {
      managedId: c.managedId,
      newPrimaryMemberId: c.primaryMemberId,
      actorId: c.actorId,
    })
    const rows = await failoverCommandsForManaged(c.db, c.managedId)
    const stale = rows.find((row) => row.id === staleId)
    assertEquals(stale?.status, 'cancelled')
    const replacement = rows.filter(
      (row) =>
        row.status === 'queued' &&
        (row.context as { memberId?: string }).memberId === c.replicaMemberIds[0]
    )
    assertEquals(replacement.length, 1)
    const payload = await payloadFor(c.db, replacement[0]!.id)
    assertEquals(payload.targetMemberId, c.primaryMemberId)
  })
})

test('a completed repoint to a different target stays completed', async () => {
  await withCluster({ replicas: [{ status: 'ready' }] }, async (c) => {
    const staleTarget = '00000000-0000-4000-8000-0000000000aa'
    const completedId = await insertFollowPrimaryCommand(c.db, {
      serverId: c.replicaServerIds[0]!,
      actorId: c.actorId,
      managedId: c.managedId,
      memberId: c.replicaMemberIds[0],
      targetMemberId: staleTarget,
      status: 'succeeded',
    })
    assertEquals(
      await cancelNonTerminalCommand(c.db, completedId, {
        error: 'Superseded by a follow-primary to a newer primary',
      }),
      false
    )
    const queue = collectingQueue()
    await enqueueFollowPrimaryOnReplicas(c.db, queue, {
      managedId: c.managedId,
      newPrimaryMemberId: c.primaryMemberId,
      actorId: c.actorId,
    })
    const rows = await failoverCommandsForManaged(c.db, c.managedId)
    const completed = rows.find((row) => row.id === completedId)
    assertEquals(completed?.status, 'succeeded')
    const replacement = rows.filter(
      (row) =>
        row.status === 'queued' &&
        (row.context as { memberId?: string }).memberId === c.replicaMemberIds[0]
    )
    assertEquals(replacement.length, 1)
  })
})

async function replicaStatus(
  db: ReturnType<typeof createDenoDb>,
  memberId: string
): Promise<string | null> {
  const [row] = await db
    .select({ status: replica.status })
    .from(replica)
    .where(eq(replica.id, memberId))
    .limit(1)
  return row?.status ?? null
}

test('a failed slot-ensure is re-queued once with the slotRetry marker', async () => {
  await withCluster({}, async (c) => {
    const payload = {
      managedId: c.managedId,
      sourceMemberId: c.primaryMemberId,
      targetMemberId: c.primaryMemberId,
      phase: 'repoint' as const,
      engine: 'postgres' as const,
      ensureSlots: ['tp_member_2'],
    }
    const failed = await createCommandRecord(c.db, {
      serverId: c.primaryServerId,
      actorType: 'system',
      actorId: c.actorId,
      type: 'managed.ha.failover',
      payload,
      context: { managedId: c.managedId, memberId: c.primaryMemberId },
    })
    await transitionCommand(c.db, failed.id, { status: 'failed', error: 'ensure slots failed' })
    const queue = collectingQueue()
    await handleFollowPrimaryFailure(
      c.db,
      {
        id: failed.id,
        serverId: c.primaryServerId,
        actorId: c.actorId,
        payload,
        context: { managedId: c.managedId, memberId: c.primaryMemberId },
      },
      queue,
      'ensure slots failed'
    )
    const rows = await failoverCommandsForManaged(c.db, c.managedId)
    const retried = rows.filter((row) => row.id !== failed.id)
    assertEquals(retried.length, 1)
    assertEquals(retried[0]?.status, 'queued')
    assertEquals((retried[0]?.context as { slotRetry?: boolean }).slotRetry, true)
    assertEquals((await payloadFor(c.db, retried[0]!.id)).ensureSlots, ['tp_member_2'])
    assertEquals(queue.sent.length, 1)
  })
})

test('a failed slot-ensure that already retried is not re-queued', async () => {
  await withCluster({}, async (c) => {
    const payload = {
      managedId: c.managedId,
      sourceMemberId: c.primaryMemberId,
      targetMemberId: c.primaryMemberId,
      phase: 'repoint' as const,
      engine: 'postgres' as const,
      ensureSlots: ['tp_member_2'],
    }
    const failed = await createCommandRecord(c.db, {
      serverId: c.primaryServerId,
      actorType: 'system',
      actorId: c.actorId,
      type: 'managed.ha.failover',
      payload,
      context: { managedId: c.managedId, memberId: c.primaryMemberId, slotRetry: true },
    })
    const queue = collectingQueue()
    await handleFollowPrimaryFailure(
      c.db,
      {
        id: failed.id,
        serverId: c.primaryServerId,
        actorId: c.actorId,
        payload,
        context: { managedId: c.managedId, memberId: c.primaryMemberId, slotRetry: true },
      },
      queue,
      'ensure slots failed again'
    )
    const rows = await failoverCommandsForManaged(c.db, c.managedId)
    assertEquals(rows.filter((row) => row.id !== failed.id).length, 0)
    assertEquals(queue.sent.length, 0)
  })
})

test('a follow-mode streaming miss flags a ready replica needs_resync', async () => {
  await withCluster({}, async (c) => {
    const replicaId = c.replicaMemberIds[0]!
    await handleFollowPrimaryFailure(
      c.db,
      {
        id: '00000000-0000-4000-8000-0000000000c2',
        serverId: c.replicaServerIds[0]!,
        actorId: c.actorId,
        payload: {
          managedId: c.managedId,
          sourceMemberId: replicaId,
          targetMemberId: c.primaryMemberId,
          phase: 'repoint',
          engine: 'postgres',
          targetHost: '203.0.113.10',
          targetPort: 5432,
        },
        context: { managedId: c.managedId, memberId: replicaId },
      },
      collectingQueue(),
      'standby did not reach streaming after repoint (last state: startup)'
    )
    assertEquals(await replicaStatus(c.db, replicaId), 'needs_resync')
  })
})

test('a follow-mode streaming miss does not touch a primary', async () => {
  await withCluster({}, async (c) => {
    await handleFollowPrimaryFailure(
      c.db,
      {
        id: '00000000-0000-4000-8000-0000000000c3',
        serverId: c.primaryServerId,
        actorId: c.actorId,
        payload: {
          managedId: c.managedId,
          sourceMemberId: c.primaryMemberId,
          targetMemberId: c.primaryMemberId,
          phase: 'repoint',
          engine: 'postgres',
          targetHost: '203.0.113.10',
          targetPort: 5432,
        },
        context: { managedId: c.managedId, memberId: c.primaryMemberId },
      },
      collectingQueue(),
      'standby did not reach streaming after repoint (last state: startup)'
    )
    assertEquals(await replicaStatus(c.db, c.primaryMemberId), 'ready')
  })
})

test('a follow-mode streaming miss does not overwrite needs_resync or other statuses', async () => {
  await withCluster(
    { replicas: [{ status: 'needs_resync' }, { status: 'applying' }, { status: 'failed' }] },
    async (c) => {
      const error = 'standby did not reach streaming after repoint (last state: startup)'
      for (const memberId of c.replicaMemberIds) {
        await handleFollowPrimaryFailure(
          c.db,
          {
            id: memberId,
            serverId: c.replicaServerIds[c.replicaMemberIds.indexOf(memberId)]!,
            actorId: c.actorId,
            payload: {
              managedId: c.managedId,
              sourceMemberId: memberId,
              targetMemberId: c.primaryMemberId,
              phase: 'repoint',
              engine: 'postgres',
              targetHost: '203.0.113.10',
              targetPort: 5432,
            },
            context: { managedId: c.managedId, memberId },
          },
          collectingQueue(),
          error
        )
      }
      assertEquals(await replicaStatus(c.db, c.replicaMemberIds[0]!), 'needs_resync')
      assertEquals(await replicaStatus(c.db, c.replicaMemberIds[1]!), 'applying')
      assertEquals(await replicaStatus(c.db, c.replicaMemberIds[2]!), 'failed')
    }
  )
})

test('other follow-mode error text leaves a ready replica alone', async () => {
  await withCluster({}, async (c) => {
    const replicaId = c.replicaMemberIds[0]!
    await handleFollowPrimaryFailure(
      c.db,
      {
        id: '00000000-0000-4000-8000-0000000000c4',
        serverId: c.replicaServerIds[0]!,
        actorId: c.actorId,
        payload: {
          managedId: c.managedId,
          sourceMemberId: replicaId,
          targetMemberId: c.primaryMemberId,
          phase: 'repoint',
          engine: 'postgres',
          targetHost: '203.0.113.10',
          targetPort: 5432,
        },
        context: { managedId: c.managedId, memberId: replicaId },
      },
      collectingQueue(),
      'could not rewrite recovery.conf'
    )
    assertEquals(await replicaStatus(c.db, replicaId), 'ready')
  })
})
