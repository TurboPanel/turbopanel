/**
 * Common services and volumes used by environments of other projects: the
 * share routes, the refusal to delete what is in use, and what a deploy carries.
 * Needs a database.
 */
import { assertEquals, assertMatch } from '@std/assert'
import { eq } from 'drizzle-orm'
import { folder, mount, service, share, storage, storageCopy, tenancy } from '../db/schema.ts'
import {
  type Ctx,
  createProject,
  send,
  withFolderFixtures as withFixtures,
} from '../test-fixtures/folder-world.test.support.ts'
import { loadStorageMaterial } from './environments/deploy-prepare.ts'

const test = Deno.test.bind(Deno)

async function addService(
  ctx: Ctx,
  envId: string,
  name: string,
  fields: { isCommon?: boolean; owned?: boolean } = {}
): Promise<string> {
  const [row] = await ctx.db
    .insert(service)
    .values({
      environmentId: envId,
      composeServiceName: name,
      name,
      slug: name,
      isCommon: fields.isCommon ?? false,
    })
    .returning({ id: service.id })
  if (fields.owned !== false) {
    await ctx.db.insert(tenancy).values({ principalId: ctx.principalId, serviceId: row!.id })
  }
  return row!.id
}

async function addCommonVolume(ctx: Ctx, projectId: string, name: string): Promise<string> {
  const [row] = await ctx.db
    .insert(storage)
    .values({
      organizationId: ctx.organizationId,
      projectId,
      kind: 'volume',
      name,
      slug: name,
      isCommon: true,
      principalId: ctx.principalId,
    })
    .returning({ id: storage.id })
  await ctx.db
    .insert(storageCopy)
    .values({ storageId: row!.id, serverId: ctx.serverId, provider: 'path', role: 'primary' })
  return row!.id
}

test('an environment of another project starts and stops using a common service', async () => {
  await withFixtures(async (ctx) => {
    const home = await createProject(ctx, 'Share Home')
    const other = await createProject(ctx, 'Share Other')
    const shared = await addService(ctx, home.envId, 'shared', { isCommon: true })

    const added = await send(ctx, 'POST', `/environments/${other.envId}/shares`, {
      serviceId: shared,
    })
    assertEquals(added.status, 200)
    const again = await send(ctx, 'POST', `/environments/${other.envId}/shares`, {
      serviceId: shared,
    })
    assertEquals(again.json.id, added.json.id)

    const listed = await send(ctx, 'GET', `/environments/${other.envId}/shares`)
    const uses = listed.json.shares as Array<{ kind: string; assetId: string; assetName: string }>
    assertEquals(
      uses.map((use) => [use.kind, use.assetId, use.assetName]),
      [['service', shared, 'shared']]
    )

    const removed = await send(
      ctx,
      'DELETE',
      `/environments/${other.envId}/shares/${added.json.id}`
    )
    assertEquals(removed.status, 200)
    const gone = await send(ctx, 'DELETE', `/environments/${other.envId}/shares/${added.json.id}`)
    assertEquals(gone.status, 404)
    assertEquals(
      ((await send(ctx, 'GET', `/environments/${other.envId}/shares`)).json.shares as unknown[])
        .length,
      0
    )
  })
})

test('only a common asset with a site owner, from another environment, can be shared', async () => {
  await withFixtures(async (ctx) => {
    const home = await createProject(ctx, 'Rules Home')
    const other = await createProject(ctx, 'Rules Other')
    const plain = await addService(ctx, home.envId, 'plain')
    const ownerless = await addService(ctx, home.envId, 'ownerless', {
      isCommon: true,
      owned: false,
    })
    const shared = await addService(ctx, home.envId, 'shared', { isCommon: true })
    const post = (envId: string, body: Record<string, unknown>) =>
      send(ctx, 'POST', `/environments/${envId}/shares`, body)

    const notCommon = await post(other.envId, { serviceId: plain })
    assertEquals(notCommon.status, 409)
    assertEquals(notCommon.json.error, 'asset_not_common')
    const noOwner = await post(other.envId, { serviceId: ownerless })
    assertEquals(noOwner.status, 409)
    assertEquals(noOwner.json.error, 'asset_has_no_owner')
    const own = await post(home.envId, { serviceId: shared })
    assertEquals(own.status, 409)
    assertEquals(own.json.error, 'asset_in_this_environment')
    assertEquals((await post(other.envId, {})).status, 400)
    assertEquals((await post(other.envId, { serviceId: shared, storageId: shared })).status, 400)
    assertEquals((await post(other.envId, { serviceId: crypto.randomUUID() })).status, 404)
  })
})

