import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { and, eq, inArray } from 'drizzle-orm'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import {
  command,
  deployment,
  environment,
  organization,
  project,
  server,
  workspace,
} from '../../db/schema.ts'
import { emptyComposeDocument } from '../compose/index.ts'
import { createCommandRecord, getCommandRecord } from '../commands/command-records.ts'
import type { CommandEnvelope } from '../commands/envelope.ts'
import {
  markDeploymentApplied,
  markDeploymentFailed,
  pruneDrainedDeployments,
  upsertDeploymentTargets,
} from './deployment-records.ts'
import {
  advanceRollout,
  haltRollout,
  nextRolloutStep,
  failTimedOutDeploy,
  readDeployContext,
  readRolloutOptions,
  rolloutOptions,
} from './rollout.ts'
import { sweepStaleCommands } from '../commands/stale-sweep.ts'

/** Jest/Mocha-shaped alias so Sonar sees real tests. */
const test = Deno.test.bind(Deno)

test('rollout options round-trip and reject junk', () => {
  assertEquals(readRolloutOptions({ rollout: rolloutOptions(1, 3) }), { batch: 1, batches: 3 })
  assertEquals(readRolloutOptions({ secretPlan: [] }), null)
  assertEquals(readRolloutOptions(null), null)
  assertEquals(readRolloutOptions({ rollout: { batch: -1, batches: 2 } }), null)
  assertEquals(readRolloutOptions({ rollout: { batch: 0, batches: 0 } }), null)
  assertEquals(readRolloutOptions({ rollout: { batch: '1', batches: 2 } }), null)
})

test('nextRolloutStep waits on a running batch, starts the next, halts on failure', () => {
  const t = (serverId: string, status: string, batch: number) => ({ serverId, status, batch })
  assertEquals(nextRolloutStep([t('a', 'applying', 0), t('b', 'pending', 1)]), { action: 'wait' })
  assertEquals(
    nextRolloutStep([t('a', 'applied', 0), t('b', 'pending', 1), t('c', 'pending', 2)]),
    {
      action: 'start',
      batch: 1,
    }
  )
  assertEquals(nextRolloutStep([t('a', 'applied', 0), t('b', 'applied', 1)]), { action: 'done' })
  assertEquals(nextRolloutStep([t('a', 'failed', 0), t('b', 'pending', 1)]), { action: 'halted' })
  assertEquals(nextRolloutStep([]), { action: 'done' })
})

const dbUrl = getDatabaseUrl()

type Fixture = {
  db: ReturnType<typeof createDenoDb>
  environmentId: string
  serverIds: string[]
  commandIds: string[]
  sent: CommandEnvelope[]
  enqueue: (envelope: CommandEnvelope) => Promise<void>
}

/** Three servers, batches of one: a (applying) then b, c (pending, undelivered). */
async function withRollout(
  fn: (fixture: Fixture) => Promise<void>,
  enqueue?: (envelope: CommandEnvelope) => Promise<void>
): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('rollout tests')
    return
  }
  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'Rollout Test Org' })
    .returning({ id: organization.id })
  const [ws] = await db
    .insert(workspace)
    .values({ name: 'Rollout Workspace', organizationId: org!.id })
    .returning({ id: workspace.id })
  const [proj] = await db
    .insert(project)
    .values({
      name: 'Rollout Project',
      workspaceId: ws!.id,
      organizationId: org!.id,
      options: { compose: emptyComposeDocument() },
    })
    .returning({ id: project.id })
  const [env] = await db
    .insert(environment)
    .values({
      name: 'Rollout Env',
      projectId: proj!.id,
      options: { compose: emptyComposeDocument() },
    })
    .returning({ id: environment.id })
  const environmentId = env!.id
  const now = new Date().toISOString()
  const servers = await db
    .insert(server)
    .values(
      ['a', 'b', 'c'].map((name) => ({
        organizationId: org!.id,
        name: `rollout-${name}`,
        createdAt: now,
        updatedAt: now,
      }))
    )
    .returning({ id: server.id })
  const serverIds = servers.map((row) => row.id)
  const commandIds: string[] = []
  for (const serverId of serverIds) {
    const record = await createCommandRecord(db, {
      serverId,
      actorType: 'system',
      actorId: crypto.randomUUID(),
      type: 'environment.deploy',
      payload: { environmentId },
      context: { environmentId, serverId, generation: 7 },
      // Old clock on purpose: delivery must restart it.
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    })
    commandIds.push(record.id)
  }
  await upsertDeploymentTargets(db, {
    environmentId,
    targets: serverIds.map((serverId, index) => ({
      serverId,
      desiredGeneration: 7,
      status: index === 0 ? 'applying' : 'pending',
      lastCommandId: commandIds[index],
      options: { rollout: rolloutOptions(index, 3) },
    })),
  })
  const sent: CommandEnvelope[] = []
  const record =
    enqueue ?? ((envelope: CommandEnvelope) => Promise.resolve(void sent.push(envelope)))
  try {
    await fn({ db, environmentId, serverIds, commandIds, sent, enqueue: record })
  } finally {
    await db.delete(command).where(inArray(command.serverId, serverIds))
    await db.delete(deployment).where(eq(deployment.environmentId, environmentId))
    await db.delete(environment).where(eq(environment.id, environmentId))
    await db.delete(project).where(eq(project.id, proj!.id))
    await db.delete(server).where(inArray(server.id, serverIds))
    await db.delete(workspace).where(eq(workspace.id, ws!.id))
    await db.delete(organization).where(eq(organization.id, org!.id))
    await endDbConnection(db)
  }
}

