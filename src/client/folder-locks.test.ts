/**
 * The naming locks that the folder table drives: environment rename and delete,
 * the project slug, and the organization folder-name setting. Needs a database.
 */
import { assertEquals, assertMatch } from '@std/assert'
import { and, eq } from 'drizzle-orm'
import { command, environment, folder, project, service } from '../db/schema.ts'
import { countPrincipalReferences } from '../features/principals/store.ts'
import { loadPrincipalUsage } from '../features/principals/placement-records.ts'
import {
  type Ctx,
  createProject,
  send,
  withFolderFixtures as withFixtures,
} from '../test-fixtures/folder-world.test.support.ts'

const test = Deno.test.bind(Deno)

async function addServiceFolder(
  ctx: Ctx,
  envId: string,
  slug: string,
  state: 'planned' | 'present' | 'removing' | 'missing' = 'planned'
): Promise<void> {
  const [svc] = await ctx.db
    .insert(service)
    .values({ environmentId: envId, composeServiceName: slug, name: slug, slug })
    .returning({ id: service.id })
  await ctx.db.insert(folder).values({
    serverId: ctx.serverId,
    principalId: ctx.principalId,
    environmentId: envId,
    scope: 'production',
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

    const deleted = await send(ctx, 'DELETE', `/environments/${envId}`)
    assertEquals(deleted.status, 409)
    assertEquals(deleted.json.error, 'environment_has_folders')
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

test('a project with a folder under it cannot be deleted', async () => {
  await withFixtures(async (ctx) => {
    const { projectId, envId } = await createProject(ctx, 'Delete Locked')
    await addServiceFolder(ctx, envId, 'example.com', 'present')
    const refused = await send(ctx, 'DELETE', `/projects/${projectId}`)
    assertEquals(refused.status, 409)
    assertEquals(refused.json.error, 'project_has_folders')
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
