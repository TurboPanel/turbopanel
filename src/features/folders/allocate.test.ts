/**
 * Choosing folder names and planning folder rows for services and volumes,
 * and moving the rows along their states. Needs a database.
 */
import { assertEquals, assertRejects } from '@std/assert'
import { eq } from 'drizzle-orm'
import { folder, organization, principal, service, storage, tenancy } from '../../db/schema.ts'
import {
  type Ctx,
  createProject,
  withFolderFixtures as withFixtures,
} from '../../test-fixtures/folder-world.test.support.ts'
import {
  confirmFolderRemoved,
  FolderPlanError,
  markAssetFoldersRemoving,
  markFoldersPresent,
  markServerServiceFoldersRemoving,
  markVolumeFolderRemoving,
  planDeployFolders,
  planVolumeFolder,
  settleFolderName,
} from './allocate.ts'
import { listEnvironmentFolders } from './records.ts'

const test = Deno.test.bind(Deno)

async function addService(
  ctx: Ctx,
  environmentId: string,
  composeServiceName: string,
  fields: { slug?: string; isCommon?: boolean; owned?: boolean } = {}
): Promise<string> {
  const [row] = await ctx.db
    .insert(service)
    .values({
      environmentId,
      composeServiceName,
      name: composeServiceName,
      ...(fields.slug === undefined ? {} : { slug: fields.slug }),
      isCommon: fields.isCommon ?? false,
    })
    .returning({ id: service.id })
  if (fields.owned !== false) {
    await ctx.db.insert(tenancy).values({ principalId: ctx.principalId, serviceId: row!.id })
  }
  return row!.id
}

async function addVolume(
  ctx: Ctx,
  fields: { name: string; environmentId?: string; slug?: string; isCommon?: boolean }
): Promise<string> {
  const [row] = await ctx.db
    .insert(storage)
    .values({
      organizationId: ctx.organizationId,
      environmentId: fields.environmentId ?? null,
      kind: 'volume',
      name: fields.name,
      principalId: ctx.principalId,
      ...(fields.slug === undefined ? {} : { slug: fields.slug }),
      isCommon: fields.isCommon ?? false,
    })
    .returning({ id: storage.id })
  return row!.id
}

async function organizationOptions(ctx: Ctx): Promise<Record<string, unknown>> {
  const [row] = await ctx.db
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, ctx.organizationId))
  return (row?.options ?? {}) as Record<string, unknown>
}

async function plan(
  ctx: Ctx,
  environmentId: string,
  input: Partial<Parameters<typeof planDeployFolders>[1]> = {}
) {
  return await ctx.db.transaction((tx) =>
    planDeployFolders(tx, {
      organizationId: ctx.organizationId,
      environmentId,
      serverId: ctx.serverId,
      services: [],
      volumeIds: [],
      ...input,
    })
  )
}

test('a deploy plans the folder of a service after its name, in the environment scope, and locks the setting', async () => {
  await withFixtures(async (ctx) => {
    const { envId } = await createProject(ctx, 'Plan One')
    const web = await addService(ctx, envId, 'web')
    assertEquals((await organizationOptions(ctx)).directoryNamesLocked, undefined)

    const planned = await plan(ctx, envId, { services: [{ serviceId: web }] })
    const [owner] = await ctx.db
      .select({ username: principal.appliedUsername })
      .from(principal)
      .where(eq(principal.id, ctx.principalId))
    assertEquals(planned.services.get(web), {
      owner: owner!.username,
      scope: 'production',
      slug: 'web',
    })
    const rows = await ctx.db.select().from(folder).where(eq(folder.serverId, ctx.serverId))
    assertEquals(rows.length, 1)
    assertEquals(rows[0]!.state, 'planned')
    assertEquals(rows[0]!.kind, 'service')
    assertEquals(rows[0]!.environmentId, envId)
    assertEquals(planned.folderIds, [rows[0]!.id])
    const [svc] = await ctx.db
      .select({ slug: service.slug })
      .from(service)
      .where(eq(service.id, web))
    assertEquals(svc!.slug, 'web')
    assertEquals((await organizationOptions(ctx)).directoryNamesLocked, true)

    // Planning again finds the same row.
    const again = await plan(ctx, envId, { services: [{ serviceId: web }] })
    assertEquals(again.folderIds, planned.folderIds)
  })
})

test('a web hosting service takes its domain as the folder name, and a clash gets a suffix', async () => {
  await withFixtures(async (ctx) => {
    const first = await createProject(ctx, 'Domain One')
    const second = await createProject(ctx, 'Domain Two')
    const a = await addService(ctx, first.envId, 'site')
    const b = await addService(ctx, second.envId, 'site')

    const one = await plan(ctx, first.envId, {
      services: [{ serviceId: a, domain: 'Example.COM' }],
    })
    assertEquals(one.services.get(a)!.slug, 'example.com')
    // Another project's environment of the same name shares the owner's scope folder.
    const two = await plan(ctx, second.envId, {
      services: [{ serviceId: b, domain: 'example.com' }],
    })
    assertEquals(two.services.get(b)!.slug, 'example.com-2')
  })
})