async function targetStatus(f: Fixture, serverId: string): Promise<string | undefined> {
  const [row] = await f.db
    .select({ status: deployment.status })
    .from(deployment)
    .where(and(eq(deployment.environmentId, f.environmentId), eq(deployment.serverId, serverId)))
  return row?.status
}

async function markApplied(f: Fixture, serverId: string): Promise<void> {
  await f.db
    .update(deployment)
    .set({ status: 'applied' })
    .where(and(eq(deployment.environmentId, f.environmentId), eq(deployment.serverId, serverId)))
}

test('advanceRollout delivers one batch at a time, each only after the one before is applied', async () => {
  await withRollout(async (f) => {
    const gen = { environmentId: f.environmentId, generation: 7 }
    // Batch 0 still applying: nothing to deliver.
    assertEquals(await advanceRollout(f.db, { enqueue: f.enqueue }, gen), [])
    assertEquals(f.sent.length, 0)

    await markApplied(f, f.serverIds[0]!)
    assertEquals(await advanceRollout(f.db, { enqueue: f.enqueue }, gen), [f.serverIds[1]])
    assertEquals(
      f.sent.map((e) => e.serverId),
      [f.serverIds[1]]
    )
    assertEquals(f.sent[0]?.commandId, f.commandIds[1])
    assertEquals(f.sent[0]?.type, 'environment.deploy')
    assertEquals(await targetStatus(f, f.serverIds[1]!), 'applying')
    assertEquals(await targetStatus(f, f.serverIds[2]!), 'pending')
    // The waiting command got a fresh clock when it was delivered.
    const delivered = await getCommandRecord(f.db, f.commandIds[1]!)
    assertEquals(Date.parse(delivered?.expiresAt ?? '') > Date.now(), true)

    // Called again while batch 1 runs, and twice over: no double delivery.
    assertEquals(await advanceRollout(f.db, { enqueue: f.enqueue }, gen), [])
    await markApplied(f, f.serverIds[1]!)
    const both = await Promise.all([
      advanceRollout(f.db, { enqueue: f.enqueue }, gen),
      advanceRollout(f.db, { enqueue: f.enqueue }, gen),
    ])
    assertEquals(both.flat(), [f.serverIds[2]])
    assertEquals(
      f.sent.map((e) => e.serverId),
      [f.serverIds[1], f.serverIds[2]]
    )

    await markApplied(f, f.serverIds[2]!)
    assertEquals(await advanceRollout(f.db, { enqueue: f.enqueue }, gen), [])
  })
})

