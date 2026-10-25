/**
 * The naming locks that the folder table drives: environment rename and delete,
 * the project slug, and the organization folder-name setting. Needs a database.
 */
import { assertEquals, assertMatch } from '@std/assert'
import { and, eq } from 'drizzle-orm'
import {
  command,
  deployment,
  environment,
  folder,
  hosting,
  principal,
  project,
  server,
  service,
  storage,
} from '../db/schema.ts'
import type { CommandEnvelope } from '../features/commands/envelope.ts'
import { markFoldersPresent, planVolumeFolder } from '../features/folders/allocate.ts'
import { deleteProjectCascade } from '../features/projects/project-delete.ts'
import type { CommandQueue } from '../features/commands/queue.ts'
import { countPrincipalReferences } from '../features/principals/store.ts'
import { loadPrincipalUsage } from '../features/principals/placement-records.ts'
import {
  type Ctx,
  createProject,
  send,
  withFolderFixtures as withFixtures,
} from '../test-fixtures/folder-world.test.support.ts'

const test = Deno.test.bind(Deno)

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

async function ownerLogin(ctx: Ctx): Promise<string> {
  const [row] = await ctx.db
    .select({ login: principal.appliedUsername })
    .from(principal)
    .where(eq(principal.id, ctx.principalId))
  return row!.login
}

async function addServiceFolder(
  ctx: Ctx,
  envId: string,
  slug: string,
  state: 'planned' | 'present' | 'removing' | 'missing' = 'planned',
  scope = 'production'
): Promise<void> {
  const [svc] = await ctx.db
    .insert(service)
    .values({ environmentId: envId, composeServiceName: slug, name: slug, slug })
    .returning({ id: service.id })
  await ctx.db.insert(folder).values({
    serverId: ctx.serverId,
    principalId: ctx.principalId,
    environmentId: envId,
    scope,
    kind: 'service',
    slug,
    serviceId: svc!.id,
    state,
  })
}

test('a new project gets a slug from its name and a clash gets a suffix', async () => {
  await withFixtures(async (ctx) => {
    const first = await createProject(ctx, 'My Shop & Blog')
    const second = await createProject(ctx, 'my shop blog')
    const rows = await ctx.db
      .select({ id: project.id, slug: project.slug })
      .from(project)
      .where(eq(project.organizationId, ctx.organizationId))
    const bySlug = Object.fromEntries(rows.map((row) => [row.id, row.slug]))
    assertEquals(bySlug[first.projectId], 'my-shop-blog')
    assertEquals(bySlug[second.projectId], 'my-shop-blog-2')
    const read = await send(ctx, 'GET', `/projects/${first.projectId}`)
    assertEquals((read.json.project as { slug: string }).slug, 'my-shop-blog')
  })
})

test('PATCH /projects/:id changes the slug until a folder exists under the project', async () => {
  await withFixtures(async (ctx) => {
    const { projectId, envId } = await createProject(ctx, 'Slug Lock')
    const bad = await send(ctx, 'PATCH', `/projects/${projectId}`, { slug: 'Not A Slug' })
    assertEquals(bad.status, 400)
    const ok = await send(ctx, 'PATCH', `/projects/${projectId}`, { slug: 'renamed' })
    assertEquals(ok.status, 200)

    await addServiceFolder(ctx, envId, 'example.com')
    const locked = await send(ctx, 'PATCH', `/projects/${projectId}`, { slug: 'again' })
    assertEquals(locked.status, 409)
    assertEquals(locked.json.error, 'project_slug_locked')
    // The slug it already has is not a change.
    const same = await send(ctx, 'PATCH', `/projects/${projectId}`, { slug: 'renamed' })
    assertEquals(same.status, 200)
  })
})

test('a project slug already used in the organization is refused', async () => {
  await withFixtures(async (ctx) => {
    await createProject(ctx, 'First One')
    const other = await createProject(ctx, 'Second One')
    const clash = await send(ctx, 'PATCH', `/projects/${other.projectId}`, { slug: 'first-one' })
    assertEquals(clash.status, 409)
    assertEquals(clash.json.error, 'project_slug_in_use')
  })
})

