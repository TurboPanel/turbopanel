/**
 * The whole-host-loss queries against a real Postgres: who counts as an
 * offline primary, the facts about its server, the org's server counts, and
 * which demoted members the return fence sees. Skipped without
 * TURBOPANEL_DATABASE_URL, the way every Postgres suite is.
 */
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { deriveEncryptionSecretsConfig } from '../../lib/secrets/secrets.ts'
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import {
  command,
  container,
  datacenter,
  environment,
  ip,
  managed,
  network,
  organization,
  project,
  recovery,
  replica,
  server,
  service,
  workspace,
} from '../../db/schema.ts'
import type { CommandEnvelope } from '../commands/envelope.ts'
import type { CommandQueue } from '../commands/queue.ts'
import { createCommandRecord, getCommandDispatchPayload } from '../commands/command-records.ts'
import { onPromoteSucceeded } from './ha-recovery.ts'
import { haPrimaryNamesOnServer } from '../alerts/resolve-alert-sender.ts'
import {
  DEFAULT_HOST_LOSS_LOADERS,
  HOST_LOSS_SWEEP_CAP,
  type HostLossLoaders,
  runHostLossSweep,
} from './ha-host-loss-sweep.ts'
import {
  handleBootHoldReport,
  listDemotedOnConnectedServers,
  runReturnFenceSweep,
} from './ha-return-fence.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

type Cluster = {
  db: ReturnType<typeof createDenoDb>
  organizationId: string
  managedId: string
  primaryMemberId: string
  replicaMemberId: string
  primaryServerId: string
  replicaServerId: string
  offlineSince: string
}

/** A pair: primary on a server offline since 3 minutes ago, replica on a connected one. */
async function withPair(fn: (cluster: Cluster) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('host-loss sweep query tests')
    return
  }
  const db = createDenoDb()
  let organizationId: string | undefined
  try {
    const [org] = await db
      .insert(organization)
      .values({ name: 'Host Loss Org' })
      .returning({ id: organization.id })
    organizationId = org!.id
    const [ws] = await db
      .insert(workspace)
      .values({ name: 'Host Loss Workspace', organizationId })
      .returning({ id: workspace.id })
    const offlineSince = new Date(Date.now() - 180_000).toISOString()
    const [primaryServer] = await db
      .insert(server)
      .values({
        organizationId,
        name: 'Host Loss Primary',
        isConnected: false,
        statusChangedAt: offlineSince,
        daemon: { projection: { offlineReason: 'sweep_stale' } },
      })
      .returning({ id: server.id })
    const [replicaServer] = await db
      .insert(server)
      .values({
        organizationId,
        name: 'Host Loss Replica',
        isConnected: true,
        statusChangedAt: new Date().toISOString(),
      })
      .returning({ id: server.id })
    const [proj] = await db
      .insert(project)
      .values({
        name: 'Host Loss Project',
        workspaceId: ws!.id,
        organizationId,
        metadata: { type: 'managed', code: 'postgres' },
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
        engine: 'postgres',
        status: 'ready',
      })
      .returning({ id: managed.id })
    const [primaryMember] = await db
      .insert(replica)
      .values({
        managedId: cluster!.id,
        serverId: primaryServer!.id,
        role: 'primary',
        isReadEligible: false,
        ordinal: 1,
      })
      .returning({ id: replica.id })
    const [replicaMember] = await db
      .insert(replica)
      .values({
        managedId: cluster!.id,
        serverId: replicaServer!.id,
        role: 'replica',
        replicaClass: 'failover',
        isReadEligible: true,
        ordinal: 2,
      })
      .returning({ id: replica.id })
    await fn({
      db,
      organizationId,
      managedId: cluster!.id,
      primaryMemberId: primaryMember!.id,
      replicaMemberId: replicaMember!.id,
      primaryServerId: primaryServer!.id,
      replicaServerId: replicaServer!.id,
      offlineSince,
    })
  } finally {
    // Other suites share this database (the firewall sweep, for one, looks at
    // every connected server): leave nothing behind.
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
      await db.delete(recovery).where(eq(recovery.managedId, row.id))
      await db.delete(replica).where(eq(replica.managedId, row.id))
      await db.delete(managed).where(eq(managed.id, row.id))
    })
  )
  await Promise.all(serverIds.map((id) => db.delete(command).where(eq(command.serverId, id))))
  // The post-promote ingress step may have created a service row in the environment.
  const services = await db
    .select({ id: service.id })
    .from(service)
    .where(
      inArray(
        service.environmentId,
        environments.map((row) => row.id)
      )
    )
  await Promise.all(
    services.map((row) => db.delete(container).where(eq(container.serviceId, row.id)))
  )
  await Promise.all(services.map((row) => db.delete(service).where(eq(service.id, row.id))))
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

