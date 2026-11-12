/**
 * `project.kind`, `project.icon` and `organization.icon` against a real
 * database: the CHECKs refuse unlisted words, and the icon ones also take an
 * emoji (anything of 1 to 16 characters without ASCII).
 */
import { skipWithoutDatabase } from '../test-fixtures/require-service.test.support.ts'
import { assert } from '@std/assert'
import { createDenoDb } from './connection.ts'
import { organization, project, workspace } from './schema.ts'
import { getDatabaseUrl } from './url.ts'
import { PROJECT_ICONS, PROJECT_KINDS } from '../features/projects/vocabulary.ts'
import { ICON_KEYS } from '../lib/icons.ts'

const test = Deno.test.bind(Deno)

const EMOJI = ['🚀', '👩‍💻', '🇺🇸', '❤️']
const REFUSED_ICONS = ['unicorn', 'a🚀', '1️⃣', '', '\u{1F680}'.repeat(17)]

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
  for (const icon of [...PROJECT_ICONS, ...EMOJI]) {
    await db.insert(project).values({ workspaceId, organizationId, icon })
  }
  for (const values of [
    { kind: 'template' },
    { kind: 'empty' },
    ...REFUSED_ICONS.map((icon) => ({ icon })),
  ]) {
    let refused = false
    try {
      await db.insert(project).values({ workspaceId, organizationId, ...values })
    } catch {
      refused = true
    }
    assert(refused, `${JSON.stringify(values)} should be refused`)
  }
})

test('organization icon accepts a key, an emoji and null, and refuses the rest', async () => {
  if (!getDatabaseUrl()) {
    skipWithoutDatabase('organization icon check tests')
    return
  }
  const db = createDenoDb()
  for (const icon of [null, ...ICON_KEYS, ...EMOJI]) {
    const [row] = await db
      .insert(organization)
      .values({ name: 'Organization Icon Check Org', icon })
      .returning({ isEmojiIconAllowed: organization.isEmojiIconAllowed })
    assert(row?.isEmojiIconAllowed === true, 'emoji icons are allowed by default')
  }
  for (const icon of REFUSED_ICONS) {
    let refused = false
    try {
      await db.insert(organization).values({ name: 'Organization Icon Check Org', icon })
    } catch {
      refused = true
    }
    assert(refused, `${JSON.stringify(icon)} should be refused`)
  }
})