test('renaming an environment follows the name rule and is free while no folder exists', async () => {
  await withFixtures(async (ctx) => {
    const { envId } = await createProject(ctx, 'Rename Free')
    for (const name of ['My Env', 'common', 'Staging', 'tmp']) {
      const refused = await send(ctx, 'PATCH', `/environments/${envId}`, { name })
      assertEquals(refused.status, 400, name)
      assertEquals(refused.json.error, 'invalid_environment_name', name)
    }
    const ok = await send(ctx, 'PATCH', `/environments/${envId}`, { name: 'staging_2' })
    assertEquals(ok.status, 200)
    // Editing something else is not a rename, whatever the name looks like.
    const note = await send(ctx, 'PATCH', `/environments/${envId}`, { description: 'x' })
    assertEquals(note.status, 200)
  })
})

test('an environment with a folder cannot be renamed or deleted and the blocking folders are listed', async () => {
  await withFixtures(async (ctx) => {
    const { envId } = await createProject(ctx, 'Rename Locked')
    await addServiceFolder(ctx, envId, 'example.com', 'present')
    await addServiceFolder(ctx, envId, 'blog.example.com', 'removing')

    const refused = await send(ctx, 'PATCH', `/environments/${envId}`, { name: 'staging' })
    assertEquals(refused.status, 409)
    assertEquals(refused.json.error, 'environment_name_locked')
    assertEquals(refused.json.total, 2)
    const listed = refused.json.folders as Array<{
      slug: string
      state: string
      serverName: string
      assetName: string
    }>
    assertEquals(listed.map((row) => row.slug).sort(), ['blog.example.com', 'example.com'])
    assertEquals(listed[0]!.serverName, 'Alpha')
    assertMatch(String(refused.json.message), /cannot change/)

    // Writing the same name is not a rename.
    const [row] = await ctx.db
      .select({ name: environment.name })
      .from(environment)
      .where(eq(environment.id, envId))
    const same = await send(ctx, 'PATCH', `/environments/${envId}`, { name: row!.name })
    assertEquals(same.status, 200)

    const list = await send(ctx, 'GET', `/environments/${envId}/folders`)
    assertEquals(list.status, 200)
    assertEquals(list.json.total, 2)

    // Folders no longer refuse a delete: the plan lists them, and this one is
    // refused only because their server is offline.
    const preview = await send(ctx, 'GET', `/environments/${envId}/delete-preview`)
    assertEquals(preview.status, 200)
    assertEquals(
      (preview.json.folders as Array<{ action: string }>).map((row) => row.action),
      ['remove', 'remove']
    )
    assertEquals(
      (preview.json.blockers as Array<{ error: string }>).map((row) => row.error),
      ['server_offline']
    )
    const deleted = await send(ctx, 'DELETE', `/environments/${envId}`)
    assertEquals(deleted.status, 409)
    assertEquals(deleted.json.error, 'server_offline')
  })
})

test('missing folders and the common scope do not block a rename; a finished confirmation lifts it', async () => {
  await withFixtures(async (ctx) => {
    const { envId } = await createProject(ctx, 'Rename Lifts')
    await addServiceFolder(ctx, envId, 'gone.example.com', 'missing')
    const [svc] = await ctx.db
      .insert(service)
      .values({ environmentId: envId, composeServiceName: 'shared', slug: 'shared' })
      .returning({ id: service.id })
    await ctx.db.insert(folder).values({
      serverId: ctx.serverId,
      principalId: ctx.principalId,
      environmentId: null,
      scope: 'common',
      kind: 'service',
      slug: 'shared',
      serviceId: svc!.id,
      state: 'present',
    })
    const ok = await send(ctx, 'PATCH', `/environments/${envId}`, { name: 'staging' })
    assertEquals(ok.status, 200)

    await ctx.db
      .update(folder)
      .set({ state: 'removing' })
      .where(and(eq(folder.serverId, ctx.serverId), eq(folder.slug, 'gone.example.com')))
    const blocked = await send(ctx, 'PATCH', `/environments/${envId}`, { name: 'staging-2' })
    assertEquals(blocked.status, 409)

    await ctx.db.delete(folder).where(eq(folder.slug, 'gone.example.com'))
    const lifted = await send(ctx, 'PATCH', `/environments/${envId}`, { name: 'staging-2' })
    assertEquals(lifted.status, 200)
  })
})

