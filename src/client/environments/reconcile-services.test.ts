import { assertEquals } from 'jsr:@std/assert'
import { eq } from 'drizzle-orm'
import { describe, it } from '@std/testing/bdd'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import {
  environment,
  organization,
  project,
  service,
  workspace,
} from '../../lib/db/schema.ts'
import { reconcileServicesFromCompose } from './reconcile-services.ts'
import { assertComposeDocument } from '../../lib/compose/index.ts'

describe('reconcileServicesFromCompose', () => {
  it('creates service rows for compose service names', async () => {
    const dbUrl = getDatabaseUrl()
    if (!dbUrl) {
      console.warn('Skipping reconcile-services tests: TURBOPANEL_DATABASE_URL not set')
      return
    }

    const db = createDenoDb()

    const [orgRow] = await db.insert(organization).values({ displayName: 'Reconcile Org' }).returning({
      id: organization.id,
    })
    const [workspaceRow] = await db.insert(workspace).values({
      organizationId: orgRow.id,
      displayName: 'Default',
    }).returning({ id: workspace.id })
    const [projectRow] = await db.insert(project).values({
      workspaceId: workspaceRow.id,
      displayName: 'App',
    }).returning({ id: project.id })
    const [envRow] = await db.insert(environment).values({
      projectId: projectRow.id,
      displayName: 'Production',
    }).returning({ id: environment.id })

    const merged = assertComposeDocument({
      version: 1,
      data: {
        services: {
          web: { image: 'nginx:latest' },
          api: { image: 'node:22' },
        },
      },
      presentation: { keyOrder: ['services'], comments: {} },
    })

    const first = await reconcileServicesFromCompose(db, envRow.id, merged)
    assertEquals(first.created.length, 2)
    assertEquals(first.orphans.length, 0)

    const second = await reconcileServicesFromCompose(db, envRow.id, merged)
    assertEquals(second.created.length, 0)

    const rows = await db
      .select({ metadata: service.metadata })
      .from(service)
      .where(eq(service.environmentId, envRow.id))
    assertEquals(rows.length, 2)

    await db.delete(service).where(eq(service.environmentId, envRow.id))
    await db.delete(environment).where(eq(environment.id, envRow.id))
    await db.delete(project).where(eq(project.id, projectRow.id))
    await db.delete(workspace).where(eq(workspace.id, workspaceRow.id))
    await db.delete(organization).where(eq(organization.id, orgRow.id))
  })
})
