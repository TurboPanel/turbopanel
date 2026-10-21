/**
 * The `watch` rows that say which environments and projects follow which
 * repository. Needs a database.
 */
import { assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { environment, project, repository, watch } from '../../db/schema.ts'
import {
  createProject,
  withFolderFixtures as withFixtures,
} from '../../test-fixtures/folder-world.test.support.ts'
import {
  listWatchingEnvironmentIds,
  repositoryIsWatched,
  syncEnvironmentWatch,
  syncProjectWatch,
} from './watch-records.ts'

const test = Deno.test.bind(Deno)

function composeNaming(repositoryId: string) {
  return {
    compose: {
      version: 1,
      data: {
        services: { web: { 'x-turbopanel': { source: { sourceId: repositoryId } } } },
      },
    },
  }
}

test('watch rows follow the compose that names a repository', async () => {
  await withFixtures(async (ctx) => {
    const { projectId, envId } = await createProject(ctx, 'Watched')
    const [repo] = await ctx.db
      .insert(repository)
      .values({
        organizationId: ctx.organizationId,
        provider: 'github',
        repositoryUrl: `https://github.com/example/${crypto.randomUUID()}`,
      })
      .returning({ id: repository.id })
    const repositoryId = repo!.id

    assertEquals(await repositoryIsWatched(ctx.db, repositoryId), false)

    // An environment compose reaches that environment only.
    await ctx.db
      .update(environment)
      .set({ options: composeNaming(repositoryId) })
      .where(eq(environment.id, envId))
    await syncEnvironmentWatch(ctx.db, envId)
    assertEquals(await listWatchingEnvironmentIds(ctx.db, ctx.organizationId, repositoryId), [
      envId,
    ])
    assertEquals(await repositoryIsWatched(ctx.db, repositoryId), true)

    // A project compose reaches every environment of the project.
    await ctx.db
      .update(project)
      .set({ options: composeNaming(repositoryId) })
      .where(eq(project.id, projectId))
    await syncProjectWatch(ctx.db, projectId)
    const [other] = await ctx.db
      .insert(environment)
      .values({ projectId, name: 'staging' })
      .returning({ id: environment.id })
    assertEquals(
      (await listWatchingEnvironmentIds(ctx.db, ctx.organizationId, repositoryId)).toSorted(),
      [envId, other!.id].toSorted()
    )

    // Syncing again changes nothing, and clearing the compose drops the rows.
    await syncEnvironmentWatch(ctx.db, envId)
    assertEquals((await ctx.db.select().from(watch)).length, 2)
    await ctx.db.update(environment).set({ options: null }).where(eq(environment.id, envId))
    await syncEnvironmentWatch(ctx.db, envId)
    await ctx.db.update(project).set({ options: null }).where(eq(project.id, projectId))
    await syncProjectWatch(ctx.db, projectId)
    assertEquals(await repositoryIsWatched(ctx.db, repositoryId), false)
    assertEquals(await listWatchingEnvironmentIds(ctx.db, ctx.organizationId, repositoryId), [])
  })
})

test('overlapping syncs leave exactly the wanted rows and never refuse each other', async () => {
  await withFixtures(async (ctx) => {
    const { projectId, envId } = await createProject(ctx, 'Raced')
    const repos = await ctx.db
      .insert(repository)
      .values(
        [0, 1].map((n) => ({
          organizationId: ctx.organizationId,
          provider: 'github' as const,
          repositoryUrl: `https://github.com/example/${n}-${crypto.randomUUID()}`,
        }))
      )
      .returning({ id: repository.id })
    const [first, second] = repos.map((row) => row.id)
    await ctx.db
      .update(environment)
      .set({ options: composeNaming(first!) })
      .where(eq(environment.id, envId))
    await syncEnvironmentWatch(ctx.db, envId)

    // The compose now names the other repository; four syncs run at once.
    await ctx.db
      .update(environment)
      .set({ options: composeNaming(second!) })
      .where(eq(environment.id, envId))
    await Promise.all([1, 2, 3, 4].map(() => syncEnvironmentWatch(ctx.db, envId)))
    const rows = await ctx.db
      .select({ repositoryId: watch.repositoryId })
      .from(watch)
      .where(eq(watch.environmentId, envId))
    assertEquals(
      rows.map((row) => row.repositoryId),
      [second]
    )

    await Promise.all([1, 2, 3].map(() => syncProjectWatch(ctx.db, projectId)))
    assertEquals(await repositoryIsWatched(ctx.db, first!), false)
  })
})