test('a running deploy holds the environment name', async () => {
  await withFixtures(async (ctx) => {
    const { envId } = await createProject(ctx, 'Rename Running')
    const [row] = await ctx.db
      .insert(command)
      .values({
        serverId: ctx.serverId,
        actorType: 'system',
        actorId: crypto.randomUUID(),
        name: 'environment.deploy',
        status: 'running',
        environmentId: envId,
        context: { environmentId: envId },
      })
      .returning({ id: command.id })
    const blocked = await send(ctx, 'PATCH', `/environments/${envId}`, { name: 'next' })
    assertEquals(blocked.status, 409)
    assertEquals(blocked.json.error, 'environment_deploy_running')

    await ctx.db.update(command).set({ status: 'succeeded' }).where(eq(command.id, row!.id))
    const ok = await send(ctx, 'PATCH', `/environments/${envId}`, { name: 'next' })
    assertEquals(ok.status, 200)
  })
})

test('the folder naming setting defaults to slug, changes freely, then locks with the first folder', async () => {
  await withFixtures(async (ctx) => {
    const path = `/organizations/${ctx.organizationId}/directory-defaults`
    const initial = await send(ctx, 'GET', path)
    assertEquals(initial.json, {
      names: null,
      effectiveNames: 'slug',
      locked: false,
      lockedByFolders: false,
    })

    assertEquals((await send(ctx, 'PUT', path, { names: 'nope' })).status, 400)
    assertEquals((await send(ctx, 'PUT', path, {})).status, 400)
    const both = await send(ctx, 'PUT', path, { names: 'both' })
    assertEquals(both.status, 200)
    assertEquals(both.json.effectiveNames, 'both')
    const uuid = await send(ctx, 'PUT', path, { names: 'uuid' })
    assertEquals(uuid.json.effectiveNames, 'uuid')
    const reset = await send(ctx, 'PUT', path, { names: null })
    assertEquals(reset.json.effectiveNames, 'slug')

    // A hand lock freezes the value until it is cleared.
    assertEquals((await send(ctx, 'PUT', path, { locked: true })).status, 200)
    const frozen = await send(ctx, 'PUT', path, { names: 'uuid' })
    assertEquals(frozen.status, 409)
    assertEquals(frozen.json.error, 'directory_names_locked')
    const unfrozen = await send(ctx, 'PUT', path, { locked: false, names: 'uuid' })
    assertEquals(unfrozen.status, 200)
    assertEquals(unfrozen.json.effectiveNames, 'uuid')

    const { envId } = await createProject(ctx, 'Setting Lock')
    await addServiceFolder(ctx, envId, 'example.com')
    const read = await send(ctx, 'GET', path)
    assertEquals(read.json.locked, true)
    assertEquals(read.json.lockedByFolders, true)
    const refused = await send(ctx, 'PUT', path, { names: 'slug' })
    assertEquals(refused.status, 409)
    assertEquals(refused.json.error, 'directory_names_locked')
    assertEquals((await send(ctx, 'PUT', path, { locked: false })).status, 409)
    // Writing the value already in force is accepted and changes nothing.
    assertEquals((await send(ctx, 'PUT', path, { names: 'uuid' })).status, 200)
  })
})

test('a project with folders is refused while their server is offline, and deleted in one step once it is back', async () => {
  const { queue, sent } = recordingQueue()
  await withFixtures(
    async (ctx) => {
      const { projectId, envId } = await createProject(ctx, 'Delete Unlocked')
      await addServiceFolder(ctx, envId, 'example.com', 'present')
      // A first deploy that failed leaves its folder `planned`.
      await addServiceFolder(ctx, envId, 'failed.example.com', 'planned')
      const [svc] = await ctx.db
        .select({ id: service.id })
        .from(service)
        .where(and(eq(service.environmentId, envId), eq(service.slug, 'example.com')))
      // A hosting the compose file declared goes with its service.
      await ctx.db.insert(hosting).values({
        serviceId: svc!.id,
        name: 'web',
        options: { hostnames: ['example.com'] },
        metadata: { composeOwned: true, composeServiceName: 'example.com' },
      })

      const refused = await send(ctx, 'DELETE', `/projects/${projectId}`)
      assertEquals(refused.status, 409)
      assertEquals(refused.json.error, 'server_offline')
      assertMatch(String(refused.json.message), /Alpha is offline/)
      assertEquals(sent.length, 0)
      const stillThere = await ctx.db.select().from(project).where(eq(project.id, projectId))
      assertEquals(stillThere.length, 1)

      await ctx.db.update(server).set({ isConnected: true }).where(eq(server.id, ctx.serverId))
      const preview = await send(ctx, 'GET', `/projects/${projectId}/delete-preview`)
      assertEquals(preview.json.blockers, [])
      assertEquals(
        (preview.json.folders as Array<{ path: string }>).map((row) => row.path).sort(),
        [
          `/srv/users/${await ownerLogin(ctx)}/production/services/example.com`,
          `/srv/users/${await ownerLogin(ctx)}/production/services/failed.example.com`,
        ]
      )

      const deleted = await send(ctx, 'DELETE', `/projects/${projectId}`)
      assertEquals(deleted.status, 200)
      assertEquals((deleted.json.cleanup as { folderServerIds: string[] }).folderServerIds, [
        ctx.serverId,
      ])
      const gone = await ctx.db.select().from(project).where(eq(project.id, projectId))
      assertEquals(gone.length, 0)
      const hostings = await ctx.db.select().from(hosting).where(eq(hosting.serviceId, svc!.id))
      assertEquals(hostings.length, 0)
      // Both folders wait for the server, no longer tied to the deleted environment.
      const rows = await ctx.db
        .select({ state: folder.state, environmentId: folder.environmentId })
        .from(folder)
        .where(eq(folder.serverId, ctx.serverId))
      assertEquals(rows, [
        { state: 'removing', environmentId: null },
        { state: 'removing', environmentId: null },
      ])
      // The server was asked to remove them right away.
      const asked = await ctx.db
        .select({ name: command.name })
        .from(command)
        .where(eq(command.serverId, ctx.serverId))
      assertEquals(
        asked.map((row) => row.name),
        ['server.folders.remove']
      )
    },
    { commandQueue: queue }
  )
})