function ours<T extends { managedId: string }>(rows: T[], managedId: string): T[] {
  return rows.filter((row) => row.managedId === managedId)
}

test('an offline primary past the cutoff is listed with its incident facts; a fresher or online one is not', async () => {
  await withPair(async (c) => {
    const past = await DEFAULT_HOST_LOSS_LOADERS.listOfflinePrimaries(c.db, {
      cutoffIso: new Date(Date.now() - 120_000).toISOString(),
      limit: 1000,
    })
    const mine = ours(past, c.managedId)
    assertEquals(mine.length, 1)
    assertEquals(mine[0]?.primaryMemberId, c.primaryMemberId)
    assertEquals(mine[0]?.primaryServerId, c.primaryServerId)
    assertEquals(mine[0]?.organizationId, c.organizationId)
    assertEquals(mine[0]?.engine, 'postgres')
    assertEquals(Date.parse(mine[0]!.offlineSince), Date.parse(c.offlineSince))

    // Offline for less than the window: not a candidate yet.
    const tooFresh = await DEFAULT_HOST_LOSS_LOADERS.listOfflinePrimaries(c.db, {
      cutoffIso: new Date(Date.now() - 600_000).toISOString(),
      limit: 1000,
    })
    assertEquals(ours(tooFresh, c.managedId).length, 0)

    // The host came back: it is no longer offline, so not a candidate.
    await c.db
      .update(server)
      .set({ isConnected: true, statusChangedAt: new Date().toISOString() })
      .where(eq(server.id, c.primaryServerId))
    const back = await DEFAULT_HOST_LOSS_LOADERS.listOfflinePrimaries(c.db, {
      cutoffIso: new Date(Date.now() - 120_000).toISOString(),
      limit: 1000,
    })
    assertEquals(ours(back, c.managedId).length, 0)
  })
})

test('a primary whose daemon socket closed is not a candidate; only a stale-sweep mark is', async () => {
  await withPair(async (c) => {
    const cutoffIso = new Date(Date.now() - 120_000).toISOString()
    const mark = async (reason: 'disconnect' | 'sweep_stale' | null) => {
      await c.db
        .update(server)
        .set({ daemon: reason ? { projection: { offlineReason: reason } } : null })
        .where(eq(server.id, c.primaryServerId))
      const rows = await DEFAULT_HOST_LOSS_LOADERS.listOfflinePrimaries(c.db, {
        cutoffIso,
        limit: 1000,
      })
      return ours(rows, c.managedId).length
    }
    assertEquals(await mark('disconnect'), 0)
    assertEquals(await mark(null), 0)
    assertEquals(await mark('sweep_stale'), 1)
  })
})

