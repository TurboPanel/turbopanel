/**
 * The deploy time limit column, the template stamp on a project and the
 * server's preferred datacenter, against a real database: the CHECKs refuse
 * bad values and deleting a datacenter only clears the preference.
 */
import { skipWithoutDatabase } from '../test-fixtures/require-service.test.support.ts'
import { assert, assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { createDenoDb } from './connection.ts'
import { datacenter, organization, project, server, workspace } from './schema.ts'
import { getDatabaseUrl } from './url.ts'

const test = Deno.test.bind(Deno)

async function refused(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run()
    return false
  } catch {
    return true
  }
}

test('the deploy time limit column takes null and 5 to 240 only', async () => {
  if (!getDatabaseUrl()) {
    skipWithoutDatabase('deploy time limit check tests')
    return
  }
  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'Deploy Limit Check Org' })
    .returning({ id: organization.id, minutes: organization.deployTimeoutMinutes })
  assertEquals(org!.minutes, null)
  for (const deployTimeoutMinutes of [5, 30, 240, null]) {
    await db.update(organization).set({ deployTimeoutMinutes }).where(eq(organization.id, org!.id))
  }
  for (const deployTimeoutMinutes of [0, 4, 241, -1]) {
    assert(
      await refused(() =>
        db.update(organization).set({ deployTimeoutMinutes }).where(eq(organization.id, org!.id))
      ),
      `${deployTimeoutMinutes} should be refused`
    )
  }
})

test('the project template stamp is all four columns or none, and each is shaped', async () => {
  if (!getDatabaseUrl()) {
    skipWithoutDatabase('project template stamp check tests')
    return
  }
  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'Template Stamp Check Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const [ws] = await db
    .insert(workspace)
    .values({ name: 'ws', organizationId })
    .returning({ id: workspace.id })
  const workspaceId = ws!.id
  const stamp = {
    templateCode: 'wordpress',
    templateTrack: '6.8',
    templateVersion: '1.4.0',
    templateDigest: `sha256:${'a'.repeat(64)}`,
  }

  await db.insert(project).values({ workspaceId, organizationId })
  await db.insert(project).values({ workspaceId, organizationId, ...stamp })
  const bad: Record<string, unknown>[] = [
    { templateCode: 'wordpress' },
    { ...stamp, templateTrack: null },
    { ...stamp, templateCode: 'WordPress' },
    { ...stamp, templateCode: '9lives' },
    { ...stamp, templateTrack: '.6' },
    { ...stamp, templateVersion: '1.4' },
    { ...stamp, templateVersion: '1.x.0' },
    { ...stamp, templateDigest: 'sha256:abc' },
    { ...stamp, templateDigest: `md5:${'a'.repeat(64)}` },
  ]
  for (const values of bad) {
    assert(
      await refused(() => db.insert(project).values({ workspaceId, organizationId, ...values })),
      `${JSON.stringify(values)} should be refused`
    )
  }
})

test('a server may prefer a datacenter, and deleting the datacenter clears the preference', async () => {
  if (!getDatabaseUrl()) {
    skipWithoutDatabase('server preferred datacenter tests')
    return
  }
  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'Preferred Datacenter Check Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const [dc] = await db
    .insert(datacenter)
    .values({ organizationId, name: 'preferred-dc' })
    .returning({ id: datacenter.id })
  const [srv] = await db
    .insert(server)
    .values({ organizationId, preferredDatacenterId: dc!.id })
    .returning({ id: server.id, preferred: server.preferredDatacenterId })
  assertEquals(srv!.preferred, dc!.id)

  assert(
    await refused(() =>
      db
        .update(server)
        .set({ preferredDatacenterId: '00000000-0000-7000-8000-000000000000' })
        .where(eq(server.id, srv!.id))
    ),
    'a datacenter that does not exist should be refused'
  )

  await db.delete(datacenter).where(eq(datacenter.id, dc!.id))
  const [after] = await db
    .select({ preferred: server.preferredDatacenterId })
    .from(server)
    .where(eq(server.id, srv!.id))
  assertEquals(after!.preferred, null)
})