test('a project with a deploy in flight is refused in the plan and again under the lock', async () => {
  await withFixtures(async (ctx) => {
    const { projectId, envId } = await createProject(ctx, 'Deploy Running')
    await ctx.db
      .insert(deployment)
      .values({ environmentId: envId, serverId: ctx.serverId, status: 'applying' })
    await ctx.db.update(server).set({ isConnected: true }).where(eq(server.id, ctx.serverId))

    const refused = await send(ctx, 'DELETE', `/projects/${projectId}`)
    assertEquals(refused.status, 409)
    assertEquals(refused.json.error, 'project_deploy_running')
    assertMatch(String(refused.json.message), /deploy is running/)
    // The cascade itself checks again (a deploy queued after the plan was read).
    const locked = await deleteProjectCascade(ctx.db, projectId)
    assertEquals(locked.ok ? null : locked.error, 'project_deploy_running')

    await ctx.db.delete(deployment).where(eq(deployment.environmentId, envId))
    assertEquals((await send(ctx, 'DELETE', `/projects/${projectId}`)).status, 200)
  })
})

test('a project delete keeps a volume set to keep its data, with its folder and its Hosting Account', async () => {
  await withFixtures(async (ctx) => {
    const { projectId, envId } = await createProject(ctx, 'Keep Volume')
    await ctx.db.update(server).set({ isConnected: true }).where(eq(server.id, ctx.serverId))
    const [account] = await ctx.db
      .insert(principal)
      .values({
        organizationId: ctx.organizationId,
        username: 'keepvol',
        appliedUsername: 'keepvol',
        projectId,
      })
      .returning({ id: principal.id })
    const [vol] = await ctx.db
      .insert(storage)
      .values({
        organizationId: ctx.organizationId,
        kind: 'volume',
        name: 'data',
        slug: 'data',
        retention: 'retain',
        environmentId: envId,
        principalId: account!.id,
      })
      .returning({ id: storage.id })
    await ctx.db.insert(folder).values({
      serverId: ctx.serverId,
      principalId: account!.id,
      environmentId: envId,
      scope: 'production',
      kind: 'volume',
      slug: 'data',
      storageId: vol!.id,
      state: 'present',
    })

    const preview = await send(ctx, 'GET', `/projects/${projectId}/delete-preview`)
    assertEquals(
      (preview.json.folders as Array<{ action: string }>).map((row) => row.action),
      ['keep']
    )
    assertEquals(
      (preview.json.hostingAccounts as Array<{ username: string; action: string }>).map((row) => [
        row.username,
        row.action,
      ]),
      [['keepvol', 'keep']]
    )

    const deleted = await send(ctx, 'DELETE', `/projects/${projectId}`)
    assertEquals(deleted.status, 200)
    const cleanup = deleted.json.cleanup as {
      hostingAccounts: { removing: unknown[]; kept: Array<{ username: string }> }
    }
    assertEquals(cleanup.hostingAccounts.removing, [])
    assertEquals(
      cleanup.hostingAccounts.kept.map((row) => row.username),
      ['keepvol']
    )
    const [kept] = await ctx.db
      .select({ state: folder.state, environmentId: folder.environmentId })
      .from(folder)
      .where(eq(folder.storageId, vol!.id))
    assertEquals(kept, { state: 'orphan', environmentId: null })
    const [owner] = await ctx.db
      .select({ removalRequestedAt: principal.removalRequestedAt })
      .from(principal)
      .where(eq(principal.id, account!.id))
    assertEquals(owner?.removalRequestedAt, null)

    // Marking it present does nothing while it has no environment, and using the
    // volume again in an environment of the same name gives the row that environment.
    const [orphanRow] = await ctx.db
      .select({ id: folder.id })
      .from(folder)
      .where(eq(folder.storageId, vol!.id))
    await markFoldersPresent(ctx.db, [orphanRow!.id])
    const again = await createProject(ctx, 'Keep Volume Again')
    await ctx.db.update(storage).set({ environmentId: again.envId }).where(eq(storage.id, vol!.id))
    await ctx.db.transaction((tx) =>
      planVolumeFolder(tx, { storageId: vol!.id, serverId: ctx.serverId })
    )
    const [reused] = await ctx.db
      .select({ state: folder.state, environmentId: folder.environmentId })
      .from(folder)
      .where(eq(folder.storageId, vol!.id))
    assertEquals(reused, { state: 'planned', environmentId: again.envId })
    // Left for the person to delete on their own.
    await ctx.db.delete(folder).where(eq(folder.storageId, vol!.id))
    await ctx.db.delete(storage).where(eq(storage.id, vol!.id))
    await ctx.db.delete(principal).where(eq(principal.id, account!.id))
  })
})

