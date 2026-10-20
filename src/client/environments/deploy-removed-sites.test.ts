/**
 * Which of the services that left the compose file a server is asked to remove
 * the site of. Needs a database.
 */
import { assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { folder, service } from '../../db/schema.ts'
import {
  type Ctx,
  createProject,
  withFolderFixtures as withFixtures,
} from '../../test-fixtures/folder-world.test.support.ts'
import { removedSitesOnServer } from './deploy-folders.ts'

const test = Deno.test.bind(Deno)

async function addServiceWithFolder(
  ctx: Ctx,
  envId: string,
  name: string,
  state: string | null
): Promise<{ id: string; composeServiceName: string }> {
  const [row] = await ctx.db
    .insert(service)
    .values({ environmentId: envId, composeServiceName: name, name, slug: name })
    .returning({ id: service.id })
  if (state !== null) {
    await ctx.db.insert(folder).values({
      serverId: ctx.serverId,
      principalId: ctx.principalId,
      environmentId: envId,
      scope: 'production',
      kind: 'service',
      slug: name,
      serviceId: row!.id,
      state,
    })
  }
  return { id: row!.id, composeServiceName: name }
}

test('a removed site is named while its folder is live here, and not once the deploy marked it an orphan', async () => {
  await withFixtures(async (ctx) => {
    const { envId } = await createProject(ctx, 'Removed Sites')
    const present = await addServiceWithFolder(ctx, envId, 'present-site', 'present')
    const planned = await addServiceWithFolder(ctx, envId, 'planned-site', 'planned')
    const orphan = await addServiceWithFolder(ctx, envId, 'orphan-site', 'orphan')
    const removing = await addServiceWithFolder(ctx, envId, 'removing-site', 'removing')
    const container = await addServiceWithFolder(ctx, envId, 'a-container', null)
    const removed = [present, planned, orphan, removing, container]

    const names = () =>
      removedSitesOnServer(ctx.db, { environmentId: envId, serverId: ctx.serverId, removed })
    assertEquals(await names(), ['planned-site', 'present-site'])

    // The deploy that succeeded with the site gone marks its folder an orphan: not named again.
    await ctx.db.update(folder).set({ state: 'orphan' }).where(eq(folder.serviceId, present.id))
    await ctx.db.update(folder).set({ state: 'orphan' }).where(eq(folder.serviceId, planned.id))
    assertEquals(await names(), [])
  })
})

test('another server, another environment and nothing to ask about name no site', async () => {
  await withFixtures(async (ctx) => {
    const { envId } = await createProject(ctx, 'Removed Here')
    const other = await createProject(ctx, 'Removed There')
    const site = await addServiceWithFolder(ctx, envId, 'site', 'present')
    const base = { removed: [site] }
    assertEquals(
      await removedSitesOnServer(ctx.db, { ...base, environmentId: envId, serverId: ctx.serverId }),
      ['site']
    )
    assertEquals(
      await removedSitesOnServer(ctx.db, {
        ...base,
        environmentId: other.envId,
        serverId: ctx.serverId,
      }),
      []
    )
    assertEquals(
      await removedSitesOnServer(ctx.db, {
        ...base,
        environmentId: envId,
        serverId: crypto.randomUUID(),
      }),
      []
    )
    assertEquals(
      await removedSitesOnServer(ctx.db, {
        environmentId: envId,
        serverId: ctx.serverId,
        removed: [],
      }),
      []
    )
  })
})
