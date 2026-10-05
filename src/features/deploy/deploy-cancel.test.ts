import { assertEquals } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
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
import {
  createCommandRecord,
  getCommandMetadata,
  getCommandRecord,
  transitionCommand,
} from '../commands/command-records.ts'
import type { DeployCancelOutcome } from '../../contracts/cell-protocol.ts'
import { DEPLOY_CANCEL_FEATURE } from '../../lib/version-wire.ts'
import {
  CANCEL_REQUESTED_FLAG,
  type CancelDeployDeps,
  cancelEnvironmentDeploy,
} from './deploy-cancel.ts'
import { upsertDeploymentTargets } from './deployment-records.ts'
import { rolloutOptions } from './rollout.ts'

/** Jest/Mocha-shaped alias so Sonar sees real tests. */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()
const GENERATION = 5

type Fixture = {
  db: ReturnType<typeof createDenoDb>
  environmentId: string
  serverIds: string[]
  commandIds: string[]
  /** Daemon answers per server id; a missing key answers `cancelling`. */
  answers: Map<string, DeployCancelOutcome | 'no_answer'>
  asked: string[]
  deps: CancelDeployDeps
}

/**
 * `count` servers, one deploy command each (generation 5). The first server is
 * `applying`; with `rollout` the rest wait as later batches.
 */