test('connected flags, org counts and recent reboots come from the database', async () => {
  await withPair(async (c) => {
    const connected = await DEFAULT_HOST_LOSS_LOADERS.connectedServers(c.db, [
      c.primaryServerId,
      c.replicaServerId,
      crypto.randomUUID(),
    ])
    assertEquals([...connected.values()], [false, true, false])
    assertEquals(await DEFAULT_HOST_LOSS_LOADERS.organizationServers(c.db, c.organizationId), {
      total: 2,
      offline: 1,
    })

    const since = new Date(Date.now() - 600_000).toISOString()
    const before = await DEFAULT_HOST_LOSS_LOADERS.serverFacts(c.db, c.primaryServerId, since)
    assertEquals(before.rebootRecently, false)
    assertEquals(before.updateInFlight, false)
    assertEquals(before.features, [])

    await createCommandRecord(c.db, {
      serverId: c.primaryServerId,
      actorType: 'system',
      actorId: c.primaryServerId,
      type: 'server.reboot',
      payload: {},
    })
    const after = await DEFAULT_HOST_LOSS_LOADERS.serverFacts(c.db, c.primaryServerId, since)
    assertEquals(after.rebootRecently, true)
    // A reboot of another server is not this server's.
    const other = await DEFAULT_HOST_LOSS_LOADERS.serverFacts(c.db, c.replicaServerId, since)
    assertEquals(other.rebootRecently, false)
  })
})

test('the sweep end to end on real queries: a confirmed lost host starts the failover once', async () => {
  await withPair(async (c) => {
    const started: Array<Record<string, unknown>> = []
    const outcomes = await runHostLossSweep(c.db, {
      commandQueue: null,
      autoFailover: 'on',
      probeStandby: () =>
        Promise.resolve({
          state: 'stopped',
          observedAt: new Date().toISOString(),
          lastStreaming: { at: new Date(Date.now() - 170_000).toISOString(), ageMs: 170_000 },
        }),
      windowMs: 120_000,
      loaders: {
        ...onlyThisCluster(c),
        // The pair has no daemon identity row; everything else is the real query.
        serverFacts: () =>
          Promise.resolve({
            features: ['managed-ha-boot-hold-v1'],
            updateInFlight: false,
            rebootRecently: false,
          }),
      },
      beginFailover: (params) => {
        started.push(params as unknown as Record<string, unknown>)
        return Promise.resolve(null)
      },
    })
    const mine = outcomes.filter((outcome) => outcome.managedId === c.managedId)
    assertEquals(mine, [{ managedId: c.managedId, result: 'failover' }])
    assertEquals(started.length >= 1, true)
    const begin = started.find((params) => params.managedId === c.managedId)!
    assertEquals(String(begin.hostLossIncident).startsWith(`${c.primaryServerId}@`), true)
    assertEquals(HOST_LOSS_SWEEP_CAP > 0, true)
  })
})

test('the return fence sees a demoted member on a connected server, and leaves a busy cluster alone', async () => {
  await withPair(async (c) => {
    // The old primary (offline server) was demoted; its server comes back.
    await c.db
      .update(replica)
      .set({ role: 'replica', status: 'needs_resync' })
      .where(eq(replica.id, c.primaryMemberId))
    await c.db.update(replica).set({ role: 'primary' }).where(eq(replica.id, c.replicaMemberId))
    // Still offline: nothing to fence yet.
    assertEquals(
      ours(
        await listDemotedOnConnectedServers(c.db, 1000).then((rows) =>
          rows.map((r) => ({ managedId: r.member.managedId }))
        ),
        c.managedId
      ).length,
      0
    )

    await c.db
      .update(server)
      .set({ isConnected: true, statusChangedAt: new Date().toISOString() })
      .where(eq(server.id, c.primaryServerId))
    const demoted = (await listDemotedOnConnectedServers(c.db, 1000)).filter(
      (row) => row.member.managedId === c.managedId
    )
    assertEquals(
      demoted.map((row) => row.member.id),
      [c.primaryMemberId]
    )
    assertEquals(demoted[0]?.engine, 'postgres')
    assertEquals(demoted[0]?.member.status, 'needs_resync')

    // A resync (or any operation) in progress: leave the cluster alone.
    await c.db.update(managed).set({ status: 'applying' }).where(eq(managed.id, c.managedId))
    const busy = (await listDemotedOnConnectedServers(c.db, 1000)).filter(
      (row) => row.member.managedId === c.managedId
    )
    assertEquals(busy.length, 0)
  })
})