test('a service can be found by its compose key, and one with no site owner gets no folder', async () => {
  await withFixtures(async (ctx) => {
    const { envId } = await createProject(ctx, 'By Key')
    const owned = await addService(ctx, envId, 'api')
    await addService(ctx, envId, 'worker', { owned: false })
    const planned = await plan(ctx, envId, {
      services: [{ composeServiceName: 'api' }, { composeServiceName: 'worker' }],
    })
    assertEquals([...planned.services.keys()], [owned])
  })
})

test('uuid mode names the folder after the service id', async () => {
  await withFixtures(async (ctx) => {
    await ctx.db
      .update(organization)
      .set({ options: { directoryNames: 'uuid' } })
      .where(eq(organization.id, ctx.organizationId))
    const { envId } = await createProject(ctx, 'Uuid Mode')
    const web = await addService(ctx, envId, 'web')
    const planned = await plan(ctx, envId, { services: [{ serviceId: web }] })
    assertEquals(planned.services.get(web)!.slug, web)
  })
})

test('a service in the common scope gets a folder with no environment that does not lock a rename', async () => {
  await withFixtures(async (ctx) => {
    const { envId } = await createProject(ctx, 'Common Plan')
    const shared = await addService(ctx, envId, 'shared', { isCommon: true })
    const planned = await plan(ctx, envId, { services: [{ serviceId: shared }] })
    assertEquals(planned.services.get(shared)!.scope, 'common')
    const [row] = await ctx.db.select().from(folder).where(eq(folder.serviceId, shared))
    assertEquals(row!.environmentId, null)
    assertEquals((await listEnvironmentFolders(ctx.db, envId)).total, 0)
  })
})

test('a volume with an owner is planned in the environment scope, or in common', async () => {
  await withFixtures(async (ctx) => {
    const { envId } = await createProject(ctx, 'Volumes')
    const uploads = await addVolume(ctx, { name: 'Uploads', environmentId: envId })
    const cache = await addVolume(ctx, { name: 'Cache', isCommon: true })
    const planned = await plan(ctx, envId, { volumeIds: [uploads, cache] })
    assertEquals(planned.volumes.get(uploads)!.scope, 'production')
    assertEquals(planned.volumes.get(uploads)!.slug, 'uploads')
    assertEquals(planned.volumes.get(cache)!.scope, 'common')
    const rows = await ctx.db.select().from(folder).where(eq(folder.serverId, ctx.serverId))
    assertEquals(
      rows.map((row) => row.kind),
      ['volume', 'volume']
    )
  })
})

test('a service and a volume of one owner may share a name, two services may not', async () => {
  await withFixtures(async (ctx) => {
    const { envId } = await createProject(ctx, 'Same Name')
    const web = await addService(ctx, envId, 'web', { slug: 'data' })
    const volume = await addVolume(ctx, { name: 'data', environmentId: envId, slug: 'data' })
    const planned = await plan(ctx, envId, { services: [{ serviceId: web }], volumeIds: [volume] })
    assertEquals(planned.folderIds.length, 2)

    const other = await addService(ctx, envId, 'other', { slug: 'data' }).catch((error) => error)
    // The unique index on (environment, slug) already refuses the second service.
    assertEquals(other instanceof Error, true)
  })
})

test('settling a name: typed names are never suffixed, the setting decides the kind', async () => {
  await withFixtures(async (ctx) => {
    const { envId } = await createProject(ctx, 'Settle')
    const taken = await addService(ctx, envId, 'taken')
    await plan(ctx, envId, { services: [{ serviceId: taken }] })
    const newcomer = '0199b3c0-1d2e-7a4b-8c5d-123456789abc'
    const settle = (
      mode: 'slug' | 'uuid' | 'both',
      request: Parameters<typeof settleFolderName>[1]['request']
    ) =>
      settleFolderName(ctx.db, {
        mode,
        kind: 'service',
        assetId: newcomer,
        principalId: ctx.principalId,
        scope: 'production',
        request,
        label: 'Newcomer',
      })

    assertEquals((await settle('slug', {})).slug, 'newcomer')
    assertEquals((await settle('slug', { typed: 'mine' })).slug, 'mine')
    assertEquals(
      (await assertRejects(() => settle('slug', { typed: 'taken' }), FolderPlanError)).code,
      'directory_name_taken'
    )
    assertEquals(
      (await assertRejects(() => settle('slug', { typed: 'Bad Name' }), FolderPlanError)).code,
      'invalid_directory_name'
    )
    assertEquals(
      (await assertRejects(() => settle('uuid', { typed: 'mine' }), FolderPlanError)).code,
      'directory_name_typed_in_uuid_mode'
    )
    assertEquals(
      (await assertRejects(() => settle('slug', { choice: 'uuid' }), FolderPlanError)).code,
      'directory_name_mode_forbidden'
    )
    assertEquals((await settle('both', { choice: 'uuid' })).slug, newcomer)
    // A default that clashes takes the next free suffix.
    const clash = await settleFolderName(ctx.db, {
      mode: 'slug',
      kind: 'service',
      assetId: newcomer,
      principalId: ctx.principalId,
      scope: 'production',
      request: {},
      label: 'taken',
    })
    assertEquals(clash.slug, 'taken-2')
  })
})