test('haltRollout flags every server not yet started and cancels its command', async () => {
  await withRollout(async (f) => {
    await f.db
      .update(deployment)
      .set({ status: 'failed' })
      .where(
        and(eq(deployment.environmentId, f.environmentId), eq(deployment.serverId, f.serverIds[0]!))
      )
    const flagged = await haltRollout(f.db, {
      environmentId: f.environmentId,
      generation: 7,
      reason: 'a failed',
    })
    assertEquals(flagged.toSorted(), [f.serverIds[1]!, f.serverIds[2]!].toSorted())
    assertEquals(await targetStatus(f, f.serverIds[1]!), 'failed')
    assertEquals(await targetStatus(f, f.serverIds[2]!), 'failed')
    const cancelled = await getCommandRecord(f.db, f.commandIds[1]!)
    assertEquals(cancelled?.status, 'cancelled')
    assertEquals(cancelled?.errorMessage?.includes('not started'), true)
    // The failed server's own command is left to its own outcome.
    assertEquals((await getCommandRecord(f.db, f.commandIds[0]!))?.status, 'queued')
    // Nothing is delivered after a halt, even if asked.
    const none = await advanceRollout(
      f.db,
      { enqueue: f.enqueue },
      {
        environmentId: f.environmentId,
        generation: 7,
      }
    )
    assertEquals(none, [])
    assertEquals(f.sent.length, 0)
  })
})

test('a queue failure delivering a batch fails that server and stops the rest', async () => {
  const failing = () => Promise.reject(new Error('queue down'))
  await withRollout(async (f) => {
    await markApplied(f, f.serverIds[0]!)
    const delivered = await advanceRollout(
      f.db,
      { enqueue: failing },
      {
        environmentId: f.environmentId,
        generation: 7,
      }
    )
    assertEquals(delivered, [])
    assertEquals(await targetStatus(f, f.serverIds[1]!), 'failed')
    assertEquals(await targetStatus(f, f.serverIds[2]!), 'failed')
    assertEquals((await getCommandRecord(f.db, f.commandIds[1]!))?.status, 'failed')
    assertEquals((await getCommandRecord(f.db, f.commandIds[2]!))?.status, 'cancelled')
  })
})

test('a stale generation is left alone', async () => {
  await withRollout(async (f) => {
    await markApplied(f, f.serverIds[0]!)
    assertEquals(
      await advanceRollout(
        f.db,
        { enqueue: f.enqueue },
        {
          environmentId: f.environmentId,
          generation: 6,
        }
      ),
      []
    )
    assertEquals(f.sent.length, 0)
    assertEquals(await targetStatus(f, f.serverIds[1]!), 'pending')
  })
})

test('readDeployContext reads the environment and generation of a deploy command', () => {
  assertEquals(readDeployContext({ environmentId: 'e', generation: 3, serverId: 's' }), {
    environmentId: 'e',
    generation: 3,
  })
  assertEquals(readDeployContext({ environmentId: 'e' }), null)
  assertEquals(readDeployContext({ generation: 3 }), null)
  assertEquals(readDeployContext(null), null)
})

test('advanceRollout halts a rollout that already has a failed server', async () => {
  await withRollout(async (f) => {
    await f.db
      .update(deployment)
      .set({ status: 'failed' })
      .where(
        and(eq(deployment.environmentId, f.environmentId), eq(deployment.serverId, f.serverIds[0]!))
      )
    const gen = { environmentId: f.environmentId, generation: 7 }
    assertEquals(await advanceRollout(f.db, { enqueue: f.enqueue }, gen), [])
    assertEquals(f.sent.length, 0)
    assertEquals(await targetStatus(f, f.serverIds[1]!), 'failed')
    assertEquals(await targetStatus(f, f.serverIds[2]!), 'failed')
    assertEquals((await getCommandRecord(f.db, f.commandIds[1]!))?.status, 'cancelled')
    assertEquals((await getCommandRecord(f.db, f.commandIds[2]!))?.status, 'cancelled')
  })
})

test('haltRollout without a generation cancels waiting servers of any generation', async () => {
  await withRollout(async (f) => {
    const flagged = await haltRollout(f.db, {
      environmentId: f.environmentId,
      reason: 'the environment was stopped',
    })
    assertEquals(flagged.length, 2)
    assertEquals(await targetStatus(f, f.serverIds[0]!), 'applying')
    assertEquals((await getCommandRecord(f.db, f.commandIds[2]!))?.status, 'cancelled')
  })
})

/** A sweep an hour from now: every command not held is long past its budget. */
function sweepLater(f: Fixture): Promise<number> {
  return sweepStaleCommands(f.db, { now: Date.now() + 3_600_000 })
}