test('the offline alert names the HA database whose primary sits on the lost server', async () => {
  await withPair(async (c) => {
    assertEquals(await haPrimaryNamesOnServer(c.db, c.primaryServerId), 'Orders')
    // The replica's server hosts no primary.
    assertEquals(await haPrimaryNamesOnServer(c.db, c.replicaServerId), null)
  })
})

/** Put both servers of the pair in one datacenter, so the replica is a same-site candidate. */
async function shareDatacenter(c: Cluster): Promise<void> {
  const now = new Date().toISOString()
  const [dc] = await c.db
    .insert(datacenter)
    .values({
      organizationId: c.organizationId,
      name: 'Host Loss DC',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: datacenter.id })
  const [net] = await c.db
    .insert(network)
    .values({
      organizationId: c.organizationId,
      datacenterId: dc!.id,
      kind: 'datacenter',
      cidr: '10.77.0.0/24',
      name: 'Host Loss LAN',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: network.id })
  const pins: Array<[string, string]> = [
    [c.primaryServerId, '10.77.0.10'],
    [c.replicaServerId, '10.77.0.20'],
  ]
  await Promise.all(
    pins.map(([serverId, address]) =>
      c.db.insert(ip).values({
        organizationId: c.organizationId,
        datacenterId: dc!.id,
        networkId: net!.id,
        serverId,
        address,
        allocation: 'dedicated',
        scope: 'datacenter',
        createdAt: now,
        updatedAt: now,
      })
    )
  )
}

