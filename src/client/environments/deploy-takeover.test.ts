/**
 * Which hostnames a deploy lets the host take over, and from which environment.
 * Needs a database.
 */
import { assertEquals } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
import {
  deployment,
  hosting,
  hostname,
  organization,
  project,
  service,
} from '../../db/schema.ts'
import {
  type Ctx,
  createProject,
  withFolderFixtures as withFixtures,
} from '../../test-fixtures/folder-world.test.support.ts'
import { servedNamesOf, takeoverHostnamesFor } from './deploy-takeover.ts'

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

/** The deploy row an environment has on the test server, with what the panel last sent it. */
async function deployedOn(ctx: Ctx, envId: string, served?: string[]): Promise<void> {
  await ctx.db.insert(deployment).values({
    environmentId: envId,
    serverId: ctx.serverId,
    options: served === undefined ? null : { servedHostnames: served },
  })
}

function entries(ctx: Ctx, envId: string, hostings: { hostnames: string[]; www?: 'both' }[]) {
  return takeoverHostnamesFor(ctx.db, {
    environmentId: envId,
    organizationId: ctx.organizationId,
    serverId: ctx.serverId,
    hostings,
  })
}

test('a name the old environment was last sent, and no longer has a hosting for, names that environment', async (ctx) => {
  const { envId } = await createProject(ctx, 'Takeover New')
  const old = await createProject(ctx, 'Takeover Old')
  await deployedOn(ctx, old.envId, ['example.com', 'kept.example.com'])
  await addHosting(ctx, old.envId, ['kept.example.com'])

  assertEquals(await entries(ctx, envId, [{ hostnames: ['example.com', 'kept.example.com'] }]), [
    { hostname: 'example.com', fromEnvironmentId: old.envId },
  ])
})

test('a name nothing here was ever sent is not listed, even when no hosting row holds it', async (ctx) => {
  const { envId } = await createProject(ctx, 'Takeover First')
  const old = await createProject(ctx, 'Takeover Unproven')
  // Deployed here before names were recorded, or never sent this name.
  await deployedOn(ctx, old.envId)
  const other = await createProject(ctx, 'Takeover Other')
  await deployedOn(ctx, other.envId, ['elsewhere.example.com'])

  assertEquals(await entries(ctx, envId, [{ hostnames: ['example.com'] }]), [])
})

test("another organization's environment is never named", async (ctx) => {
  const { envId } = await createProject(ctx, 'Takeover Mine')
  const theirs = await createProject(ctx, 'Takeover Theirs')
  const [other] = await ctx.db
    .insert(organization)
    .values({ name: 'Other Organization' })
    .returning({ id: organization.id })
  made.organizations.push(other!.id)
  await ctx.db
    .update(project)
    .set({ organizationId: other!.id })
    .where(eq(project.id, theirs.projectId))
  await deployedOn(ctx, theirs.envId, ['example.com'])

  try {
    assertEquals(await entries(ctx, envId, [{ hostnames: ['example.com'] }]), [])
  } finally {
    // Back to the fixture's organization, so the fixture can remove the other one.
    await ctx.db
      .update(project)
      .set({ organizationId: ctx.organizationId })
      .where(eq(project.id, theirs.projectId))
  }
})

test('the deploying environment never names itself', async (ctx) => {
  const { envId } = await createProject(ctx, 'Takeover Self')
  await deployedOn(ctx, envId, ['example.com'])
  assertEquals(await entries(ctx, envId, [{ hostnames: ['example.com'] }]), [])
})

test('the www names a hosting owns are listed too, each from the environment that was sent it', async (ctx) => {
  const { envId } = await createProject(ctx, 'Takeover Www')
  const a = await createProject(ctx, 'Takeover A')
  const b = await createProject(ctx, 'Takeover B')
  await deployedOn(ctx, a.envId, ['example.com'])
  await deployedOn(ctx, b.envId, ['www.example.com'])

  assertEquals(await entries(ctx, envId, [{ hostnames: ['example.com'], www: 'both' }]), [
    { hostname: 'example.com', fromEnvironmentId: a.envId },
    { hostname: 'www.example.com', fromEnvironmentId: b.envId },
  ])
})

test('an old environment that still serves the name through its www choice still holds it', async (ctx) => {
  const { envId } = await createProject(ctx, 'Takeover Redirect')
  const old = await createProject(ctx, 'Takeover Redirect Old')
  await deployedOn(ctx, old.envId, ['example.com', 'www.example.com'])
  const row = await addHosting(ctx, old.envId, ['example.com'])
  await ctx.db
    .update(hosting)
    .set({ options: { hostnames: ['example.com'], www: 'both' } })
    .where(eq(hosting.id, row))

  assertEquals(await entries(ctx, envId, [{ hostnames: ['example.com'], www: 'both' }]), [])
})

test('names are compared folded: case and international spelling', async (ctx) => {
  const { envId } = await createProject(ctx, 'Takeover Fold')
  const old = await createProject(ctx, 'Takeover Fold Old')
  await deployedOn(ctx, old.envId, ['Xn--Bcher-Kva.Example'])

  assertEquals(await entries(ctx, envId, [{ hostnames: ['Bücher.Example'] }]), [
    { hostname: 'xn--bcher-kva.example', fromEnvironmentId: old.envId },
  ])
  assertEquals(servedNamesOf([{ hostnames: ['B\u00fccher.Example'], www: 'both' }]), [
    'www.xn--bcher-kva.example',
    'xn--bcher-kva.example',
  ])
})

test('nothing to ask about lists nothing', async (ctx) => {
  const { envId } = await createProject(ctx, 'Takeover Empty')
  assertEquals(await entries(ctx, envId, []), [])
})