test('the stale sweep timing out an in-flight rollout server flags it and stops the rollout', async () => {
  await withRollout(async (f) => {
    await f.db.update(command).set({ status: 'sent' }).where(eq(command.id, f.commandIds[0]!))
    await sweepLater(f)
    assertEquals((await getCommandRecord(f.db, f.commandIds[0]!))?.status, 'timed_out')
    assertEquals(await targetStatus(f, f.serverIds[0]!), 'failed')
    assertEquals(await targetStatus(f, f.serverIds[1]!), 'failed')
    assertEquals(await targetStatus(f, f.serverIds[2]!), 'failed')
    assertEquals((await getCommandRecord(f.db, f.commandIds[1]!))?.status, 'cancelled')
    assertEquals((await getCommandRecord(f.db, f.commandIds[2]!))?.status, 'cancelled')
    // Nothing is left to deliver.
    assertEquals(
      await advanceRollout(
        f.db,
        { enqueue: f.enqueue },
        {
          environmentId: f.environmentId,
          generation: 7,
        }
      ),
      []
    )
    assertEquals(f.sent.length, 0)
  })
})

test('a batch claimed but never queued (worker died) is failed by the sweep and stops the rollout', async () => {
  await withRollout(async (f) => {
    await markApplied(f, f.serverIds[0]!)
    // Claimed (`applying`), command still `queued`: the worker died before enqueue.
    await f.db
      .update(deployment)
      .set({ status: 'applying' })
      .where(
        and(eq(deployment.environmentId, f.environmentId), eq(deployment.serverId, f.serverIds[1]!))
      )
    await sweepLater(f)
    assertEquals((await getCommandRecord(f.db, f.commandIds[1]!))?.status, 'timed_out')
    assertEquals(await targetStatus(f, f.serverIds[1]!), 'failed')
    assertEquals(await targetStatus(f, f.serverIds[2]!), 'failed')
    assertEquals((await getCommandRecord(f.db, f.commandIds[2]!))?.status, 'cancelled')
  })
})

test('the stale sweep leaves commands that are only waiting their turn alone', async () => {
  await withRollout(async (f) => {
    // Batch 0 finished; batches 1 and 2 are waiting their turn.
    await markApplied(f, f.serverIds[0]!)
    await sweepLater(f)
    assertEquals((await getCommandRecord(f.db, f.commandIds[1]!))?.status, 'queued')
    assertEquals((await getCommandRecord(f.db, f.commandIds[2]!))?.status, 'queued')
    assertEquals(await targetStatus(f, f.serverIds[2]!), 'pending')
  })
})

test('failTimedOutDeploy ignores a command a newer deploy replaced', async () => {
  await withRollout(async (f) => {
    await failTimedOutDeploy(f.db, {
      commandId: f.commandIds[2]!,
      serverId: f.serverIds[0]!,
      context: { environmentId: f.environmentId, generation: 7 },
      error: 'late',
    })
    assertEquals(await targetStatus(f, f.serverIds[0]!), 'applying')
    assertEquals(await targetStatus(f, f.serverIds[1]!), 'pending')
  })
})

/** Gen 7 redeployed as gen 8 while server 1 was still applying gen 7 (command X). */
async function redeployMidRollout(f: Fixture): Promise<{ newCommandIds: string[] }> {
  const newCommandIds: string[] = []
  for (const serverId of f.serverIds) {
    const record = await createCommandRecord(f.db, {
      serverId,
      actorType: 'system',
      actorId: crypto.randomUUID(),
      type: 'environment.deploy',
      payload: { environmentId: f.environmentId },
      context: { environmentId: f.environmentId, serverId, generation: 8 },
    })
    newCommandIds.push(record.id)
  }
  await upsertDeploymentTargets(f.db, {
    environmentId: f.environmentId,
    targets: f.serverIds.map((serverId, index) => ({
      serverId,
      desiredGeneration: 8,
      status: index === 0 ? 'applying' : 'pending',
      lastCommandId: newCommandIds[index],
      options: { rollout: rolloutOptions(index, 3) },
    })),
  })
  return { newCommandIds }
}

