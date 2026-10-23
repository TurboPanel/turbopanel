import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb } from '../../db/connection.ts'
import { createLicense, revokeLicense } from '../licenses/license.ts'
import {
  container,
  environment,
  license,
  organization,
  payer,
  project,
  server,
  service,
  subscription,
  subscriptionItem,
  tier,
  workspace,
} from '../../db/schema.ts'
import { getTierByLabel, insertTier } from '../tiers/tier-records.ts'
import { getServerLicenseBinding, resolveServerId, touchServerMetadata } from './server-registry.ts'

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
    skipWithoutDatabase('server-registry tests')
    return
  }
  const db = createDenoDb()
  await fn(db)
}

/** Tear down ensureSystemHierarchy rows before revoke/delete of a licensed server. */
async function deleteOrganizationServerTree(
  db: ReturnType<typeof createDenoDb>,
  organizationId: string,
  serverId: string
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
  await db.update(license).set({ serverId: null }).where(eq(license.serverId, serverId))
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
      .values({ name: 'Server Registry Test Org' })
      .returning({ id: organization.id })

    const organizationId = org!.id
    const { licenseId, licenseToken } = await createLicense(db, {
      organizationId,
      name: 'Server Registry Test License',
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

const GIB = 1024 ** 3

/** The instance's tier row for `label`, created (and recorded for cleanup) only when missing. */
async function ensureTier(
  db: ReturnType<typeof createDenoDb>,
  label: string,
  created: string[]
): Promise<string> {
  const existing = await getTierByLabel(db, label)
  if (existing) return existing.id
  const row = await insertTier(db, {
    label,
    providerProductId: `prod_registry_${label.toLowerCase()}`,
    priceCents: null,
    currency: null,
  })
  created.push(row.id)
  return row.id
}

test('a hello reporting bigger or smaller hardware never changes the license tier a manager assigned', async () => {
  await withTestDb(async (db) => {
    const now = new Date().toISOString()
    const createdTiers: string[] = []
    const [org] = await db
      .insert(organization)
      .values({ name: 'Hello Keeps Tier Org' })
      .returning({ id: organization.id })
    const organizationId = org!.id
    const s1 = await ensureTier(db, 'S1', createdTiers)
    const s5 = await ensureTier(db, 'S5', createdTiers)
    const [payerRow] = await db
      .insert(payer)
      .values({
        organizationId,
        provider: 'stripe',
        providerCustomerId: `cus_registry_${crypto.randomUUID()}`,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: payer.id })
    const [subRow] = await db
      .insert(subscription)
      .values({
        payerId: payerRow!.id,
        providerSubscriptionId: `sub_registry_${crypto.randomUUID()}`,
        status: 'active',
        providerStatus: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: subscription.id })
    // A spare seat on each tier: a free S5 for the box that grows, a free S1
    // for the box that shrinks. Neither may be taken on the server's behalf.
    for (const [tierId, quantity] of [
      [s1, 2],
      [s5, 2],
    ] as const) {
      await db.insert(subscriptionItem).values({
        subscriptionId: subRow!.id,
        tierId,
        providerItemId: `si_registry_${crypto.randomUUID()}`,
        providerPriceId: `price_registry_${crypto.randomUUID()}`,
        quantity,
        createdAt: now,
        updatedAt: now,
      })
    }

    const makeServer = async (assignedTierId: string | null) => {
      const [row] = await db
        .insert(server)
        .values({
          createdAt: now,
          updatedAt: now,
          organizationId,
          hostname: `keeps-tier-${crypto.randomUUID()}`,
          assignedTierId,
        })
        .returning({ id: server.id })
      const { licenseId } = await createLicense(db, { organizationId, name: 'Keeps Tier' })
      await db
        .update(license)
        .set({ serverId: row!.id, updatedAt: now })
        .where(eq(license.id, licenseId))
      return row!.id
    }
    const readTier = async (serverId: string) => {
      const [row] = await db
        .select({ assignedTierId: server.assignedTierId })
        .from(server)
        .where(eq(server.id, serverId))
        .limit(1)
      return row?.assignedTierId ?? null
    }
    const hello = (serverId: string, cores: number, memoryGib: number) =>
      touchServerMetadata(db, serverId, {
        hostname: `keeps-tier-host-${crypto.randomUUID()}`,
        resources: {
          cpus: [{ cores: { total: cores } }],
          memory: { totalBytes: memoryGib * GIB },
        },
      } as Parameters<typeof touchServerMetadata>[2])

    const keptSmall = await makeServer(s1)
    const keptBig = await makeServer(s5)
    const unassigned = await makeServer(null)
    try {
      // Kept on S1 by its managers while it measures far past S1: stays S1.
      await hello(keptSmall, 64, 256)
      const [grown] = await db
        .select({ metadata: server.metadata })
        .from(server)
        .where(eq(server.id, keptSmall))
        .limit(1)
      const stored = grown?.metadata as { resources?: { memory?: { totalBytes?: number } } }
      // The report landed (so the old recompute would have run) ...
      assertEquals(stored?.resources?.memory?.totalBytes, 256 * GIB)
      // ... and the tier did not move.
      assertEquals(await readTier(keptSmall), s1)
      // Shrunk well below S5: keeps its S5, no move down onto the spare S1.
      await hello(keptBig, 1, 1)
      assertEquals(await readTier(keptBig), s5)
      // Licensed but never assigned: a hello does not hand it a free seat.
      await hello(unassigned, 2, 4)
      assertEquals(await readTier(unassigned), null)
      // And the other servers did not move either.
      assertEquals(await readTier(keptSmall), s1)
      assertEquals(await readTier(keptBig), s5)
    } finally {
      await db.delete(license).where(eq(license.organizationId, organizationId))
      await db.delete(server).where(eq(server.organizationId, organizationId))
      await db.delete(subscriptionItem).where(eq(subscriptionItem.subscriptionId, subRow!.id))
      await db.delete(subscription).where(eq(subscription.id, subRow!.id))
      await db.delete(payer).where(eq(payer.id, payerRow!.id))
      for (const id of createdTiers) await db.delete(tier).where(eq(tier.id, id))
      await db.delete(organization).where(eq(organization.id, organizationId))
    }
  })
})

test('getServerLicenseBinding prefers an active bound license', async () => {
  await withTestDb(async (db) => {
    const now = new Date().toISOString()
    const [org] = await db
      .insert(organization)
      .values({ name: 'Active Binding Org' })
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
      name: 'Active Bound',
    })
    await db.update(license).set({ serverId, updatedAt: now }).where(eq(license.id, licenseId))

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
      .values({ name: 'Revoked Binding Org' })
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
      name: 'Revoked Bound',
    })
    await db.update(license).set({ serverId, updatedAt: now }).where(eq(license.id, licenseId))
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
      .values({ name: 'One-Shot License Org' })
      .returning({ id: organization.id })

    const organizationId = org!.id
    const { licenseId, licenseToken } = await createLicense(db, {
      organizationId,
      name: 'One-Shot License',
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

test('touchServerMetadata merges a capacity heartbeat without dropping hello-only fields', async () => {
  await withTestDb(async (db) => {
    const MIB = 1024 * 1024
    const now = new Date().toISOString()
    const [inserted] = await db
      .insert(server)
      .values({
        createdAt: now,
        updatedAt: now,
        hostname: `capacity-${crypto.randomUUID()}`,
        machineKey: randomMachineKey(),
      })
      .returning({ id: server.id })
    const serverId = inserted!.id
    const gpus = [{ vendorId: '0x10de', name: 'Fixture GPU' }]
    const ips = [{ address: '10.0.0.9', version: 4 as const, scope: 'private' as const }]
    try {
      await touchServerMetadata(db, serverId, {
        resources: {
          cpus: [{ cores: { total: 2 }, threads: { total: 2 } }],
          gpus,
          memory: {
            totalBytes: 372 * MIB,
            pageSizeBytes: 4096,
            presentBytes: 2048 * MIB,
            blockSizeBytes: 128 * MIB,
          },
          swap: { totalBytes: 0 },
          ips,
          dynamicMemory: { driver: 'hv_balloon', totalMoved: 0 },
        },
        features: [],
      })
      // Heartbeat: memory, swap and cpus only.
      await touchServerMetadata(db, serverId, {
        resources: {
          memory: { totalBytes: 1900 * MIB, presentBytes: 2048 * MIB, blockSizeBytes: 128 * MIB },
          swap: { totalBytes: 0 },
          cpus: [{ cores: { total: 2 }, threads: { total: 2 } }],
          dynamicMemory: { driver: 'hv_balloon', totalMoved: 1528 * MIB },
        },
      })
      const [row] = await db
        .select({ metadata: server.metadata })
        .from(server)
        .where(eq(server.id, serverId))
        .limit(1)
      const resources = (row?.metadata as { resources?: Record<string, unknown> } | null)?.resources
      assertEquals(resources?.gpus, gpus)
      assertEquals(resources?.ips, ips)
      assertEquals(resources?.memory, {
        totalBytes: 1900 * MIB,
        pageSizeBytes: 4096,
        presentBytes: 2048 * MIB,
        blockSizeBytes: 128 * MIB,
      })
      assertEquals(resources?.dynamicMemory, { driver: 'hv_balloon', totalMoved: 1528 * MIB })
    } finally {
      await db.delete(server).where(eq(server.id, serverId))
    }
  })
})
