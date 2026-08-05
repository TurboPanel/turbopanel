import { assertEquals } from 'jsr:@std/assert'
import { eq } from 'drizzle-orm'
import { getDatabaseUrl } from './db-url.ts'
import { createDenoDb } from './db.ts'
import { createLicense, revokeLicense } from './client/authn/license.ts'
import {
  container,
  environment,
  license,
  organization,
  project,
  server,
  service,
  workspace,
} from './lib/db/schema.ts'
import {
  getServerLicenseBinding,
  resolveServerId,
  touchServerMetadata,
} from './server-registry.ts'

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

/** Tear down ensureSystemHierarchy rows before revoke/delete of a licensed server. */
async function deleteOrganizationServerTree(
  db: ReturnType<typeof createDenoDb>,
  organizationId: string,
  serverId: string,
): Promise<void> {
  const workspaceRows = await db
    .select({ id: workspace.id })
    .from(workspace)
    .where(eq(workspace.organizationId, organizationId))
  for (const ws of workspaceRows) {
    const projectRows = await db
      .select({ id: project.id })
      .from(project)
      .where(eq(project.workspaceId, ws.id))
    for (const p of projectRows) {
      const envRows = await db
        .select({ id: environment.id })
        .from(environment)
        .where(eq(environment.projectId, p.id))
      for (const env of envRows) {
        const serviceRows = await db
          .select({ id: service.id })
          .from(service)
          .where(eq(service.environmentId, env.id))
        for (const svc of serviceRows) {
          await db.delete(container).where(eq(container.serviceId, svc.id))
        }
        await db.delete(service).where(eq(service.environmentId, env.id))
        await db.delete(environment).where(eq(environment.id, env.id))
      }
      await db.delete(project).where(eq(project.id, p.id))
    }
    await db.delete(workspace).where(eq(workspace.id, ws.id))
  }
  await db.delete(container).where(eq(container.serverId, serverId))
  await db
    .update(license)
    .set({ serverId: null })
    .where(eq(license.serverId, serverId))
  await db.delete(server).where(eq(server.id, serverId))
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
        await deleteOrganizationServerTree(db, organizationId, resolved)
      }
      await db.delete(license).where(eq(license.organizationId, organizationId))
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

test('getServerLicenseBinding prefers an active bound license', async () => {
  await withTestDb(async (db) => {
    const now = new Date().toISOString()
    const [org] = await db
      .insert(organization)
      .values({ displayName: 'Active Binding Org' })
      .returning({ id: organization.id })
    const organizationId = org!.id

    const [insertedServer] = await db
      .insert(server)
      .values({
        createdAt: now,
        updatedAt: now,
        organizationId,
        hostname: `active-bind-${crypto.randomUUID()}`,
      })
      .returning({ id: server.id })
    const serverId = insertedServer!.id

    const { licenseId } = await createLicense(db, {
      organizationId,
      displayName: 'Active Bound',
    })
    await db
      .update(license)
      .set({ serverId, updatedAt: now })
      .where(eq(license.id, licenseId))

    try {
      const binding = await getServerLicenseBinding(db, serverId)
      assertEquals(binding?.licenseId, licenseId)
      assertEquals(binding?.organizationId, organizationId)
    } finally {
      await db.delete(license).where(eq(license.id, licenseId))
      await db.delete(server).where(eq(server.id, serverId))
      await db.delete(organization).where(eq(organization.id, organizationId))
    }
  })
})

test('getServerLicenseBinding surfaces a revoked-only latch for fail-closed checks', async () => {
  await withTestDb(async (db) => {
    const now = new Date().toISOString()
    const [org] = await db
      .insert(organization)
      .values({ displayName: 'Revoked Binding Org' })
      .returning({ id: organization.id })
    const organizationId = org!.id

    const [insertedServer] = await db
      .insert(server)
      .values({
        createdAt: now,
        updatedAt: now,
        organizationId,
        hostname: `revoked-bind-${crypto.randomUUID()}`,
      })
      .returning({ id: server.id })
    const serverId = insertedServer!.id

    const { licenseId } = await createLicense(db, {
      organizationId,
      displayName: 'Revoked Bound',
    })
    await db
      .update(license)
      .set({ serverId, updatedAt: now })
      .where(eq(license.id, licenseId))
    await revokeLicense(db, licenseId, organizationId)

    try {
      const binding = await getServerLicenseBinding(db, serverId)
      assertEquals(binding?.licenseId, licenseId)
      assertEquals(binding?.organizationId, organizationId)
    } finally {
      await db.delete(license).where(eq(license.id, licenseId))
      await db.delete(server).where(eq(server.id, serverId))
      await db.delete(organization).where(eq(organization.id, organizationId))
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
        await deleteOrganizationServerTree(db, organizationId, first)
      }
      await db.delete(license).where(eq(license.organizationId, organizationId))
      await db.delete(organization).where(eq(organization.id, organizationId))
    }
  })
})