/** The real candidate query, narrowed to this test's cluster (the shared database holds others). */
function onlyThisCluster(c: Cluster): Pick<HostLossLoaders, 'listOfflinePrimaries'> {
  return {
    listOfflinePrimaries: async (db, params) =>
      ours(
        await DEFAULT_HOST_LOSS_LOADERS.listOfflinePrimaries(db, { ...params, limit: 1000 }),
        c.managedId
      ),
  }
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

async function commandsOf(c: Cluster, serverId: string, name: string) {
  return (await c.db.select().from(command).where(eq(command.serverId, serverId))).filter(
    (row) => row.name === name
  )
}

test('power cut, failover, power back: the old primary is fenced, never started, and the new one keeps serving', async () => {
  await withPair(async (c) => {
    await shareDatacenter(c)
    const queue = collectingQueue()
    const LSN = '0/3000148'
    // The replica lost its stream when the host died (3 minutes ago), fully replayed.
    const stopped = () =>
      Promise.resolve({
        state: 'stopped',
        observedAt: new Date().toISOString(),
        receivedLsn: LSN,
        replayLsn: LSN,
        lastStreaming: {
          at: new Date(Date.now() - 170_000).toISOString(),
          ageMs: 170_000,
          receiveLagBytes: 0,
          lagSeconds: 3600,
        },
      })
    const sweepDeps = {
      commandQueue: queue,
      autoFailover: 'on' as const,
      probeStandby: stopped,
      windowMs: 120_000,
      loaders: {
        ...onlyThisCluster(c),
        serverFacts: () =>
          Promise.resolve({
            features: ['managed-ha-boot-hold-v1'],
            updateInFlight: false,
            rebootRecently: false,
          }),
      },
    }

    // 1. The sweep decides, promotes the replica, and flags the unreachable old primary.
    const first = (await runHostLossSweep(c.db, sweepDeps)).filter(
      (outcome) => outcome.managedId === c.managedId
    )
    assertEquals(first, [{ managedId: c.managedId, result: 'failover' }])
    const [row] = await c.db.select().from(recovery).where(eq(recovery.managedId, c.managedId))
    assertEquals(row?.state, 'promoting')
    assertEquals(row?.targetMemberId, c.replicaMemberId)
    const meta = row?.metadata as Record<string, unknown>
    assertEquals(meta.fenceBasis, 'host-loss-attested')
    assertEquals(meta.fenced, false)
    assertEquals(meta.detector, 'host-loss')
    // Only a promote went out, to the replica's server; nothing was sent to the dead host.
    assertEquals(
      queue.sent.map((envelope) => [envelope.type, envelope.serverId]),
      [['managed.promote', c.replicaServerId]]
    )
    const [promote] = await commandsOf(c, c.replicaServerId, 'managed.promote')
    const payload = (await getCommandDispatchPayload(c.db, promote!.id)) as Record<string, unknown>
    assertEquals(payload.memberId, c.replicaMemberId)
    assertEquals(payload.demoteMemberId, c.primaryMemberId)
    const [flagged] = await c.db.select().from(replica).where(eq(replica.id, c.primaryMemberId))
    assertEquals(flagged?.status, 'needs_resync')

    // 2. A second tick while the recovery runs does nothing (one failover per incident).
    const again = (await runHostLossSweep(c.db, sweepDeps)).filter(
      (outcome) => outcome.managedId === c.managedId
    )
    assertEquals(again, [{ managedId: c.managedId, result: 'busy' }])
    assertEquals(queue.sent.length, 1)

    // 3. The daemon promoted the replica: the role flip the consumer applies, then the journal.
    await c.db
      .update(replica)
      .set({ role: 'replica', status: 'needs_resync' })
      .where(eq(replica.id, c.primaryMemberId))
    await c.db
      .update(replica)
      .set({ role: 'primary', status: 'ready' })
      .where(eq(replica.id, c.replicaMemberId))
    await c.db.update(managed).set({ status: 'ready' }).where(eq(managed.id, c.managedId))
    // With the secrets present the ingress step runs; the lost host is left out of it,
    // so the row can complete (it could never be confirmed by the offline server).
    const secretsConfig = parseTestSecretsConfig('deno')
    const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
      secretsConfig,
      'data-encryption'
    )
    await onPromoteSucceeded(
      c.db,
      queue,
      { secretsConfig, dataEncryptionSecrets },
      row!.id,
      c.replicaServerId
    )
    const [after] = await c.db.select().from(recovery).where(eq(recovery.id, row!.id))
    // Only the live host must confirm the ingress step; the lost host is left
    // out of it (it is offline and could never answer) and noted as pending its
    // return. This fixture has no daemon identity row, so the live host's own
    // command cannot be built, so the row would end `failed`: the point here is that
    // the lost host is never what blocks it.
    const gate = after?.metadata as Record<string, string[]>
    assertEquals(gate.ingressServerIds, [c.replicaServerId])
    assertEquals(gate.ingressPendingServerIds, [c.primaryServerId])
    assertEquals(gate.ingressNotRepointed?.includes(c.primaryServerId), false)
    // Settle the row as the live host's confirmation would (the rest of the walk-through
    // is about what happens after a COMPLETED failover).
    await c.db.update(recovery).set({ state: 'completed' }).where(eq(recovery.id, row!.id))

    // 4. Power returns. Before the daemon says anything, the sweep fences the demoted member.
    await c.db
      .update(server)
      .set({ isConnected: true, statusChangedAt: new Date().toISOString() })
      .where(eq(server.id, c.primaryServerId))
    const fenced = await runReturnFenceSweep(c.db, queue)
    assertEquals(fenced.filter((id) => id === c.primaryMemberId).length, 1)
    const [stop] = await commandsOf(c, c.primaryServerId, 'managed.lifecycle')
    assertEquals((stop?.metadata as Record<string, unknown>).returnFence, true)
    const stopPayload = (await getCommandDispatchPayload(c.db, stop!.id)) as Record<string, unknown>
    assertEquals(stopPayload.action, 'stop')
    assertEquals(stopPayload.memberId, c.primaryMemberId)
    // One stop per reconnect: the next tick leaves it alone.
    assertEquals(await runReturnFenceSweep(c.db, queue), [])

    // 5. The old primary's daemon reports its boot hold: kept stopped, noted on the journal row.
    const kept = await handleBootHoldReport(c.db, {
      managedId: c.managedId,
      engine: 'postgres',
      sourceMemberId: c.primaryMemberId,
      reporterServerId: c.primaryServerId,
      commandQueue: queue,
    })
    assertEquals(kept, 'kept')
    const [noted] = await c.db.select().from(recovery).where(eq(recovery.id, row!.id))
    assertEquals((noted?.metadata as Record<string, unknown>).returnFence, 'confirmed')
    const [stillStopped] = await c.db
      .select()
      .from(replica)
      .where(eq(replica.id, c.primaryMemberId))
    assertEquals(stillStopped?.status, 'needs_resync')
    assertEquals(stillStopped?.role, 'replica')
    assertEquals(
      (await commandsOf(c, c.primaryServerId, 'managed.lifecycle')).some(
        (cmd) => (cmd.metadata as Record<string, unknown>)?.bootHoldRelease === true
      ),
      false
    )

    // 6. The new primary's own host restarts uncleanly: it IS the primary, so it is told to start.
    const released = await handleBootHoldReport(c.db, {
      managedId: c.managedId,
      engine: 'postgres',
      sourceMemberId: c.replicaMemberId,
      reporterServerId: c.replicaServerId,
      commandQueue: queue,
    })
    assertEquals(released, 'released')
    const starts = await commandsOf(c, c.replicaServerId, 'managed.lifecycle')
    assertEquals(
      starts.some((cmd) => (cmd.metadata as Record<string, unknown>)?.bootHoldRelease === true),
      true
    )
  })
})