test('a late success of the replaced deploy does not mark the new deploy applied', async () => {
  await withRollout(async (f) => {
    await redeployMidRollout(f)
    const marked = await markDeploymentApplied(f.db, {
      environmentId: f.environmentId,
      serverId: f.serverIds[0]!,
      generation: 7,
      commandId: f.commandIds[0]!,
      expectedCommandId: f.commandIds[0]!,
    })
    assertEquals(marked, null)
    assertEquals(await targetStatus(f, f.serverIds[0]!), 'applying')
    assertEquals(await targetStatus(f, f.serverIds[1]!), 'pending')
  })
})

test('a late failure of the replaced deploy does not halt the new deploy', async () => {
  await withRollout(async (f) => {
    await redeployMidRollout(f)
    const marked = await markDeploymentFailed(f.db, {
      environmentId: f.environmentId,
      serverId: f.serverIds[0]!,
      error: 'late',
      commandId: f.commandIds[0]!,
      expectedCommandId: f.commandIds[0]!,
    })
    assertEquals(marked, null)
    await failTimedOutDeploy(f.db, {
      commandId: f.commandIds[0]!,
      serverId: f.serverIds[0]!,
      context: { environmentId: f.environmentId, generation: 7 },
      error: 'late',
    })
    assertEquals(await targetStatus(f, f.serverIds[0]!), 'applying')
    assertEquals(await targetStatus(f, f.serverIds[1]!), 'pending')
    assertEquals(await targetStatus(f, f.serverIds[2]!), 'pending')
  })
})

test('the new deploy still reaches the held server after the replaced one reports', async () => {
  await withRollout(async (f) => {
    const { newCommandIds } = await redeployMidRollout(f)
    await markDeploymentApplied(f.db, {
      environmentId: f.environmentId,
      serverId: f.serverIds[1]!,
      generation: 7,
      commandId: f.commandIds[1]!,
      expectedCommandId: f.commandIds[1]!,
    })
    await markApplied(f, f.serverIds[0]!)
    const delivered = await advanceRollout(
      f.db,
      { enqueue: f.enqueue },
      {
        environmentId: f.environmentId,
        generation: 8,
      }
    )
    assertEquals(delivered, [f.serverIds[1]])
    assertEquals(f.sent[0]?.commandId, newCommandIds[1])
  })
})

test('a late result of the replaced deploy leaves a server it dropped draining', async () => {
  await withRollout(async (f) => {
    // The redeploy keeps servers b and c and drains a, which was still applying.
    await upsertDeploymentTargets(f.db, {
      environmentId: f.environmentId,
      targets: [{ serverId: f.serverIds[0]!, desiredGeneration: 8, status: 'draining' }],
    })
    const applied = await markDeploymentApplied(f.db, {
      environmentId: f.environmentId,
      serverId: f.serverIds[0]!,
      generation: 7,
      commandId: f.commandIds[0]!,
      expectedCommandId: f.commandIds[0]!,
    })
    assertEquals(applied, null)
    const failed = await markDeploymentFailed(f.db, {
      environmentId: f.environmentId,
      serverId: f.serverIds[0]!,
      error: 'late',
      commandId: f.commandIds[0]!,
      expectedCommandId: f.commandIds[0]!,
    })
    assertEquals(failed, null)
    assertEquals(await targetStatus(f, f.serverIds[0]!), 'draining')
    await pruneDrainedDeployments(f.db, { environmentId: f.environmentId })
    assertEquals(await targetStatus(f, f.serverIds[0]!), undefined)
    assertEquals(await targetStatus(f, f.serverIds[1]!), 'pending')
  })
})

test('advanceRollout leaves the clock of a command already in flight alone', async () => {
  await withRollout(async (f) => {
    await markApplied(f, f.serverIds[0]!)
    // Batch 1's command was already sent by a racing caller; its clock stays.
    const expiresAt = new Date(Date.now() - 1000).toISOString()
    await f.db
      .update(command)
      .set({ status: 'sent', expiresAt })
      .where(eq(command.id, f.commandIds[1]!))
    await advanceRollout(
      f.db,
      { enqueue: f.enqueue },
      { environmentId: f.environmentId, generation: 7 }
    )
    assertEquals((await getCommandRecord(f.db, f.commandIds[1]!))?.expiresAt, expiresAt)
  })
})
