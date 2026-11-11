/**
 * The stored tunnel table generation against a real database: first write,
 * unchanged keeps, changed raises, a concurrent writer that loses retries, a
 * deliberate raise, and other organization options surviving. Skips without
 * TURBOPANEL_DATABASE_URL.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assert, assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { organization } from '../../db/schema.ts'
import { bumpTunnelGeneration, resolveTunnelGeneration } from './table-generation.ts'
import type { RoutingFacts } from './route-facts.ts'

/** Sonar only recognises `test()`; see the note in the other suites. */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()
const NOW = 1_800_000_000_000

function facts(carrier: string): RoutingFacts {
  return {
    tunnels: [{ carrying: [carrier], doorways: [] }],
    addresses: new Map([[carrier, ['10.0.0.1']]]),
  }
}

async function withOrganization(
  options: Record<string, unknown> | null,
  body: (db: ReturnType<typeof createDenoDb>, organizationId: string) => Promise<void>
): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('tunnel table generation tests')
    return
  }
  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'Tunnel Generation Org', options })
    .returning({ id: organization.id })
  const organizationId = org!.id
  try {
    await body(db, organizationId)
  } finally {
    await db.delete(organization).where(eq(organization.id, organizationId))
    await endDbConnection(db)
  }
}

async function storedOptions(db: ReturnType<typeof createDenoDb>, id: string) {
  const [row] = await db
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, id))
  return row!.options as Record<string, unknown>
}

test('the first write stores the clock, an unchanged table keeps it, a change raises it', async () => {
  await withOrganization(null, async (db, id) => {
    const first = await resolveTunnelGeneration(db, id, facts('s1'), () => NOW)
    assertEquals(first, NOW)
    assertEquals(await resolveTunnelGeneration(db, id, facts('s1'), () => NOW + 3_600_000), NOW)
    const changed = await resolveTunnelGeneration(db, id, facts('s2'), () => NOW + 10)
    assertEquals(changed, NOW + 10)
    // The clock behind the stored value still goes up by one.
    assertEquals(await resolveTunnelGeneration(db, id, facts('s3'), () => NOW), NOW + 11)
  })
})

test('other organization options survive the write', async () => {
  await withOrganization({ sshPort: 2222, nested: { keep: true } }, async (db, id) => {
    await resolveTunnelGeneration(db, id, facts('s1'), () => NOW)
    const options = await storedOptions(db, id)
    assertEquals(options.sshPort, 2222)
    assertEquals(options.nested, { keep: true })
    assert('tunnelTable' in options)
  })
})

test('two writers that see the same change store one value', async () => {
  await withOrganization(null, async (db, id) => {
    const results = await Promise.all([
      resolveTunnelGeneration(db, id, facts('s1'), () => NOW),
      resolveTunnelGeneration(db, id, facts('s1'), () => NOW + 5),
      resolveTunnelGeneration(db, id, facts('s1'), () => NOW + 9),
    ])
    const stored = (await storedOptions(db, id)).tunnelTable as { generation: number }
    // The loser of the compare-and-set read the winner's value and kept it.
    assertEquals(new Set(results).size, 1)
    assertEquals(results[0], stored.generation)
  })
})

test('a deliberate raise goes up once, then waits out the gap', async () => {
  await withOrganization(null, async (db, id) => {
    await resolveTunnelGeneration(db, id, facts('s1'), () => NOW)
    assertEquals(await bumpTunnelGeneration(db, id, () => NOW + 1_000), NOW + 1_000)
    assertEquals(await bumpTunnelGeneration(db, id, () => NOW + 2_000), undefined)
    // The same content now reuses the raised number.
    assertEquals(await resolveTunnelGeneration(db, id, facts('s1'), () => NOW + 3_000), NOW + 1_000)
  })
})

test('a malformed stored value is replaced rather than looping', async () => {
  await withOrganization({ tunnelTable: 'broken' }, async (db, id) => {
    assertEquals(await resolveTunnelGeneration(db, id, facts('s1'), () => NOW), NOW)
    assertEquals(await resolveTunnelGeneration(db, id, facts('s1'), () => NOW + 1), NOW)
  })
})
