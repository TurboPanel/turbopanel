import { assertEquals } from 'jsr:@std/assert'
import { eq } from 'drizzle-orm'
import { getDatabaseUrl } from './db-url.ts'
import { createDenoDb } from './db.ts'
import { createLicense } from './client/authn/license.ts'
import { organization, server } from './lib/db/schema.ts'
import { resolveServerId } from './server-registry.ts'

const dbUrl = getDatabaseUrl()

async function withTestDb(fn: (db: ReturnType<typeof createDenoDb>) => Promise<void>) {
  if (!dbUrl) {
    console.warn('Skipping server-registry tests: TURBOPANEL_DATABASE_URL not set')
    return
  }
  const db = createDenoDb()
  await fn(db)
}

Deno.test('resolveServerId blocks unauthenticated server creation', async () => {
  await withTestDb(async (db) => {
    const resolved = await resolveServerId(db, {
      hostname: `server-registry-${crypto.randomUUID()}`,
      machineId: `machine-${crypto.randomUUID()}`,
    })
    assertEquals(resolved, null)
  })
})

Deno.test('resolveServerId still resolves existing server by serverId', async () => {
  await withTestDb(async (db) => {
    const now = new Date().toISOString()
    const [inserted] = await db
      .insert(server)
      .values({
        createdAt: now,
        updatedAt: now,
        metadata: {
          hostname: `existing-${crypto.randomUUID()}`,
          machineId: `machine-${crypto.randomUUID()}`,
        },
      })
      .returning({ id: server.id })

    const existingId = inserted!.id
    try {
      const resolved = await resolveServerId(db, { serverId: existingId })
      assertEquals(resolved, existingId)
    } finally {
      await db.delete(server).where(eq(server.id, existingId))
    }
  })
})

Deno.test('resolveServerId creates row for licensed enrollment', async () => {
  await withTestDb(async (db) => {
    const [org] = await db
      .insert(organization)
      .values({ displayName: 'Server Registry Test Org' })
      .returning({ id: organization.id })

    const organizationId = org!.id
    const { licenseId, licenseToken } = await createLicense(db, {
      organizationId,
      displayName: 'Server Registry Test License',
    })

    const hostname = `licensed-${crypto.randomUUID()}`
    const machineId = `machine-${crypto.randomUUID()}`
    const resolved = await resolveServerId(db, {
      hostname,
      machineId,
      licenseId,
      licenseToken,
    })

    try {
      if (!resolved) {
        throw new Error('expected resolveServerId to return server id for valid license')
      }
    } finally {
      if (resolved) {
        await db.delete(server).where(eq(server.id, resolved))
      }
      await db.delete(organization).where(eq(organization.id, organizationId))
    }
  })
})
