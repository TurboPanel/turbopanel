/**
 * The gate query against a real database: it runs without a SQL error (a failed
 * gate silently opens every family, so a typo would pass unnoticed otherwise)
 * and the flags that matter turn on for the rows they guard. Needs a database.
 */
import { assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { portal, server, tls, tunnel } from '../../db/schema.ts'
import { withFolderFixtures } from '../../test-fixtures/folder-world.test.support.ts'
import { ALL_GATES_OPEN, loadCronGates } from './cron-gates.ts'

const test = Deno.test.bind(Deno)

test('the gate query runs on real Postgres and wakes the families that have a candidate', async () => {
  await withFolderFixtures(async (ctx) => {
    const errors: unknown[] = []
    const read = () => loadCronGates(ctx.db, { onError: (err) => errors.push(err) })

    const before = await read()
    assertEquals(errors, [])
    for (const key of Object.keys(ALL_GATES_OPEN)) {
      assertEquals(typeof before[key as keyof typeof before], 'boolean', key)
    }

    // A server that just connected: the reconnect-repair family wakes, urgently.
    await ctx.db
      .update(server)
      .set({ isConnected: true, statusChangedAt: new Date().toISOString() })
      .where(eq(server.id, ctx.serverId))
    const connected = await read()
    assertEquals(connected.connectedServer, true)
    assertEquals(connected.reconcileUrgent, true)

    // A new automatic order (no request yet, no key): the per-minute certificate sweep wakes.
    const [row] = await ctx.db
      .insert(tls)
      .values({
        organizationId: ctx.organizationId,
        source: 'lets_encrypt',
        status: 'automatic',
        metadata: { dnsNames: ['gate.example.net'] },
      })
      .returning({ id: tls.id })
    try {
      const ordering = await read()
      assertEquals(ordering.httpCertificates, true)
      assertEquals(ordering.httpCertificatesActive, true)
      assertEquals(errors, [])
    } finally {
      await ctx.db.delete(tls).where(eq(tls.id, row!.id))
    }
  })
})

test('tunnelsUrgent turns on for a removal or a rotation under way and off for a steady tunnel', async () => {
  await withFolderFixtures(async (ctx) => {
    const errors: unknown[] = []
    const read = () => loadCronGates(ctx.db, { onError: (err) => errors.push(err) })
    const [row] = await ctx.db
      .insert(tunnel)
      .values({
        organizationId: ctx.organizationId,
        routingOrganizationId: ctx.organizationId,
        name: 'gate-tunnel',
        provider: 'cloudflare',
        status: 'active',
      })
      .returning({ id: tunnel.id })
    try {
      const steady = await read()
      assertEquals([steady.tunnels, steady.tunnelsUrgent], [true, false])

      await ctx.db.update(tunnel).set({ status: 'removing' }).where(eq(tunnel.id, row!.id))
      assertEquals((await read()).tunnelsUrgent, true)

      await ctx.db
        .update(tunnel)
        .set({ status: 'active', metadata: { runTokenRotation: { phase: 'rolling' } } })
        .where(eq(tunnel.id, row!.id))
      assertEquals((await read()).tunnelsUrgent, true)

      await ctx.db
        .update(tunnel)
        .set({ metadata: { runTokenRotation: { phase: 'done' } } })
        .where(eq(tunnel.id, row!.id))
      assertEquals((await read()).tunnelsUrgent, false)

      const stopped = (retryable: boolean) => ({
        runTokenRotation: { phase: 'stopped', retryable },
      })
      await ctx.db
        .update(tunnel)
        .set({ metadata: stopped(true) })
        .where(eq(tunnel.id, row!.id))
      assertEquals((await read()).tunnelsUrgent, true)
      await ctx.db
        .update(tunnel)
        .set({ metadata: stopped(false) })
        .where(eq(tunnel.id, row!.id))
      assertEquals((await read()).tunnelsUrgent, false)

      // A portal under ten minutes old with no status answer; an answered one does not count.
      const [made] = await ctx.db
        .insert(portal)
        .values({ tunnelId: row!.id, serverId: ctx.serverId })
        .returning({ id: portal.id })
      try {
        assertEquals((await read()).tunnelsUrgent, true)
        await ctx.db
          .update(portal)
          .set({ lastSeenAt: new Date().toISOString() })
          .where(eq(portal.id, made!.id))
        assertEquals((await read()).tunnelsUrgent, false)
        await ctx.db
          .update(portal)
          .set({
            lastSeenAt: null,
            createdAt: new Date(Date.now() - 20 * 60_000).toISOString(),
          })
          .where(eq(portal.id, made!.id))
        assertEquals((await read()).tunnelsUrgent, false)
      } finally {
        await ctx.db.delete(portal).where(eq(portal.id, made!.id))
      }
      assertEquals(errors, [])
    } finally {
      await ctx.db.delete(tunnel).where(eq(tunnel.id, row!.id))
    }
  })
})