async function withDeploy(
  opts: { count: number; rollout?: boolean; features?: readonly string[] },
  fn: (fixture: Fixture) => Promise<void>
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping deploy-cancel tests: TURBOPANEL_DATABASE_URL not set')
    return
  }
  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'Cancel Test Org' })
    .returning({ id: organization.id })
  const [ws] = await db
    .insert(workspace)
    .values({ name: 'Cancel Workspace', organizationId: org!.id })
    .returning({ id: workspace.id })
  const [proj] = await db
    .insert(project)
    .values({
      name: 'Cancel Project',
      workspaceId: ws!.id,
      organizationId: org!.id,
      options: { compose: emptyComposeDocument() },
    })
    .returning({ id: project.id })
  const [env] = await db
    .insert(environment)
    .values({
      name: 'Cancel Env',
      projectId: proj!.id,
      options: { compose: emptyComposeDocument() },
    })
    .returning({ id: environment.id })
  const environmentId = env!.id
  const now = new Date().toISOString()
  const servers = await db
    .insert(server)
    .values(
      Array.from({ length: opts.count }, (_, index) => ({
        organizationId: org!.id,
        name: `cancel-${index}`,
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
      actorType: 'user',
      actorId: crypto.randomUUID(),
      type: 'environment.deploy',
      payload: { environmentId },
      context: { environmentId, serverId, generation: GENERATION },
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    })
    commandIds.push(record.id)
  }
  await upsertDeploymentTargets(db, {
    environmentId,
    targets: serverIds.map((serverId, index) => ({
      serverId,
      desiredGeneration: GENERATION,
      status: opts.rollout && index > 0 ? 'pending' : 'applying',
      lastCommandId: commandIds[index],
      ...(opts.rollout ? { options: { rollout: rolloutOptions(index, opts.count) } } : {}),
    })),
  })
  const answers = new Map<string, DeployCancelOutcome | 'no_answer'>()
  const asked: string[] = []
  const features = opts.features ?? [DEPLOY_CANCEL_FEATURE]
  const deps: CancelDeployDeps = {
    daemonFeatures: () => Promise.resolve(features),
    requestCancel: (serverId) => {
      asked.push(serverId)
      return Promise.resolve(answers.get(serverId) ?? 'cancelling')
    },
  }
  try {
    await fn({ db, environmentId, serverIds, commandIds, answers, asked, deps })
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

async function deploymentRow(f: Fixture, serverId: string) {
  const [row] = await f.db
    .select()
    .from(deployment)
    .where(eq(deployment.serverId, serverId))
    .limit(1)
  return row
}

test('a queued deploy is cancelled outright and the previous version is untouched', async () => {
  await withDeploy({ count: 1 }, async (f) => {
    const result = await cancelEnvironmentDeploy(
      f.db,
      undefined,
      { environmentId: f.environmentId, deploymentId: f.commandIds[0]! },
      f.deps
    )
    assertEquals(result, { ok: true, state: 'cancelled', serverIds: [f.serverIds[0]] })
    // Nothing was sent to a host: it never started.
    assertEquals(f.asked, [])
    const record = await getCommandRecord(f.db, f.commandIds[0]!)
    assertEquals(record?.status, 'cancelled')
    assertEquals(record?.errorCode, 'deploy_cancelled')
    assertEquals(record?.errorMessage?.startsWith('cancelled: '), true)
    const target = await deploymentRow(f, f.serverIds[0]!)
    assertEquals(target?.status, 'failed')
    assertEquals((target?.metadata as { cancelled?: boolean }).cancelled, true)
    // No generation was applied by a cancelled deploy.
    assertEquals(target?.appliedGeneration, null)
  })
})

test('cancelling twice is a no-op and a finished deploy is refused', async () => {
  await withDeploy({ count: 1 }, async (f) => {
    const params = { environmentId: f.environmentId, deploymentId: f.commandIds[0]! }
    await cancelEnvironmentDeploy(f.db, undefined, params, f.deps)
    assertEquals(await cancelEnvironmentDeploy(f.db, undefined, params, f.deps), {
      ok: true,
      state: 'already_cancelled',
      serverIds: [],
    })
  })
  await withDeploy({ count: 1 }, async (f) => {
    await transitionCommand(f.db, f.commandIds[0]!, { status: 'succeeded' })
    assertEquals(
      await cancelEnvironmentDeploy(
        f.db,
        undefined,
        { environmentId: f.environmentId, deploymentId: f.commandIds[0]! },
        f.deps
      ),
      { ok: false, status: 409, error: 'deploy_not_cancellable' }
    )
    await transitionCommand(f.db, f.commandIds[0]!, { status: 'failed' })
    assertEquals(
      (
        await cancelEnvironmentDeploy(
          f.db,
          undefined,
          { environmentId: f.environmentId, deploymentId: f.commandIds[0]! },
          f.deps
        )
      ).ok,
      false
    )
  })
})

test('a running deploy is asked to stop, reads as cancelling, and stays live until the host ends it', async () => {
  await withDeploy({ count: 1 }, async (f) => {
    await transitionCommand(f.db, f.commandIds[0]!, { status: 'sent' })
    const params = { environmentId: f.environmentId, deploymentId: f.commandIds[0]! }
    const first = await cancelEnvironmentDeploy(f.db, undefined, params, f.deps)
    assertEquals(first, { ok: true, state: 'cancelling', serverIds: [f.serverIds[0]] })
    assertEquals(f.asked, [f.serverIds[0]])
    // Still `sent`: every "is a deploy in progress" check keeps working.
    assertEquals((await getCommandRecord(f.db, f.commandIds[0]!))?.status, 'sent')
    const flagged = await getCommandMetadata(f.db, f.commandIds[0]!)
    assertEquals(typeof flagged?.[CANCEL_REQUESTED_FLAG], 'string')
    // Asking again is harmless and answers the same.
    const second = await cancelEnvironmentDeploy(f.db, undefined, params, f.deps)
    assertEquals(second.ok && second.state, 'cancelling')
    assertEquals((await getCommandRecord(f.db, f.commandIds[0]!))?.status, 'sent')
  })
})

test('a host that says it is too late leaves the deploy running and unflagged', async () => {
  await withDeploy({ count: 1 }, async (f) => {
    await transitionCommand(f.db, f.commandIds[0]!, { status: 'sent' })
    f.answers.set(f.serverIds[0]!, 'too_late')
    assertEquals(
      await cancelEnvironmentDeploy(
        f.db,
        undefined,
        { environmentId: f.environmentId, deploymentId: f.commandIds[0]! },
        f.deps
      ),
      { ok: false, status: 409, error: 'deploy_too_late' }
    )
    const metadata = await getCommandMetadata(f.db, f.commandIds[0]!)
    assertEquals(metadata?.[CANCEL_REQUESTED_FLAG], undefined)
    assertEquals((await getCommandRecord(f.db, f.commandIds[0]!))?.status, 'sent')
  })
})

test('a host with no such deploy (or no answer) is still marked cancelling so a late dispatch is refused', async () => {
  for (const answer of ['not_running', 'no_answer'] as const) {
    await withDeploy({ count: 1 }, async (f) => {
      await transitionCommand(f.db, f.commandIds[0]!, { status: 'dispatching' })
      f.answers.set(f.serverIds[0]!, answer)
      const result = await cancelEnvironmentDeploy(
        f.db,
        undefined,
        { environmentId: f.environmentId, deploymentId: f.commandIds[0]! },
        f.deps
      )
      assertEquals(result.ok && result.state, 'cancelling')
      const metadata = await getCommandMetadata(f.db, f.commandIds[0]!)
      assertEquals(typeof metadata?.[CANCEL_REQUESTED_FLAG], 'string')
    })
  }
})

test('a daemon that cannot cancel is refused before anything changes', async () => {
  await withDeploy({ count: 1, features: ['metrics-v7'] }, async (f) => {
    await transitionCommand(f.db, f.commandIds[0]!, { status: 'sent' })
    assertEquals(
      await cancelEnvironmentDeploy(
        f.db,
        undefined,
        { environmentId: f.environmentId, deploymentId: f.commandIds[0]! },
        f.deps
      ),
      { ok: false, status: 409, error: 'cancel_unsupported' }
    )
    assertEquals(f.asked, [])
    assertEquals(
      (await getCommandMetadata(f.db, f.commandIds[0]!))?.[CANCEL_REQUESTED_FLAG],
      undefined
    )
  })
})

test('a running deploy with no way to reach the daemon is a 503, not a silent success', async () => {
  await withDeploy({ count: 1 }, async (f) => {
    await transitionCommand(f.db, f.commandIds[0]!, { status: 'sent' })
    assertEquals(
      await cancelEnvironmentDeploy(
        f.db,
        undefined,
        { environmentId: f.environmentId, deploymentId: f.commandIds[0]! },
        { daemonFeatures: f.deps.daemonFeatures }
      ),
      { ok: false, status: 503, error: 'daemon_unavailable' }
    )
  })
})

test('another environment or a command that is not a deploy is a 404', async () => {
  await withDeploy({ count: 1 }, async (f) => {
    assertEquals(
      await cancelEnvironmentDeploy(
        f.db,
        undefined,
        { environmentId: crypto.randomUUID(), deploymentId: f.commandIds[0]! },
        f.deps
      ),
      { ok: false, status: 404, error: 'Not found' }
    )
    assertEquals(
      await cancelEnvironmentDeploy(
        f.db,
        undefined,
        { environmentId: f.environmentId, deploymentId: crypto.randomUUID() },
        f.deps
      ),
      { ok: false, status: 404, error: 'Not found' }
    )
    const other = await createCommandRecord(f.db, {
      serverId: f.serverIds[0]!,
      actorType: 'user',
      actorId: crypto.randomUUID(),
      type: 'environment.stop',
      payload: { environmentId: f.environmentId },
      context: { environmentId: f.environmentId, generation: GENERATION },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    assertEquals(
      (
        await cancelEnvironmentDeploy(
          f.db,
          undefined,
          { environmentId: f.environmentId, deploymentId: other.id },
          f.deps
        )
      ).ok,
      false
    )
  })
})

test('cancelling a rolling deploy stops the running server and every batch still waiting', async () => {
  await withDeploy({ count: 3, rollout: true }, async (f) => {
    await transitionCommand(f.db, f.commandIds[0]!, { status: 'sent' })
    // Asking through a waiting server's command cancels the whole deploy.
    const result = await cancelEnvironmentDeploy(
      f.db,
      undefined,
      { environmentId: f.environmentId, deploymentId: f.commandIds[2]! },
      f.deps
    )
    assertEquals(result.ok && result.state, 'cancelling')
    assertEquals(f.asked, [f.serverIds[0]])
    assertEquals((await getCommandRecord(f.db, f.commandIds[0]!))?.status, 'sent')
    for (const index of [1, 2]) {
      assertEquals((await getCommandRecord(f.db, f.commandIds[index]!))?.status, 'cancelled')
      assertEquals((await deploymentRow(f, f.serverIds[index]!))?.status, 'failed')
    }
  })
})

test('a finished command can never be moved back to a live status', async () => {
  await withDeploy({ count: 1 }, async (f) => {
    await cancelEnvironmentDeploy(
      f.db,
      undefined,
      { environmentId: f.environmentId, deploymentId: f.commandIds[0]! },
      f.deps
    )
    // The consumer was mid-dispatch when the cancel landed.
    assertEquals(await transitionCommand(f.db, f.commandIds[0]!, { status: 'dispatching' }), null)
    assertEquals(await transitionCommand(f.db, f.commandIds[0]!, { status: 'sent' }), null)
    assertEquals((await getCommandRecord(f.db, f.commandIds[0]!))?.status, 'cancelled')
  })
})