test('a common service cannot be deleted while another environment uses it', async () => {
  await withFixtures(async (ctx) => {
    const home = await createProject(ctx, 'Delete Home')
    const other = await createProject(ctx, 'Delete Other')
    const shared = await addService(ctx, home.envId, 'shared', { isCommon: true })
    const added = await send(ctx, 'POST', `/environments/${other.envId}/shares`, {
      serviceId: shared,
    })

    const refused = await send(ctx, 'DELETE', `/services/${shared}`)
    assertEquals(refused.status, 409)
    assertEquals(refused.json.error, 'common_asset_in_use')
    const names = refused.json.uses as Array<{ environmentId: string; projectName: string }>
    assertEquals(
      names.map((use) => use.environmentId),
      [other.envId]
    )
    assertEquals(names[0]!.projectName, 'Delete Other')
    assertMatch(String(refused.json.message), /Other environments still use/)

    // The environment that owns it, and its project, cannot go either.
    const env = await send(ctx, 'DELETE', `/environments/${home.envId}`)
    assertEquals(env.status, 409)
    assertEquals(env.json.error, 'common_asset_in_use')
    const proj = await send(ctx, 'DELETE', `/projects/${home.projectId}`)
    assertEquals(proj.status, 409)
    assertEquals(proj.json.error, 'common_asset_in_use')

    await send(ctx, 'DELETE', `/environments/${other.envId}/shares/${added.json.id}`)
    // The site owner it runs as goes with it: no link is left to block the delete.
    assertEquals((await send(ctx, 'DELETE', `/services/${shared}`)).status, 200)
    assertEquals(
      (await ctx.db.select().from(tenancy).where(eq(tenancy.serviceId, shared))).length,
      0
    )
  })
})

test('deleting an environment stops its use of common assets, and the asset stays', async () => {
  await withFixtures(async (ctx) => {
    const home = await createProject(ctx, 'Detach Home')
    const other = await createProject(ctx, 'Detach Other')
    const shared = await addService(ctx, home.envId, 'shared', { isCommon: true })
    const volume = await addCommonVolume(ctx, home.projectId, 'media')
    await send(ctx, 'POST', `/environments/${other.envId}/shares`, { serviceId: shared })
    await send(ctx, 'POST', `/environments/${other.envId}/shares`, { storageId: volume })
    assertEquals(
      (await ctx.db.select().from(share)).filter((row) => row.environmentId === other.envId).length,
      2
    )

    const deleted = await send(ctx, 'DELETE', `/environments/${other.envId}`)
    assertEquals(deleted.status, 200)
    assertEquals(
      (await ctx.db.select().from(share)).filter((row) => row.environmentId === other.envId).length,
      0
    )
    assertEquals((await ctx.db.select().from(service).where(eq(service.id, shared))).length, 1)
    assertEquals((await ctx.db.select().from(storage).where(eq(storage.id, volume))).length, 1)
  })
})

test('a common volume is refused for deletion while used, and its folder row waits when deleted', async () => {
  await withFixtures(async (ctx) => {
    const home = await createProject(ctx, 'Volume Home')
    const other = await createProject(ctx, 'Volume Other')
    const volume = await addCommonVolume(ctx, home.projectId, 'media')
    await ctx.db.insert(folder).values({
      serverId: ctx.serverId,
      principalId: ctx.principalId,
      environmentId: null,
      scope: 'common',
      kind: 'volume',
      slug: 'media',
      storageId: volume,
      state: 'present',
    })
    const added = await send(ctx, 'POST', `/environments/${other.envId}/shares`, {
      storageId: volume,
    })
    const refused = await send(ctx, 'DELETE', `/storage/${volume}`)
    assertEquals(refused.status, 409)
    assertEquals(refused.json.error, 'common_asset_in_use')

    await send(ctx, 'DELETE', `/environments/${other.envId}/shares/${added.json.id}`)
    assertEquals((await send(ctx, 'DELETE', `/storage/${volume}`)).status, 200)
    const [row] = await ctx.db.select().from(folder).where(eq(folder.serverId, ctx.serverId))
    assertEquals(
      { state: row!.state, storageId: row!.storageId },
      { state: 'removing', storageId: null }
    )
  })
})

test('a deploy of an environment carries the common volumes it uses, with its own mounts only', async () => {
  await withFixtures(async (ctx) => {
    const home = await createProject(ctx, 'Material Home')
    const other = await createProject(ctx, 'Material Other')
    const volume = await addCommonVolume(ctx, home.projectId, 'media')
    const homeWeb = await addService(ctx, home.envId, 'web')
    const otherWeb = await addService(ctx, other.envId, 'web')
    await ctx.db.insert(mount).values([
      { storageId: volume, serviceId: homeWeb, destinationPath: '/media' },
      { storageId: volume, serviceId: otherWeb, destinationPath: '/data/media' },
    ])
    const load = (envId: string, projectId: string, serviceIds: string[]) =>
      loadStorageMaterial(ctx.db, {
        environmentId: envId,
        projectId,
        organizationId: ctx.organizationId,
        serverId: ctx.serverId,
        serviceIds,
        cloneNamesByServiceId: new Map(),
        registeredVolumes: [],
      })

    // The project that owns the volume carries its own mount only, even while an
    // environment of another project mounts the same volume.
    const ownerMaterial = await load(home.envId, home.projectId, [homeWeb])
    assertEquals(ownerMaterial.length, 1)
    assertEquals(
      ownerMaterial[0]!.mounts.map((entry) => [entry.composeServiceName, entry.destinationPath]),
      [['web', '/media']]
    )

    // Before the environment uses the volume, only its own project's scope sees it.
    assertEquals((await load(other.envId, other.projectId, [otherWeb])).length, 0)
    await send(ctx, 'POST', `/environments/${other.envId}/shares`, { storageId: volume })
    const material = await load(other.envId, other.projectId, [otherWeb])
    assertEquals(material.length, 1)
    assertEquals(material[0]!.storageId, volume)
    assertEquals(
      material[0]!.mounts.map((entry) => [entry.composeServiceName, entry.destinationPath]),
      [['web', '/data/media']]
    )
  })
})