test('a blip: the host answers again before the window ends, so the next tick finds nothing and changes nothing', async () => {
  await withPair(async (c) => {
    await shareDatacenter(c)
    // Silent for only 30 s so far.
    await c.db
      .update(server)
      .set({ statusChangedAt: new Date(Date.now() - 30_000).toISOString() })
      .where(eq(server.id, c.primaryServerId))
    const queue = collectingQueue()
    const probes: string[] = []
    const run = () =>
      runHostLossSweep(c.db, {
        commandQueue: queue,
        autoFailover: 'on',
        probeStandby: (target) => {
          probes.push(target.memberId)
          return Promise.resolve(null)
        },
        windowMs: 120_000,
        loaders: onlyThisCluster(c),
      })
    assertEquals(
      (await run()).filter((o) => o.managedId === c.managedId),
      []
    )
    // It comes back; still nothing.
    await c.db
      .update(server)
      .set({ isConnected: true, statusChangedAt: new Date().toISOString() })
      .where(eq(server.id, c.primaryServerId))
    assertEquals(
      (await run()).filter((o) => o.managedId === c.managedId),
      []
    )
    assertEquals(probes, [])
    assertEquals(queue.sent, [])
    assertEquals(
      (await c.db.select().from(recovery).where(eq(recovery.managedId, c.managedId))).length,
      0
    )
  })
})

test('with the switch off the loss is an alert row and nothing else', async () => {
  await withPair(async (c) => {
    await shareDatacenter(c)
    const queue = collectingQueue()
    const outcomes = await runHostLossSweep(c.db, {
      commandQueue: queue,
      autoFailover: 'off',
      probeStandby: () =>
        Promise.resolve({
          state: 'stopped',
          observedAt: new Date().toISOString(),
          lastStreaming: { at: new Date(Date.now() - 170_000).toISOString(), ageMs: 170_000 },
        }),
      windowMs: 120_000,
      loaders: {
        ...onlyThisCluster(c),
        serverFacts: () =>
          Promise.resolve({
            features: ['managed-ha-boot-hold-v1'],
            updateInFlight: false,
            rebootRecently: false,
          }),
      },
    })
    assertEquals(
      outcomes.filter((o) => o.managedId === c.managedId),
      [{ managedId: c.managedId, result: 'failover' }]
    )
    const rows = await c.db.select().from(recovery).where(eq(recovery.managedId, c.managedId))
    assertEquals(rows.length, 1)
    assertEquals(rows[0]?.state, 'blocked')
    assertEquals(rows[0]?.targetMemberId, null)
    assertEquals(queue.sent, [])
    const [stillPrimary] = await c.db
      .select()
      .from(replica)
      .where(eq(replica.id, c.primaryMemberId))
    assertEquals(stillPrimary?.role, 'primary')
    // Untouched: not flagged, not demoted.
    assertEquals(stillPrimary?.status, null)
  })
})
