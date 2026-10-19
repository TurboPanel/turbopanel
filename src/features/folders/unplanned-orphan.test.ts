/**
 * A deploy that no longer plans a service folder leaves it in place as an
 * orphan. Needs a database.
 */
import { assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { folder } from '../../db/schema.ts'
import {
  createProject,
  withFolderFixtures as withFixtures,
} from '../../test-fixtures/folder-world.test.support.ts'
import { markFoldersPresent } from './allocate.ts'
import { markUnplannedServiceFoldersOrphan } from './reports.ts'

const test = Deno.test.bind(Deno)

type Ctx = Parameters<Parameters<typeof withFixtures>[0]>[0]

async function addRow(
  ctx: Ctx,
  envId: string,
  fields: { kind: 'service' | 'volume'; slug: string; state: string }
): Promise<string> {
  const [row] = await ctx.db
    .insert(folder)
    .values({
      serverId: ctx.serverId,
      principalId: ctx.principalId,
      environmentId: envId,
      scope: 'prod',
      kind: fields.kind,
      slug: fields.slug,
      state: fields.state,
    })
    .returning({ id: folder.id })
  return row!.id
}

async function states(ctx: Ctx): Promise<Record<string, string>> {
  const rows = await ctx.db.select().from(folder).where(eq(folder.serverId, ctx.serverId))
  return Object.fromEntries(rows.map((row) => [`${row.kind}/${row.slug}`, row.state]))
}

test('a present service folder the deploy no longer plans becomes an orphan', async () => {
  await withFixtures(async (ctx) => {
    const mine = await createProject(ctx, 'Unplanned One')
    const other = await createProject(ctx, 'Unplanned Two')
    const kept = await addRow(ctx, mine.envId, { kind: 'service', slug: 'api', state: 'present' })
    await addRow(ctx, mine.envId, { kind: 'service', slug: 'www', state: 'present' })
    await addRow(ctx, mine.envId, { kind: 'service', slug: 'next', state: 'planned' })
    await addRow(ctx, mine.envId, { kind: 'service', slug: 'old', state: 'removing' })
    await addRow(ctx, mine.envId, { kind: 'volume', slug: 'data', state: 'present' })
    await addRow(ctx, other.envId, { kind: 'service', slug: 'blog', state: 'present' })

    const changed = await markUnplannedServiceFoldersOrphan(ctx.db, {
      environmentId: mine.envId,
      serverId: ctx.serverId,
      plannedFolderIds: [kept],
    })

    assertEquals(changed, 1)
    assertEquals(await states(ctx), {
      'service/api': 'present',
      'service/www': 'orphan',
      'service/next': 'planned',
      'service/old': 'removing',
      'volume/data': 'present',
      'service/blog': 'present',
    })
  })
})

test('a deploy that plans no folder orphans every present service folder of the environment', async () => {
  await withFixtures(async (ctx) => {
    const mine = await createProject(ctx, 'Unplanned Three')
    await addRow(ctx, mine.envId, { kind: 'service', slug: 'www', state: 'present' })
    await addRow(ctx, mine.envId, { kind: 'volume', slug: 'data', state: 'present' })

    const changed = await markUnplannedServiceFoldersOrphan(ctx.db, {
      environmentId: mine.envId,
      serverId: ctx.serverId,
      plannedFolderIds: [],
    })

    assertEquals(changed, 1)
    assertEquals(await states(ctx), { 'service/www': 'orphan', 'volume/data': 'present' })
  })
})

test('a newer deploy that plans the service again lifts the orphan an older deploy left', async () => {
  await withFixtures(async (ctx) => {
    const mine = await createProject(ctx, 'Unplanned Four')
    // Deploy B planned the folder while it was present; older deploy A, which did not name the
    // service, finished first and marked it an orphan.
    const folderId = await addRow(ctx, mine.envId, {
      kind: 'service',
      slug: 'www',
      state: 'present',
    })
    await markUnplannedServiceFoldersOrphan(ctx.db, {
      environmentId: mine.envId,
      serverId: ctx.serverId,
      plannedFolderIds: [],
    })
    assertEquals(await states(ctx), { 'service/www': 'orphan' })

    // Deploy B finishes: the folder it planned is in use, not an orphan.
    await markFoldersPresent(ctx.db, [folderId])
    assertEquals(await states(ctx), { 'service/www': 'present' })
  })
})
