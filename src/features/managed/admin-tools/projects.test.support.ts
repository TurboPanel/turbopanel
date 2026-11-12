/** Fixtures for the database-backed admin tool tests (never imported by production code). */

import { eq } from 'drizzle-orm'
import type { Db } from '../../../db/connection.ts'
import { binding, environment, project, service } from '../../../db/schema.ts'
import { adminToolMetadata } from './projects.ts'

/**
 * A project that looks like an admin tool of `metadataManagedId`, with its
 * `tool` service bound to `loginId` on `databaseId`. The binding is what makes
 * it a tool, so a test can point it at another cluster's login.
 */
export async function insertToolProjectFixture(
  db: Db,
  input: {
    organizationId: string
    workspaceId: string
    serverId: string
    metadataManagedId: string
    metadataLoginId: string
    boundLoginId: string
    boundDatabaseId: string
    name: string
  }
): Promise<{ projectId: string; environmentId: string; serviceId: string }> {
  const [proj] = await db
    .insert(project)
    .values({
      name: input.name,
      workspaceId: input.workspaceId,
      organizationId: input.organizationId,
      kind: 'compose',
      metadata: adminToolMetadata({
        tool: 'adminer',
        managedId: input.metadataManagedId,
        loginId: input.metadataLoginId,
        loginName: 'adminer_aaaaaa',
        hostname: 'db-admin.example.com',
        access: 'admin',
        revision: 1,
      }),
    })
    .returning({ id: project.id })
  const [env] = await db
    .insert(environment)
    .values({
      name: 'production',
      projectId: proj!.id,
      serverId: input.serverId,
      isPrimary: true,
    })
    .returning({ id: environment.id })
  const [svc] = await db
    .insert(service)
    .values({ environmentId: env!.id, name: 'tool', composeServiceName: 'tool' })
    .returning({ id: service.id })
  await db.insert(binding).values({
    loginId: input.boundLoginId,
    serviceId: svc!.id,
    databaseId: input.boundDatabaseId,
    keyPrefix: 'DB',
    isEmitEngineDefaults: false,
    preset: null,
  })
  return { projectId: proj!.id, environmentId: env!.id, serviceId: svc!.id }
}

/** Removes a tool project made by {@link insertToolProjectFixture}, children first. */
export async function removeToolProjectFixture(
  db: Db,
  made: { projectId: string; environmentId: string; serviceId: string }
): Promise<void> {
  await db.delete(binding).where(eq(binding.serviceId, made.serviceId))
  await db.delete(service).where(eq(service.id, made.serviceId))
  await db.delete(environment).where(eq(environment.id, made.environmentId))
  await db.delete(project).where(eq(project.id, made.projectId))
}
