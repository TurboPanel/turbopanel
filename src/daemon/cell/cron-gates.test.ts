/**
 * The gate query against a real database: it runs without a SQL error (a failed
 * gate silently opens every family, so a typo would pass unnoticed otherwise)
 * and the flags that matter turn on for the rows they guard. Needs a database.
 */
import { assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import {
  command,
  environment,
  managed,
  notificationChannel,
  notificationDelivery,
  notificationEvent,
  portal,
  project,
  server,
  tls,
  tunnel,
} from '../../db/schema.ts'
import { ensureNotificationCatalog } from '../../features/notifications/fanout-records.ts'
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

test('the command and notification gates wait for a stale command and for a due retry', async () => {
  await withFolderFixtures(async (ctx) => {
    const errors: unknown[] = []
    const read = () => loadCronGates(ctx.db, { onError: (err) => errors.push(err) })
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

    // An open command: not a candidate until it is past the five minute grace.
    const [cmd] = await ctx.db
      .insert(command)
      .values({
        serverId: ctx.serverId,
        actorType: 'system',
        actorId: crypto.randomUUID(),
        name: 'gate.test',
        status: 'running',
      })
      .returning({ id: command.id })
    try {
      assertEquals((await read()).commandRecoveryWork, false)
      await ctx.db
        .update(command)
        .set({ updatedAt: minutesAgo(10) })
        .where(eq(command.id, cmd!.id))
      assertEquals((await read()).commandRecoveryWork, true)
    } finally {
      await ctx.db.delete(command).where(eq(command.id, cmd!.id))
    }

    await ensureNotificationCatalog(ctx.db)
    // A failed delivery waiting out its back-off, then due; a held one feeds the digest gate.
    const [channel] = await ctx.db
      .insert(notificationChannel)
      .values({
        scope: 'organization',
        organizationId: ctx.organizationId,
        kind: 'webhook',
        label: 'gate-channel',
        address: 'https://hooks.example.net/gate',
      })
      .returning({ id: notificationChannel.id })
    const [event] = await ctx.db
      .insert(notificationEvent)
      .values({
        organizationId: ctx.organizationId,
        topicCode: 'server.offline',
        severity: 'warning',
        fannedOutAt: new Date().toISOString(),
      })
      .returning({ id: notificationEvent.id })
    const [copy] = await ctx.db
      .insert(notificationDelivery)
      .values({
        organizationId: ctx.organizationId,
        channelId: channel!.id,
        eventId: event!.id,
        topicCode: 'server.offline',
        severity: 'warning',
        status: 'failed',
        nextAttemptAt: new Date(Date.now() + 25 * 60_000).toISOString(),
      })
      .returning({ id: notificationDelivery.id })
    try {
      const waiting = await read()
      assertEquals([waiting.notificationWork, waiting.notificationHeld], [false, false])
      await ctx.db
        .update(notificationDelivery)
        .set({ nextAttemptAt: minutesAgo(1) })
        .where(eq(notificationDelivery.id, copy!.id))
      assertEquals((await read()).notificationWork, true)
      await ctx.db
        .update(notificationDelivery)
        .set({ status: 'held', nextAttemptAt: null })
        .where(eq(notificationDelivery.id, copy!.id))
      const held = await read()
      assertEquals([held.notificationWork, held.notificationHeld], [false, true])
      assertEquals(errors, [])
    } finally {
      await ctx.db.delete(notificationDelivery).where(eq(notificationDelivery.id, copy!.id))
      await ctx.db.delete(notificationEvent).where(eq(notificationEvent.id, event!.id))
      await ctx.db.delete(notificationChannel).where(eq(notificationChannel.id, channel!.id))
    }
  })
})

test('the notification gate holds an unfanned event until the sweep grace and drops it past the max age', async () => {
  await withFolderFixtures(async (ctx) => {
    const errors: unknown[] = []
    const read = () => loadCronGates(ctx.db, { onError: (err) => errors.push(err) })
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

    await ensureNotificationCatalog(ctx.db)
    const [event] = await ctx.db
      .insert(notificationEvent)
      .values({
        organizationId: ctx.organizationId,
        topicCode: 'server.offline',
        severity: 'warning',
        createdAt: minutesAgo(1),
      })
      .returning({ id: notificationEvent.id })
    try {
      // Younger than the grace: the inline fan-out may still be running.
      assertEquals((await read()).notificationWork, false)
      await ctx.db
        .update(notificationEvent)
        .set({ createdAt: minutesAgo(10) })
        .where(eq(notificationEvent.id, event!.id))
      assertEquals((await read()).notificationWork, true)
      // Older than the sweep's max age: the sweep no longer picks it up.
      await ctx.db
        .update(notificationEvent)
        .set({ createdAt: minutesAgo(25 * 60) })
        .where(eq(notificationEvent.id, event!.id))
      assertEquals((await read()).notificationWork, false)
      assertEquals(errors, [])
    } finally {
      await ctx.db.delete(notificationEvent).where(eq(notificationEvent.id, event!.id))
    }
  })
})

test('the command gate waits for a managed row applying past the stale grace', async () => {
  await withFolderFixtures(async (ctx) => {
    const errors: unknown[] = []
    const read = () => loadCronGates(ctx.db, { onError: (err) => errors.push(err) })
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

    const [proj] = await ctx.db
      .insert(project)
      .values({
        organizationId: ctx.organizationId,
        workspaceId: ctx.workspaceId,
        name: 'gate-project',
      })
      .returning({ id: project.id })
    const [env] = await ctx.db
      .insert(environment)
      .values({ projectId: proj!.id, name: 'gate-env' })
      .returning({ id: environment.id })
    const [row] = await ctx.db
      .insert(managed)
      .values({
        environmentId: env!.id,
        serverId: ctx.serverId,
        engine: 'postgres',
        status: 'applying',
      })
      .returning({ id: managed.id })
    try {
      assertEquals((await read()).commandRecoveryWork, false)
      await ctx.db
        .update(managed)
        .set({ updatedAt: minutesAgo(10) })
        .where(eq(managed.id, row!.id))
      assertEquals((await read()).commandRecoveryWork, true)
      assertEquals(errors, [])
    } finally {
      await ctx.db.delete(managed).where(eq(managed.id, row!.id))
      await ctx.db.delete(environment).where(eq(environment.id, env!.id))
      await ctx.db.delete(project).where(eq(project.id, proj!.id))
    }
  })
})

test('the notification gates ignore a due delivery on an unverified email channel', async () => {
  await withFolderFixtures(async (ctx) => {
    const errors: unknown[] = []
    const read = () => loadCronGates(ctx.db, { onError: (err) => errors.push(err) })

    await ensureNotificationCatalog(ctx.db)
    const [channel] = await ctx.db
      .insert(notificationChannel)
      .values({
        scope: 'organization',
        organizationId: ctx.organizationId,
        kind: 'email',
        label: 'gate-mail',
        address: 'ops@example.net',
      })
      .returning({ id: notificationChannel.id })
    const [event] = await ctx.db
      .insert(notificationEvent)
      .values({
        organizationId: ctx.organizationId,
        topicCode: 'server.offline',
        severity: 'warning',
        fannedOutAt: new Date().toISOString(),
      })
      .returning({ id: notificationEvent.id })
    const [copy] = await ctx.db
      .insert(notificationDelivery)
      .values({
        organizationId: ctx.organizationId,
        channelId: channel!.id,
        eventId: event!.id,
        topicCode: 'server.offline',
        severity: 'warning',
        status: 'failed',
        nextAttemptAt: new Date(Date.now() - 60_000).toISOString(),
      })
      .returning({ id: notificationDelivery.id })
    try {
      // The claim queries never pick this row, so it must not keep the gate open.
      const unverified = await read()
      assertEquals([unverified.notificationWork, unverified.notificationHeld], [false, false])
      await ctx.db
        .update(notificationChannel)
        .set({ verifiedAt: new Date().toISOString() })
        .where(eq(notificationChannel.id, channel!.id))
      assertEquals((await read()).notificationWork, true)
      assertEquals(errors, [])
    } finally {
      await ctx.db.delete(notificationDelivery).where(eq(notificationDelivery.id, copy!.id))
      await ctx.db.delete(notificationEvent).where(eq(notificationEvent.id, event!.id))
      await ctx.db.delete(notificationChannel).where(eq(notificationChannel.id, channel!.id))
    }
  })
})
