/**
 * Deleting a project, an environment or a Hosting Account leaves an audit
 * entry with who, what, names, ids and hostnames. Needs a database.
 */
import { assertEquals } from '@std/assert'
import { and, eq } from 'drizzle-orm'
import { audit, environment, hosting, hostname, service, tenancy } from '../db/schema.ts'
import {
  type Ctx,
  createProject,
  send,
  withFolderFixtures as withFixtures,
} from '../test-fixtures/folder-world.test.support.ts'

const test = Deno.test.bind(Deno)

async function addSite(ctx: Ctx, envId: string, name: string, host: string): Promise<string> {
  const [svc] = await ctx.db
    .insert(service)
    .values({ environmentId: envId, composeServiceName: name, name, slug: name })
    .returning({ id: service.id })
  const [site] = await ctx.db
    .insert(hosting)
    .values({ serviceId: svc!.id })
    .returning({ id: hosting.id })
  await ctx.db
    .insert(hostname)
    .values({ hostingId: site!.id, routingOrganizationId: ctx.organizationId, hostname: host })
  return svc!.id
}

async function entries(ctx: Ctx, action: string) {
  return await ctx.db
    .select()
    .from(audit)
    .where(and(eq(audit.organizationId, ctx.organizationId), eq(audit.action, action)))
}

async function cleanUp(ctx: Ctx) {
  await ctx.db.delete(audit).where(eq(audit.organizationId, ctx.organizationId))
}

test('deleting an environment records who, its name and its hostnames', async () => {
  await withFixtures(async (ctx) => {
    try {
      const home = await createProject(ctx, 'Audit Env Home')
      const [extra] = await ctx.db
        .insert(environment)
        .values({ projectId: home.projectId, name: 'staging' })
        .returning({ id: environment.id })
      await addSite(ctx, extra!.id, 'web', 'staging.audit-env.example.test')

      const gone = await send(ctx, 'DELETE', `/environments/${extra!.id}`)
      assertEquals(gone.status, 200)

      const rows = await entries(ctx, 'environment.delete')
      assertEquals(rows.length, 1)
      assertEquals(rows[0]!.actorUserId, ctx.userId)
      assertEquals(rows[0]!.targetType, 'environment')
      assertEquals(rows[0]!.targetId, extra!.id)
      const context = rows[0]!.context as Record<string, unknown>
      assertEquals(context.name, 'staging')
      assertEquals(context.hostnames, ['staging.audit-env.example.test'])
    } finally {
      await cleanUp(ctx)
    }
  })
})

test('deleting a project writes one entry that lists its environments and hostnames', async () => {
  await withFixtures(async (ctx) => {
    try {
      const home = await createProject(ctx, 'Audit Project Home')
      const [extra] = await ctx.db
        .insert(environment)
        .values({ projectId: home.projectId, name: 'staging' })
        .returning({ id: environment.id })
      await addSite(ctx, home.envId, 'web', 'www.audit-project.example.test')
      await addSite(ctx, extra!.id, 'web', 'staging.audit-project.example.test')

      const gone = await send(ctx, 'DELETE', `/projects/${home.projectId}`)
      assertEquals(gone.status, 200)

      const rows = await entries(ctx, 'project.delete')
      assertEquals(rows.length, 1)
      assertEquals(rows[0]!.targetType, 'project')
      assertEquals(rows[0]!.targetId, home.projectId)
      assertEquals(rows[0]!.actorUserId, ctx.userId)
      const context = rows[0]!.context as {
        name: string
        environments: Array<{ id: string }>
        environmentCount: number
        hostnames: string[]
      }
      assertEquals(context.name, 'Audit Project Home')
      assertEquals(context.environmentCount, 2)
      assertEquals(context.environments.map((row) => row.id).sort(), [home.envId, extra!.id].sort())
      assertEquals(context.hostnames, [
        'staging.audit-project.example.test',
        'www.audit-project.example.test',
      ])
      // The cascade removed the environments without writing one entry each.
      assertEquals((await entries(ctx, 'environment.delete')).length, 0)
    } finally {
      await cleanUp(ctx)
    }
  })
})

test('a refused delete writes no entry', async () => {
  await withFixtures(async (ctx) => {
    try {
      const home = await createProject(ctx, 'Audit Refused Home')
      const other = await createProject(ctx, 'Audit Refused Other')
      const [shared] = await ctx.db
        .insert(service)
        .values({
          environmentId: home.envId,
          composeServiceName: 'shared',
          name: 'shared',
          slug: 'shared',
          isCommon: true,
        })
        .returning({ id: service.id })
      await ctx.db.insert(tenancy).values({
        principalId: ctx.principalId,
        serviceId: shared!.id,
      })
      const added = await send(ctx, 'POST', `/environments/${other.envId}/shares`, {
        serviceId: shared!.id,
      })
      assertEquals(added.status, 200)

      assertEquals((await send(ctx, 'DELETE', `/projects/${home.projectId}`)).status, 409)
      assertEquals((await send(ctx, 'DELETE', `/environments/${home.envId}`)).status, 409)
      assertEquals((await entries(ctx, 'project.delete')).length, 0)
      assertEquals((await entries(ctx, 'environment.delete')).length, 0)
    } finally {
      await cleanUp(ctx)
    }
  })
})
