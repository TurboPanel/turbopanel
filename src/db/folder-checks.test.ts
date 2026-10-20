/**
 * The `folder` table's own CHECKs and unique location, against a real database.
 * The rule patterns come from `contracts/directory-names.ts`; this proves the
 * database refuses what the code would, so a writer that skips the code cannot
 * leave a folder row the host would reject.
 */
import { skipWithoutDatabase } from '../test-fixtures/require-service.test.support.ts'
import { assert, assertEquals } from '@std/assert'
import { eq, sql } from 'drizzle-orm'
import { createDenoDb } from './connection.ts'
import {
  folder,
  organization,
  principal,
  server,
  service,
  environment,
  project,
  workspace,
} from './schema.ts'
import { RESERVED_SCOPE_NAMES } from '../contracts/directory-names.ts'
import { getDatabaseUrl } from './url.ts'
import { isUniqueViolationOn } from './unique-violation.ts'

const test = Deno.test.bind(Deno)

test('folder rows are held to the name rules and to one row per location', async () => {
  if (!getDatabaseUrl()) {
    skipWithoutDatabase('folder check tests')
    return
  }
  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'Folder Check Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const [ws] = await db
    .insert(workspace)
    .values({ name: 'ws', organizationId })
    .returning({ id: workspace.id })
  const [proj] = await db
    .insert(project)
    .values({ name: 'p', workspaceId: ws!.id, organizationId })
    .returning({ id: project.id })
  const [env] = await db
    .insert(environment)
    .values({ projectId: proj!.id, name: 'production' })
    .returning({ id: environment.id })
  const [svc] = await db
    .insert(service)
    .values({ environmentId: env!.id, composeServiceName: 'web', slug: 'web' })
    .returning({ id: service.id })
  const now = new Date().toISOString()
  const [srv] = await db
    .insert(server)
    .values({ organizationId, name: 'S', createdAt: now, updatedAt: now })
    .returning({ id: server.id })
  const username = `fc_${crypto.randomUUID().slice(0, 8).replaceAll('-', '')}`
  const [owner] = await db
    .insert(principal)
    .values({
      organizationId,
      username,
      appliedUsername: username,
    })
    .returning({ id: principal.id })

  const base: {
    serverId: string
    principalId: string
    environmentId: string | null
    scope: string
    kind: string
    slug: string
    serviceId: string | null
    state: string
  } = {
    serverId: srv!.id,
    principalId: owner!.id,
    environmentId: env!.id,
    scope: 'production',
    kind: 'service',
    slug: 'example.com',
    serviceId: svc!.id,
    state: 'planned',
  }
  const refuses = async (name: string, values: Partial<typeof base>) => {
    let message = ''
    try {
      await db.insert(folder).values({ ...base, ...values })
    } catch (err) {
      message = String(
        (err as { cause?: { constraint_name?: string }; message?: string }).cause
          ?.constraint_name ?? err
      )
    }
    assert(message.includes(name), `${name}: got "${message}"`)
  }

  try {
    await refuses('folder_slug_check', { slug: 'Example.com' })
    await refuses('folder_slug_check', { slug: 'a..b' })
    await refuses('folder_slug_check', { slug: '.example' })
    await refuses('folder_scope_check', { scope: 'Production' })
    await refuses('folder_scope_check', { scope: 'home' })
    await refuses('folder_scope_check', { scope: 'base' })
    await refuses('folder_scope_check', { scope: 'my env' })
    await refuses('folder_common_scope_check', { scope: 'common' })
    // A kind outside the list also fails the kind-to-asset check; Postgres reports the first by name.
    await refuses('folder_asset_kind_check', { kind: 'site' })
    await refuses('folder_state_check', { state: 'gone' })
    await refuses('folder_asset_kind_check', { kind: 'volume' })
    await refuses('folder_common_scope_check', { environmentId: null })

    await db.insert(folder).values(base)
    let duplicate: unknown
    try {
      await db.insert(folder).values(base)
    } catch (err) {
      duplicate = err
    }
    assert(isUniqueViolationOn(duplicate, 'uniq_folder_location'))

    // A deleted asset leaves the row behind as `removing`, with no asset id.
    await db.delete(folder).where(eq(folder.serverId, srv!.id))
    await db.insert(folder).values({ ...base, serviceId: null, state: 'removing' })
    // An orphan may name a scope whose environment is unknown.
    await db
      .insert(folder)
      .values({ ...base, environmentId: null, serviceId: null, slug: 'stray', state: 'orphan' })
    const rows = await db.select({ id: folder.id }).from(folder).where(eq(folder.serverId, srv!.id))
    assertEquals(rows.length, 2)
    // The scope `common` is allowed with no environment.
    await db
      .insert(folder)
      .values({ ...base, scope: 'common', environmentId: null, slug: 'shared' })
  } finally {
    await db.delete(folder).where(eq(folder.serverId, srv!.id))
    await db.delete(service).where(eq(service.id, svc!.id))
    await db.delete(environment).where(eq(environment.id, env!.id))
    await db.delete(project).where(eq(project.id, proj!.id))
    await db.delete(principal).where(eq(principal.id, owner!.id))
    await db.delete(server).where(eq(server.id, srv!.id))
    await db.delete(workspace).where(eq(workspace.id, ws!.id))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
})

test('the environment name check refuses base, and an old base row is held until renamed', async () => {
  if (!getDatabaseUrl()) {
    skipWithoutDatabase('environment name check tests')
    return
  }
  const db = createDenoDb()
  const rollback = new Error('rollback')
  const constraintOf = (err: unknown) =>
    String((err as { cause?: { constraint_name?: string } }).cause?.constraint_name ?? err)
  try {
    await db.transaction(async (tx) => {
      const [org] = await tx
        .insert(organization)
        .values({ name: 'Base Name Org' })
        .returning({ id: organization.id })
      const organizationId = org!.id
      const [ws] = await tx
        .insert(workspace)
        .values({ name: 'ws', organizationId })
        .returning({ id: workspace.id })
      const [proj] = await tx
        .insert(project)
        .values({ name: 'p', workspaceId: ws!.id, organizationId })
        .returning({ id: project.id })
      // Each attempt runs in its own savepoint so a refusal does not abort the transaction.
      const attempt = async (run: () => Promise<unknown>): Promise<string> => {
        try {
          await tx.transaction(async () => {
            await run()
          })
        } catch (err) {
          return constraintOf(err)
        }
        return ''
      }
      const insertEnv = (name: string) =>
        tx
          .insert(environment)
          .values({ projectId: proj!.id, name })
          .returning({ id: environment.id })

      // With the current check, a new environment called base is refused.
      assert((await attempt(() => insertEnv('base'))).includes('environment_name_check'))
      assert((await attempt(() => insertEnv('Base'))).includes('environment_name_check'))

      // An old row from before the word was reserved: put the check back the way
      // the upgrade adds it (not validated), after the row exists.
      const list = RESERVED_SCOPE_NAMES.map((name) => `'${name}'`).join(', ')
      await tx.execute(sql`ALTER TABLE "environment" DROP CONSTRAINT "environment_name_check"`)
      const [old] = await insertEnv('base')
      await tx.execute(
        sql.raw(
          `ALTER TABLE "environment" ADD CONSTRAINT "environment_name_check" CHECK (name ~ '^[a-z0-9][a-z0-9_-]{0,31}$' AND name NOT IN (${list})) NOT VALID`
        )
      )
      // The old row cannot be changed in any column until it is renamed.
      const unrelated = await attempt(() =>
        tx.update(environment).set({ isPinned: true }).where(eq(environment.id, old!.id))
      )
      assert(unrelated.includes('environment_name_check'), unrelated)
      // A rename to an allowed name works, and renaming back to base is refused.
      await tx.update(environment).set({ name: 'main' }).where(eq(environment.id, old!.id))
      const back = await attempt(() =>
        tx.update(environment).set({ name: 'base' }).where(eq(environment.id, old!.id))
      )
      assert(back.includes('environment_name_check'), back)
      throw rollback
    })
  } catch (err) {
    if (err !== rollback) throw err
  }
})
