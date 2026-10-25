/**
 * Hosting Accounts (principals) and the project delete: which go with the
 * project, which stay, and how the removal sweep finishes the ones that go.
 * Needs a database.
 */
import { assertEquals } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
import { createDenoDb } from '../../db/connection.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import {
  command,
  environment,
  folder,
  organization,
  principal,
  principalPlacement,
  project,
  server,
  service,
  tenancy,
  workspace,
} from '../../db/schema.ts'
import type { CommandEnvelope } from '../../features/commands/envelope.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import { deleteProjectCascade } from '../../features/projects/project-delete.ts'
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { removeRequestedPrincipal, runPrincipalRemovalSweep } from './removal-sweep.ts'

const test = Deno.test.bind(Deno)
const dbUrl = getDatabaseUrl()

type Db = ReturnType<typeof createDenoDb>

type World = {
  db: Db
  organizationId: string
  serverId: string
  /** A project with one environment and one service. */
  newProject: (name: string) => Promise<{ projectId: string; envId: string; serviceId: string }>
  newPrincipal: (username: string, projectId: string) => Promise<string>
}

function recordingQueue(): { queue: CommandQueue; sent: CommandEnvelope[] } {
  const sent: CommandEnvelope[] = []
  return {
    sent,
    queue: {
      enqueue: (envelope) => {
        sent.push(envelope)
        return Promise.resolve()
      },
    },
  }
}

