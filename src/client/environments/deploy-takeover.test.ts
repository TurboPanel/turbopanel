/**
 * Which hostnames a deploy lets the host take over from a leftover host config.
 * Needs a database.
 */
import { assertEquals } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
import {
  deployment,
  environment,
  hosting,
  hostname,
  organization,
  service,
} from '../../db/schema.ts'
import {
  type Ctx,
  createProject,
  withFolderFixtures as withFixtures,
} from '../../test-fixtures/folder-world.test.support.ts'
import { takeoverHostnamesFor } from './deploy-takeover.ts'

const rawTest = Deno.test.bind(Deno)

/** What a test added that the fixture's own teardown does not know about. */
const made = { hostings: [] as string[], organizations: [] as string[] }

/** A test body run inside the fixtures, with the rows it made removed after. */
function test(name: string, body: (ctx: Ctx) => Promise<void>): void {
  rawTest(name, async () => {
    await withFixtures(async (ctx) => {
      try {
        await body(ctx)
      } finally {
        if (made.hostings.length > 0) {
          await ctx.db.delete(hosting).where(inArray(hosting.id, made.hostings))
        }
        await ctx.db.delete(deployment).where(eq(deployment.serverId, ctx.serverId))
        if (made.organizations.length > 0) {
          await ctx.db.delete(organization).where(inArray(organization.id, made.organizations))
        }
        made.hostings = []
        made.organizations = []
      }
    })
  })
}

/** A hosting with its hostname rows, in an environment, held by `routingOrganizationId`. */
async function addHosting(
  ctx: Ctx,
  envId: string,
  names: string[],
  routingOrganizationId = ctx.organizationId
): Promise<string> {
  const [svc] = await ctx.db
    .insert(service)
    .values({
      environmentId: envId,
      composeServiceName: `svc-${crypto.randomUUID().slice(0, 8)}`,
      name: 'web',
    })
    .returning({ id: service.id })
  const [row] = await ctx.db
    .insert(hosting)
    .values({ serviceId: svc!.id, options: { hostnames: names } })
    .returning({ id: hosting.id })
  made.hostings.push(row!.id)
  for (const name of names) {
    await ctx.db
      .insert(hostname)
      .values({ hostingId: row!.id, routingOrganizationId, hostname: name })
  }
  return row!.id
}

async function deployedOn(ctx: Ctx, envId: string): Promise<void> {
  await ctx.db.insert(deployment).values({ environmentId: envId, serverId: ctx.serverId })
}

function names(ctx: Ctx, envId: string, hostingIds: string[]) {
  return takeoverHostnamesFor(ctx.db, {
    environmentId: envId,
    serverId: ctx.serverId,
    hostingIds,
  })
}

test('a name whose old hosting was deleted is listed: nothing else holds it', async (ctx) => {
  const { envId } = await createProject(ctx, 'Takeover New')
  const old = await createProject(ctx, 'Takeover Old')
  await deployedOn(ctx, old.envId)
  const stale = await addHosting(ctx, old.envId, ['example.com'])
  // The old hosting is deleted in the panel (its hostname rows go with it).
  await ctx.db.delete(hosting).where(eq(hosting.id, stale))

  const fresh = await addHosting(ctx, envId, ['example.com', 'www.example.com'])
  assertEquals(await names(ctx, envId, [fresh]), ['example.com', 'www.example.com'])
})

test("another organization's live hosting of the same name on this server is never listed", async (ctx) => {
  const { envId } = await createProject(ctx, 'Takeover Mine')
  const theirs = await createProject(ctx, 'Takeover Theirs')
  const [other] = await ctx.db
    .insert(organization)
    .values({ name: 'Other Organization' })
    .returning({ id: organization.id })
  made.organizations.push(other!.id)
  await deployedOn(ctx, theirs.envId)
  await addHosting(ctx, theirs.envId, ['shared.example.com'], other!.id)

  const mine = await addHosting(ctx, envId, ['shared.example.com', 'mine.example.com'])
  // Only the name nobody else holds on this server is listed.
  assertEquals(await names(ctx, envId, [mine]), ['mine.example.com'])
})

test('a live hosting counts when its environment is pinned to the server, and not when it is elsewhere', async (ctx) => {
  const { envId } = await createProject(ctx, 'Takeover Scope')
  const pinned = await createProject(ctx, 'Takeover Pinned')
  const away = await createProject(ctx, 'Takeover Away')
  await ctx.db
    .update(environment)
    .set({ serverId: ctx.serverId })
    .where(eq(environment.id, pinned.envId))
  // Another organization holds both names (the same organization could not hold a name twice).
  const [other] = await ctx.db
    .insert(organization)
    .values({ name: 'Other Organization Two' })
    .returning({ id: organization.id })
  made.organizations.push(other!.id)
  await addHosting(ctx, pinned.envId, ['pinned.example.com'], other!.id)
  await addHosting(ctx, away.envId, ['away.example.com'], other!.id)

  const mine = await addHosting(ctx, envId, ['pinned.example.com', 'away.example.com'])
  // `away` is not on this server (never deployed here, not pinned): no snippet of it can be here.
  assertEquals(await names(ctx, envId, [mine]), ['away.example.com'])
})

test('nothing to ask about lists nothing, and only the deploy hostings are the deploy own', async (ctx) => {
  const { envId } = await createProject(ctx, 'Takeover Empty')
  assertEquals(await names(ctx, envId, []), [])
  const own = await addHosting(ctx, envId, ['own.example.com'])
  const other = await addHosting(ctx, envId, ['other.example.com'])
  await deployedOn(ctx, envId)
  // Naming only `own`: `other` of the same environment is a different hosting, so it holds its name.
  assertEquals(await names(ctx, envId, [own]), ['own.example.com'])
  assertEquals(await names(ctx, envId, [own, other]), ['other.example.com', 'own.example.com'])
})
