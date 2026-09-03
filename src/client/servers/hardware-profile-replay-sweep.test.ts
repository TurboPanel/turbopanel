import { assertEquals, assertExists } from '@std/assert'
import { eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import { organization, server } from '../../lib/db/schema.ts'
import type {
  DaemonCell,
  DaemonCellRegistry,
  DaemonCellSnapshot,
  PendingRequestRecord,
} from '../../daemon/cell/contracts.ts'
import type { DaemonOutboundEnvelope } from '../../daemon/cell/protocol.ts'
import { runHardwareProfileReplaySweep } from './hardware-profile-replay-sweep.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

type RecordedEnqueue = {
  serverId: string
  envelope: DaemonOutboundEnvelope
}

/** Minimal `DaemonCellRegistry` fake — only `getCell(...).enqueue(...)` is exercised. */
function createFakeRegistry(
  opts: { failFor?: Set<string> } = {},
): DaemonCellRegistry & { calls: RecordedEnqueue[] } {
  const calls: RecordedEnqueue[] = []
  return {
    calls,
    getCell(serverId: string): DaemonCell {
      return {
        enqueue: (
          envelope: DaemonOutboundEnvelope,
        ): Promise<PendingRequestRecord> => {
          if (opts.failFor?.has(serverId)) {
            return Promise.reject(new Error('cell unavailable'))
          }
          calls.push({ serverId, envelope })
          return Promise.resolve({
            serverId,
            requestId: envelope.requestId,
            requestKind: envelope.kind,
            status: 'queued',
            createdAt: new Date().toISOString(),
            expiresAt: new Date().toISOString(),
          })
        },
      } as unknown as DaemonCell
    },
    listOnlineServerIds(): Promise<string[]> {
      return Promise.resolve([])
    },
    getSnapshots(): Promise<Map<string, DaemonCellSnapshot>> {
      return Promise.resolve(new Map())
    },
    purge(): Promise<void> {
      return Promise.resolve()
    },
  }
}

async function withServerFixture(
  options: Readonly<{
    connected?: boolean
    statusChangedAt?: string
    metadata?: Record<string, unknown>
  }>,
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    serverId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn(
      'Skipping hardware profile replay sweep tests: TURBOPANEL_DATABASE_URL not set',
    )
    return
  }

  const db = createDenoDb()
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Hardware Profile Replay Sweep Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      name: 'Hardware Profile Replay Sweep Server',
      isConnected: options.connected ?? true,
      statusChangedAt: options.statusChangedAt ?? now,
      metadata: options.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  try {
    await fn({ db, serverId })
  } finally {
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

test('runHardwareProfileReplaySweep enqueues for a recently reconnected server with a saved profile', async () => {
  await withServerFixture(
    { metadata: { hardwareProfile: { hostingPath: '/data', drivetempEnabled: true } } },
    async ({ db, serverId }) => {
      const registry = createFakeRegistry()
      const result = await runHardwareProfileReplaySweep(db, registry)
      assertEquals(result.enqueued, 1)
      assertEquals(registry.calls.length, 1)
      assertEquals(registry.calls[0]?.serverId, serverId)
      assertEquals(registry.calls[0]?.envelope.kind, 'metrics-sensor-overrides-update')
      assertEquals(
        (registry.calls[0]?.envelope as { overrides?: unknown }).overrides,
        { hostingPath: '/data', drivetempEnabled: true },
      )

      const rows = await db
        .select({ metadata: server.metadata })
        .from(server)
        .where(eq(server.id, serverId))
      const metadata = rows[0]?.metadata as Record<string, unknown>
      assertExists(metadata.hardwareProfileReplayedAt)
    },
  )
})

test('runHardwareProfileReplaySweep skips a server with no saved hardware profile', async () => {
  await withServerFixture({}, async ({ db }) => {
    const registry = createFakeRegistry()
    const result = await runHardwareProfileReplaySweep(db, registry)
    assertEquals(result.enqueued, 0)
    assertEquals(registry.calls.length, 0)
  })
})

test('runHardwareProfileReplaySweep skips a disconnected server even with a saved profile', async () => {
  await withServerFixture(
    {
      connected: false,
      metadata: { hardwareProfile: { hostingPath: '/data' } },
    },
    async ({ db }) => {
      const registry = createFakeRegistry()
      const result = await runHardwareProfileReplaySweep(db, registry)
      assertEquals(result.enqueued, 0)
      assertEquals(registry.calls.length, 0)
    },
  )
})

test('runHardwareProfileReplaySweep does not re-enqueue a server already replayed for its current connection', async () => {
  await withServerFixture(
    { metadata: { hardwareProfile: { hostingPath: '/data' } } },
    async ({ db }) => {
      const first = createFakeRegistry()
      const firstResult = await runHardwareProfileReplaySweep(db, first)
      assertEquals(firstResult.enqueued, 1)

      // Simulates the server having been online for a while: the sweep runs
      // again (e.g. next tick) without a new reconnect (status_changed_at
      // unchanged) — the marker stamped above must suppress a repeat push.
      const second = createFakeRegistry()
      const secondResult = await runHardwareProfileReplaySweep(db, second)
      assertEquals(secondResult.enqueued, 0)
      assertEquals(second.calls.length, 0)
    },
  )
})

test('runHardwareProfileReplaySweep replays again after a fresh reconnect bumps status_changed_at', async () => {
  await withServerFixture(
    { metadata: { hardwareProfile: { hostingPath: '/data' } } },
    async ({ db, serverId }) => {
      const first = createFakeRegistry()
      const firstResult = await runHardwareProfileReplaySweep(db, first)
      assertEquals(firstResult.enqueued, 1)

      // A new reconnect bumps status_changed_at past the stamped marker.
      await db
        .update(server)
        .set({ statusChangedAt: new Date(Date.now() + 1_000).toISOString() })
        .where(eq(server.id, serverId))

      const second = createFakeRegistry()
      const secondResult = await runHardwareProfileReplaySweep(db, second)
      assertEquals(secondResult.enqueued, 1)
      assertEquals(second.calls.length, 1)
    },
  )
})

test('runHardwareProfileReplaySweep swallows an enqueue failure and leaves the server eligible for retry', async () => {
  await withServerFixture(
    { metadata: { hardwareProfile: { hostingPath: '/data' } } },
    async ({ db, serverId }) => {
      const failing = createFakeRegistry({ failFor: new Set([serverId]) })
      const result = await runHardwareProfileReplaySweep(db, failing)
      assertEquals(result.enqueued, 0)
      assertEquals(failing.calls.length, 0)

      const rows = await db
        .select({ metadata: server.metadata })
        .from(server)
        .where(eq(server.id, serverId))
      const metadata = rows[0]?.metadata as Record<string, unknown>
      assertEquals(metadata.hardwareProfileReplayedAt, undefined)

      // No marker was stamped, so a later tick against a healthy registry retries.
      const healthy = createFakeRegistry()
      const retryResult = await runHardwareProfileReplaySweep(db, healthy)
      assertEquals(retryResult.enqueued, 1)
    },
  )
})