test('a volume gets its folder row when its path copy is added', async () => {
  await withFixtures(async (ctx) => {
    const { envId } = await createProject(ctx, 'Copy Plan')
    const named = await addVolume(ctx, { name: 'Named', environmentId: envId, slug: 'named' })
    const unnamed = await addVolume(ctx, { name: 'Unnamed', environmentId: envId })
    assertEquals(
      await ctx.db.transaction((tx) =>
        planVolumeFolder(tx, { storageId: unnamed, serverId: ctx.serverId })
      ),
      null
    )
    const id = await ctx.db.transaction((tx) =>
      planVolumeFolder(tx, { storageId: named, serverId: ctx.serverId })
    )
    const [row] = await ctx.db.select().from(folder).where(eq(folder.id, id!))
    assertEquals(
      { scope: row!.scope, slug: row!.slug, state: row!.state, kind: row!.kind },
      { scope: 'production', slug: 'named', state: 'planned', kind: 'volume' }
    )
  })
})

test('rows move planned, present, removing and are deleted only once the host confirms', async () => {
  await withFixtures(async (ctx) => {
    const { envId } = await createProject(ctx, 'States')
    const web = await addService(ctx, envId, 'web')
    const volume = await addVolume(ctx, { name: 'data', environmentId: envId })
    const planned = await plan(ctx, envId, { services: [{ serviceId: web }], volumeIds: [volume] })
    const states = async () =>
      (await ctx.db.select().from(folder).where(eq(folder.serverId, ctx.serverId)))
        .map((row) => `${row.kind}:${row.state}`)
        .sort()

    assertEquals(await states(), ['service:planned', 'volume:planned'])
    await markFoldersPresent(ctx.db, planned.folderIds)
    assertEquals(await states(), ['service:present', 'volume:present'])

    // Leaving a server reclaims its service folders only; data is never part of it.
    await markServerServiceFoldersRemoving(ctx.db, { environmentId: envId, serverId: ctx.serverId })
    assertEquals(await states(), ['service:removing', 'volume:present'])
    await markVolumeFolderRemoving(ctx.db, { storageId: volume, serverId: ctx.serverId })
    assertEquals(await states(), ['service:removing', 'volume:removing'])

    const where = (kind: 'service' | 'volume', slug: string) => ({
      serverId: ctx.serverId,
      principalId: ctx.principalId,
      scope: 'production',
      kind,
      slug,
    })
    // A stale report about a folder that is in use changes nothing.
    await markFoldersPresent(ctx.db, planned.folderIds)
    assertEquals(await confirmFolderRemoved(ctx.db, where('service', 'nothing')), false)
    assertEquals(await confirmFolderRemoved(ctx.db, where('service', 'web')), true)
    assertEquals(await states(), ['volume:removing'])

    // Deleting an asset keeps its rows (the asset id clears) and the environment stays locked.
    await markAssetFoldersRemoving(ctx.db, { storageIds: [volume] })
    await ctx.db.delete(storage).where(eq(storage.id, volume))
    const [left] = await ctx.db.select().from(folder).where(eq(folder.serverId, ctx.serverId))
    assertEquals(
      { state: left!.state, storageId: left!.storageId },
      { state: 'removing', storageId: null }
    )
    assertEquals((await listEnvironmentFolders(ctx.db, envId)).total, 1)
    assertEquals(await confirmFolderRemoved(ctx.db, where('volume', 'data')), true)
    assertEquals((await listEnvironmentFolders(ctx.db, envId)).total, 0)
  })
})

test('planning a folder again while the host has not confirmed its removal makes it planned again', async () => {
  await withFixtures(async (ctx) => {
    const { envId } = await createProject(ctx, 'Replan')
    const web = await addService(ctx, envId, 'web')
    const first = await plan(ctx, envId, { services: [{ serviceId: web }] })
    await markFoldersPresent(ctx.db, first.folderIds)
    await markServerServiceFoldersRemoving(ctx.db, { environmentId: envId, serverId: ctx.serverId })
    const again = await plan(ctx, envId, { services: [{ serviceId: web }] })
    assertEquals(again.folderIds, first.folderIds)
    const [row] = await ctx.db.select().from(folder).where(eq(folder.id, first.folderIds[0]!))
    assertEquals(row!.state, 'planned')
  })
})
