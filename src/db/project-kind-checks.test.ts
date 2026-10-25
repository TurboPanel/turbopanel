/**
 * `project.kind` and `project.icon` against a real database: the CHECKs refuse
 * unlisted words.
 */
import { skipWithoutDatabase } from '../test-fixtures/require-service.test.support.ts'
import { assert } from '@std/assert'
import { createDenoDb } from './connection.ts'
import { organization, project, workspace } from './schema.ts'
import { getDatabaseUrl } from './url.ts'
import { PROJECT_ICONS, PROJECT_KINDS } from '../features/projects/vocabulary.ts'

const test = Deno.test.bind(Deno)

test('project kind and icon accept the listed words and null, and refuse the rest', async () => {
  if (!getDatabaseUrl()) {
    skipWithoutDatabase('project kind check tests')
    return
  }
  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'Project Kind Check Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const [ws] = await db
    .insert(workspace)
    .values({ name: 'ws', organizationId })
    .returning({ id: workspace.id })
  const workspaceId = ws!.id

  for (const kind of [null, ...PROJECT_KINDS]) {
    await db.insert(project).values({ workspaceId, organizationId, kind })
  }
  for (const icon of PROJECT_ICONS) {
    await db.insert(project).values({ workspaceId, organizationId, icon })
  }
  for (const values of [{ kind: 'template' }, { kind: 'empty' }, { icon: 'unicorn' }]) {
    let refused = false
    try {
      await db.insert(project).values({ workspaceId, organizationId, ...values })
    } catch {
      refused = true
    }
    assert(refused, `${JSON.stringify(values)} should be refused`)
  }
})