async function withWorld(fn: (world: World) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('principal removal tests')
    return
  }
  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'Principal Removal Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const [ws] = await db
    .insert(workspace)
    .values({ name: 'Principal Removal Workspace', organizationId })
    .returning({ id: workspace.id })
  const [srv] = await db
    .insert(server)
    .values({ organizationId, name: 'Kore' })
    .returning({ id: server.id })
  const serverId = srv!.id
  const suffix = crypto.randomUUID().slice(0, 6)
  const world: World = {
    db,
    organizationId,
    serverId,
    newProject: async (name) => {
      const [proj] = await db
        .insert(project)
        .values({ name, workspaceId: ws!.id, organizationId })
        .returning({ id: project.id })
      const [env] = await db
        .insert(environment)
        .values({ name: 'production', projectId: proj!.id })
        .returning({ id: environment.id })
      const [svc] = await db
        .insert(service)
        .values({ name: 'web', environmentId: env!.id, composeServiceName: 'web' })
        .returning({ id: service.id })
      return { projectId: proj!.id, envId: env!.id, serviceId: svc!.id }
    },
    newPrincipal: async (username, projectId) => {
      const name = `${username}_${suffix}`
      const [row] = await db
        .insert(principal)
        .values({ organizationId, username: name, appliedUsername: name, projectId })
        .returning({ id: principal.id })
      return row!.id
    },
  }
  try {
    await fn(world)
  } finally {
    await db.delete(folder).where(eq(folder.serverId, serverId))
    await db.delete(command).where(eq(command.serverId, serverId))
    const projects = await db
      .select({ id: project.id })
      .from(project)
      .where(eq(project.organizationId, organizationId))
    const projectIds = projects.map((row) => row.id)
    if (projectIds.length > 0) {
      const envs = await db
        .select({ id: environment.id })
        .from(environment)
        .where(inArray(environment.projectId, projectIds))
      const envIds = envs.map((row) => row.id)
      if (envIds.length > 0) {
        const svcs = await db
          .select({ id: service.id })
          .from(service)
          .where(inArray(service.environmentId, envIds))
        const serviceIds = svcs.map((row) => row.id)
        if (serviceIds.length > 0) {
          await db.delete(tenancy).where(inArray(tenancy.serviceId, serviceIds))
          await db.delete(service).where(inArray(service.id, serviceIds))
        }
        await db.delete(environment).where(inArray(environment.id, envIds))
      }
      await db.delete(project).where(inArray(project.id, projectIds))
    }
    await db.delete(principal).where(eq(principal.organizationId, organizationId))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(workspace).where(eq(workspace.id, ws!.id))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

async function readPrincipal(db: Db, id: string) {
  const [row] = await db
    .select({ projectId: principal.projectId, removalRequestedAt: principal.removalRequestedAt })
    .from(principal)
    .where(eq(principal.id, id))
  return row
}

test('a Hosting Account another project still uses is kept and listed, not removed', async () => {
  await withWorld(async ({ db, newProject, newPrincipal }) => {
    const doomed = await newProject('Doomed')
    const other = await newProject('Other')
    const own = await newPrincipal('own', doomed.projectId)
    const shared = await newPrincipal('shared', doomed.projectId)
    await db.insert(tenancy).values({ principalId: own, serviceId: doomed.serviceId })
    // The other project's service runs as the doomed project's account.
    await db.insert(tenancy).values({ principalId: shared, serviceId: other.serviceId })

    const result = await deleteProjectCascade(db, doomed.projectId)
    assertEquals(result.ok, true)
    if (!result.ok) return
    assertEquals(
      result.cleanup.principals.removed.map((row) => row.id),
      [own]
    )
    assertEquals(
      result.cleanup.principals.kept.map((row) => [row.id, row.usedBy.tenancies]),
      [[shared, 1]]
    )
    assertEquals((await readPrincipal(db, shared))?.removalRequestedAt, null)
    const marked = await readPrincipal(db, own)
    assertEquals(marked?.projectId, null)
    assertEquals(typeof marked?.removalRequestedAt, 'string')
  })
})

test('the removal waits for the folders, then for the server, then retires the account', async () => {
  await withWorld(async ({ db, serverId, newProject, newPrincipal }) => {
    const doomed = await newProject('Waits')
    const owner = await newPrincipal('site', doomed.projectId)
    await db.insert(tenancy).values({ principalId: owner, serviceId: doomed.serviceId })
    await db.update(environment).set({ serverId }).where(eq(environment.id, doomed.envId))
    await db.insert(principalPlacement).values({
      principalId: owner,
      serverId,
      state: 'present',
      home: '/srv/users/site',
      source: 'manual',
    })
    await db.insert(folder).values({
      serverId,
      principalId: owner,
      environmentId: doomed.envId,
      scope: 'production',
      kind: 'service',
      slug: 'web',
      serviceId: doomed.serviceId,
      state: 'present',
    })

    const result = await deleteProjectCascade(db, doomed.projectId)
    assertEquals(result.ok, true)
    const { queue, sent } = recordingQueue()

    // The folder is still on the server: nothing happens yet.
    assertEquals(await removeRequestedPrincipal(db, queue, owner), 'waiting')
    // The host confirmed it gone, but the server is offline now.
    await db.delete(folder).where(eq(folder.principalId, owner))
    assertEquals(await removeRequestedPrincipal(db, queue, owner), 'waiting')
    assertEquals(sent.length, 0)

    await db.update(server).set({ isConnected: true }).where(eq(server.id, serverId))
    assertEquals(await runPrincipalRemovalSweep(db, queue), { removed: 1 })
    assertEquals(await readPrincipal(db, owner), undefined)
    const commands = await db
      .select({ name: command.name, serverId: command.serverId })
      .from(command)
      .where(eq(command.serverId, serverId))
    assertEquals(commands, [{ name: 'server.principals.reconcile', serverId }])
    assertEquals(sent.length, 1)
  })
})

test('a Hosting Account that is used again before its removal keeps its row and loses the mark', async () => {
  await withWorld(async ({ db, serverId, newProject, newPrincipal }) => {
    const doomed = await newProject('Reused')
    const other = await newProject('Keeper')
    const owner = await newPrincipal('again', doomed.projectId)
    // A leftover folder holds the removal back.
    await db.insert(folder).values({
      serverId,
      principalId: owner,
      environmentId: null,
      scope: 'common',
      kind: 'volume',
      slug: 'cache',
      state: 'removing',
    })
    const result = await deleteProjectCascade(db, doomed.projectId)
    assertEquals(result.ok, true)
    await db.insert(tenancy).values({ principalId: owner, serviceId: other.serviceId })

    assertEquals(await removeRequestedPrincipal(db, undefined, owner), 'kept')
    const row = await readPrincipal(db, owner)
    assertEquals(row?.removalRequestedAt, null)
  })
})
