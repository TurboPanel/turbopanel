import { assertEquals } from 'jsr:@std/assert'
import { eq } from 'drizzle-orm'
import { getDatabaseUrl } from './db-url.ts'
import { createDenoDb } from './db.ts'
import { createLicense } from './client/authn/license.ts'
import { organization, server } from './lib/db/schema.ts'
import { resolveServerId, touchServerMetadata } from './server-registry.ts'

const dbUrl = getDatabaseUrl()

/** Canonical 64-char lowercase hex HMAC shape used by real daemons. */
function randomMachineKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Raw `/etc/machine-id` shape — must never be persisted as machineKey. */
const RAW_MACHINE_ID = '0123456789abcdef0123456789abcdef'

async function withTestDb(fn: (db: ReturnType<typeof createDenoDb>) => Promise<void>) {
  if (!dbUrl) {
    console.warn('Skipping server-registry tests: TURBOPANEL_DATABASE_URL not set')
    return
  }
  const db = createDenoDb()
  await fn(db)
}

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('resolveServerId blocks unauthenticated server creation', async () => {
  await withTestDb(async (db) => {
    const resolved = await resolveServerId(db, {
      hostname: `server-registry-${crypto.randomUUID()}`,
      machineKey: randomMachineKey(),
    })
    assertEquals(resolved, null)
  })
})

test('resolveServerId still resolves existing server by serverId', async () => {
  await withTestDb(async (db) => {
    const now = new Date().toISOString()
    const [inserted] = await db
      .insert(server)
      .values({
        createdAt: now,
        updatedAt: now,
        hostname: `existing-${crypto.randomUUID()}`,
        machineKey: randomMachineKey(),
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

test('resolveServerId creates row for licensed enrollment', async () => {
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
    const machineKey = randomMachineKey()
    const resolved = await resolveServerId(db, {
      hostname,
      machineKey,
      licenseId,
      licenseToken,
    })

    try {
      if (!resolved) {
        throw new Error('expected resolveServerId to return server id for valid license')
      }
      const [row] = await db
        .select({ machineKey: server.machineKey })
        .from(server)
        .where(eq(server.id, resolved))
        .limit(1)
      assertEquals(row?.machineKey, machineKey)
    } finally {
      if (resolved) {
        await db.delete(server).where(eq(server.id, resolved))
      }
      await db.delete(organization).where(eq(organization.id, organizationId))
    }
  })
})

test('touchServerMetadata ignores a raw machine-id shaped machineKey', async () => {
  await withTestDb(async (db) => {
    const now = new Date().toISOString()
    const validKey = randomMachineKey()
    const [inserted] = await db
      .insert(server)
      .values({
        createdAt: now,
        updatedAt: now,
        hostname: `ignore-raw-${crypto.randomUUID()}`,
        machineKey: validKey,
      })
      .returning({ id: server.id })

    const serverId = inserted!.id
    try {
      await touchServerMetadata(db, serverId, {
        machineKey: RAW_MACHINE_ID,
        hostname: `ignore-raw-host-${crypto.randomUUID()}`,
      })
      const [row] = await db
        .select({ machineKey: server.machineKey, hostname: server.hostname })
        .from(server)
        .where(eq(server.id, serverId))
        .limit(1)
      assertEquals(row?.machineKey, validKey)
      assertEquals(row?.hostname?.startsWith('ignore-raw-host-'), true)
    } finally {
      await db.delete(server).where(eq(server.id, serverId))
    }
  })
})

test('resolveServerId rejects a second host once the license is latched', async () => {
  await withTestDb(async (db) => {
    const [org] = await db
      .insert(organization)
      .values({ displayName: 'One-Shot License Org' })
      .returning({ id: organization.id })

    const organizationId = org!.id
    const { licenseId, licenseToken } = await createLicense(db, {
      organizationId,
      displayName: 'One-Shot License',
    })

    const first = await resolveServerId(db, {
      hostname: `first-${crypto.randomUUID()}`,
      machineKey: randomMachineKey(),
      licenseId,
      licenseToken,
    })

    try {
      if (!first) {
        throw new Error('expected first enroll to create a server')
      }

      const second = await resolveServerId(db, {
        hostname: `second-${crypto.randomUUID()}`,
        machineKey: randomMachineKey(),
        licenseId,
        licenseToken,
      })
      assertEquals(second, null)

      const reenroll = await resolveServerId(db, {
        serverId: first,
        hostname: `first-again-${crypto.randomUUID()}`,
        machineKey: randomMachineKey(),
        licenseId,
        licenseToken,
      })
      assertEquals(reenroll, first)
    } finally {
      if (first) {
        await db.delete(server).where(eq(server.id, first))
      }
      await db.delete(organization).where(eq(organization.id, organizationId))
    }
  })
})