test('an environment with folders is deleted in one step; its folders wait for the server', async () => {
  await withFixtures(async (ctx) => {
    const { projectId } = await createProject(ctx, 'Env Delete')
    await ctx.db.update(server).set({ isConnected: true }).where(eq(server.id, ctx.serverId))
    const [staging] = await ctx.db
      .insert(environment)
      .values({ name: 'staging', projectId })
      .returning({ id: environment.id })
    await addServiceFolder(ctx, staging!.id, 'stage.example.com', 'present', 'staging')
    const deleted = await send(ctx, 'DELETE', `/environments/${staging!.id}`)
    assertEquals(deleted.status, 200)
    const rows = await ctx.db
      .select({ state: folder.state, environmentId: folder.environmentId })
      .from(folder)
      .where(eq(folder.serverId, ctx.serverId))
    assertEquals(rows, [{ state: 'removing', environmentId: null }])
    const gone = await ctx.db.select().from(environment).where(eq(environment.id, staging!.id))
    assertEquals(gone.length, 0)
  })
})

test('deleting a service whose folder is recorded keeps the folder row and its lock', async () => {
  await withFixtures(async (ctx) => {
    const { envId } = await createProject(ctx, 'Asset Delete')
    await addServiceFolder(ctx, envId, 'example.com', 'present')
    const [row] = await ctx.db
      .select({ id: folder.id, serviceId: folder.serviceId })
      .from(folder)
      .where(eq(folder.serverId, ctx.serverId))
    await ctx.db.delete(service).where(eq(service.id, row!.serviceId!))
    const [after] = await ctx.db
      .select({ id: folder.id, serviceId: folder.serviceId, state: folder.state })
      .from(folder)
      .where(eq(folder.id, row!.id))
    assertEquals(after?.serviceId, null)
    assertEquals(after?.state, 'present')
    const blocked = await send(ctx, 'PATCH', `/environments/${envId}`, { name: 'staging' })
    assertEquals(blocked.status, 409)
  })
})

test('a site owner with folders is counted as in use', async () => {
  await withFixtures(async (ctx) => {
    const { envId } = await createProject(ctx, 'Owner In Use')
    await addServiceFolder(ctx, envId, 'example.com', 'present')
    assertEquals((await countPrincipalReferences(ctx.db, ctx.principalId)).folders, 1)
    const usage = await loadPrincipalUsage(ctx.db, [ctx.principalId], ctx.serverId)
    assertEquals(usage.get(ctx.principalId)?.folders, 0)
    const all = await loadPrincipalUsage(ctx.db, [ctx.principalId])
    assertEquals(all.get(ctx.principalId)?.folders, 1)
  })
})
