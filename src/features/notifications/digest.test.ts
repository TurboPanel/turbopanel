/**
 * Digests and quiet hours against a real Postgres: what is held, what bypasses,
 * when a window releases, the zone and DST, and that nothing is sent twice.
 * The clock is injected everywhere (`now`), so the instants are fixed ones.
 * Skipped without TURBOPANEL_DATABASE_URL like every Postgres suite.
 */
import { assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { grant, notificationDelivery, organization, team, teammate, user } from '../../db/schema.ts'
import type { EmailJob, EmailQueue } from '../email/types.ts'
import { deriveEncryptionSecretsConfig, parseSecretsEnv } from '../../lib/secrets/secrets.ts'
import { generateSecret } from '../../lib/secrets/generate-secret.ts'
import { sendDueDigests } from './digest.ts'
import { type EmitEmail, emitNotification } from './emit.ts'
import {
  createNotificationChannel,
  listNotificationsForUser,
  type NotificationChannelRecord,
  replaceRulesForChannel,
  setChannelDisabled,
  setChannelHoldSettings,
} from './records.ts'
import type { NotificationEvent } from './events.ts'

const test = Deno.test.bind(Deno)
const dbUrl = getDatabaseUrl()

type Digest = Extract<EmailJob, { type: 'notification-digest' }>

type Ctx = {
  db: ReturnType<typeof createDenoDb>
  organizationId: string
  memberId: string
  email: EmitEmail
  jobs: EmailJob[]
  /** Make the next `enqueue` calls fail, this many times. */
  failEnqueue: { times: number }
  emit: (
    event: NotificationEvent,
    at: string,
    serverName?: string
  ) => ReturnType<typeof emitNotification>
  digest: (at: string) => ReturnType<typeof sendDueDigests>
  channel: (
    over?: Partial<NotificationChannelRecord> & {
      scope?: 'user' | 'organization'
    }
  ) => Promise<NotificationChannelRecord>
  statuses: (channelId: string) => Promise<string[]>
  /** Data-encryption secrets that seal chat and webhook addresses. */
  secrets: Awaited<ReturnType<typeof deriveEncryptionSecretsConfig>>
  /** Every POST the chat and webhook sends made. */
  posts: Array<{ url: string; body: Record<string, unknown>; headers: Headers }>
  chat: (
    kind: 'slack' | 'discord' | 'telegram' | 'webhook',
    address: string,
    over?: {
      digestCadence?: 'hourly'
      quiet?: typeof NIGHT
      signingSecret?: string
    }
  ) => Promise<NotificationChannelRecord>
  /** Emit with the secrets and the recording fetch, like the live sweep. */
  emitChat: (event: NotificationEvent, at: string) => ReturnType<typeof emitNotification>
  digestChat: (
    at: string,
    over?: { secrets?: Ctx['secrets'] | null }
  ) => ReturnType<typeof sendDueDigests>
}

const at = (iso: string) => Date.parse(iso)
const SERVER_ID = crypto.randomUUID()

async function withFixture(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping digest tests: TURBOPANEL_DATABASE_URL not set')
    return
  }
  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'Digest Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const [member] = await db
    .insert(user)
    .values({
      email: `digest-member-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
      role: 'user',
    })
    .returning({ id: user.id })
  const memberId = member!.id
  const [t] = await db
    .insert(team)
    .values({ name: 'Digest Team', organizationId })
    .returning({ id: team.id })
  await db.insert(teammate).values({ teamId: t!.id, userId: memberId })
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: memberId,
    permission: 'organization:manage',
  })
  const jobs: EmailJob[] = []
  const failEnqueue = { times: 0 }
  const queue: EmailQueue = {
    enqueue: (job) => {
      if (failEnqueue.times > 0) {
        failEnqueue.times -= 1
        return Promise.reject(new Error('queue down'))
      }
      jobs.push(job)
      return Promise.resolve()
    },
  }
  const email: EmitEmail = {
    queue,
    from: 'noreply@example.com',
    consoleBaseUrl: 'https://panel.example.com',
  }
  const secrets = await deriveEncryptionSecretsConfig(
    parseSecretsEnv(`1:${generateSecret()}`, 'deno'),
    'data-encryption'
  )
  const posts: Ctx['posts'] = []
  const fetchImpl = ((url: string, init: RequestInit) => {
    posts.push({
      url,
      body: JSON.parse(init.body as string),
      headers: new Headers(init.headers),
    })
    return Promise.resolve(new Response('ok', { status: 200 }))
  }) as unknown as typeof fetch
  const ctx: Ctx = {
    secrets,
    posts,
    chat: async (kind, address, over = {}) => {
      const c = await createNotificationChannel(db, secrets, {
        scope: 'organization',
        organizationId,
        userId: null,
        kind,
        label: `Digest ${kind}`,
        address,
        signingSecret: over.signingSecret,
      })
      await replaceRulesForChannel(db, c.id, [
        {
          event: '*',
          minSeverity: 'info',
        },
      ])
      if (over.digestCadence !== undefined || over.quiet !== undefined) {
        await setChannelHoldSettings(db, c.id, {
          digestCadence: over.digestCadence ?? null,
          quiet: over.quiet ?? null,
        })
      }
      return {
        ...c,
        digestCadence: over.digestCadence ?? null,
        quiet: over.quiet ?? null,
      }
    },
    emitChat: (event, when) =>
      emitNotification(
        db,
        secrets,
        {
          event,
          organizationId,
          context: { serverName: 'db-1' },
          targetType: 'server',
          targetId: SERVER_ID,
        },
        { email, now: () => at(when), fetchImpl }
      ),
    digestChat: (when, over = {}) =>
      sendDueDigests(db, {
        email,
        secrets: over.secrets === null ? undefined : (over.secrets ?? secrets),
        fetchImpl,
        now: () => at(when),
      }),
    db,
    organizationId,
    memberId,
    email,
    jobs,
    failEnqueue,
    emit: (event, when, serverName = 'db-1') =>
      emitNotification(
        db,
        undefined,
        {
          event,
          organizationId,
          context: { serverName },
          targetType: 'server',
          targetId: SERVER_ID,
        },
        { email, now: () => at(when) }
      ),
    digest: (when) => sendDueDigests(db, { email, now: () => at(when) }),
    channel: async (over = {}) => {
      const scope = over.scope ?? 'organization'
      const c = await createNotificationChannel(db, undefined, {
        scope,
        organizationId: scope === 'organization' ? organizationId : null,
        userId: scope === 'user' ? memberId : null,
        kind: 'email',
        label: 'Digest channel',
        address: `digest-${crypto.randomUUID()}@example.com`,
        verifiedAt: new Date().toISOString(),
      })
      await replaceRulesForChannel(db, c.id, [
        {
          event: '*',
          minSeverity: 'info',
        },
      ])
      if (over.digestCadence !== undefined || over.quiet !== undefined) {
        await setChannelHoldSettings(db, c.id, {
          digestCadence: over.digestCadence ?? null,
          quiet: over.quiet ?? null,
        })
      }
      return {
        ...c,
        digestCadence: over.digestCadence ?? null,
        quiet: over.quiet ?? null,
      }
    },
    statuses: async (channelId) =>
      (
        await db
          .select({ status: notificationDelivery.status })
          .from(notificationDelivery)
          .where(eq(notificationDelivery.channelId, channelId))
      )
        .map((r) => r.status)
        .toSorted(),
  }
  try {
    await fn(ctx)
  } finally {
    await db.delete(organization).where(eq(organization.id, organizationId))
    await db.delete(user).where(eq(user.id, memberId))
    await endDbConnection(db)
  }
}

const NIGHT = { startMinute: 22 * 60, endMinute: 7 * 60 }
const digests = (jobs: EmailJob[]) =>
  jobs.filter((j): j is Digest => j.type === 'notification-digest')

test('quiet hours hold a routine event, let urgent ones through, and deliver one summary at the end', async () => {
  await withFixture(async (x) => {
    const channel = await x.channel({ quiet: NIGHT })

    // 23:00 UTC: inside quiet hours. A routine event waits; an outage and a security change do not.
    const routine = await x.emit('server.deleted', '2026-07-01T23:00:00Z')
    assertEquals(routine.held, 1)
    assertEquals(routine.sent, 0)
    const outage = await x.emit('server.offline', '2026-07-01T23:05:00Z')
    assertEquals(outage.held, 0)
    assertEquals(outage.sent, 1)
    const security = await x.emit('access.grant_created', '2026-07-01T23:06:00Z')
    assertEquals(security.held, 0)
    assertEquals(security.sent, 1)
    assertEquals(
      x.jobs.map((j) => j.type),
      ['notification', 'notification']
    )

    // The bell is untouched by holding: the member has all three inbox rows.
    const inbox = await listNotificationsForUser(x.db, x.memberId)
    assertEquals(inbox.length, 3)

    // Still quiet at 03:00: nothing leaves.
    assertEquals((await x.digest('2026-07-02T03:00:00Z')).digests, 0)
    // 07:00 is the end: one summary with the held event.
    const done = await x.digest('2026-07-02T07:00:00Z')
    assertEquals(done, { channels: 1, digests: 1, events: 1 })
    const [job] = digests(x.jobs)
    assertEquals(job?.summary, 'quiet')
    assertEquals(job?.total, 1)
    assertEquals(job?.groups[0]?.event, 'server.deleted')
    assertEquals(
      job?.groups[0]?.items[0]?.url,
      `https://panel.example.com/${x.organizationId}/servers/${SERVER_ID}`
    )
    assertEquals(job?.consoleUrl, 'https://panel.example.com')
    assertEquals(await x.statuses(channel.id), ['sent', 'sent', 'sent'])

    // An event outside quiet hours is sent as it happens again.
    const awake = await x.emit('server.deleted', '2026-07-02T09:00:00Z')
    assertEquals(awake.sent, 1)
    assertEquals(awake.held, 0)
  })
})

test('a sweep that runs twice sends the window once, even concurrently', async () => {
  await withFixture(async (x) => {
    const channel = await x.channel({ quiet: NIGHT })
    await x.emit('server.deleted', '2026-07-01T23:00:00Z', 'a')
    await x.emit('server.deleted', '2026-07-01T23:30:00Z', 'b')
    const [one, two] = await Promise.all([
      x.digest('2026-07-02T07:30:00Z'),
      x.digest('2026-07-02T07:30:00Z'),
    ])
    assertEquals(one.events + two.events, 2)
    assertEquals(digests(x.jobs).length, 1)
    assertEquals(digests(x.jobs)[0]?.total, 2)
    assertEquals((await x.digest('2026-07-02T07:31:00Z')).digests, 0)
    assertEquals(digests(x.jobs).length, 1)
    assertEquals(await x.statuses(channel.id), ['sent', 'sent'])
  })
})

test('quiet hours are read in the owner zone, across the spring-forward night', async () => {
  await withFixture(async (x) => {
    await x.db.update(user).set({ timeZone: 'America/New_York' }).where(eq(user.id, x.memberId))
    const channel = await x.channel({ scope: 'user', quiet: NIGHT })
    // 06:30 EDT on the morning the clocks jumped (10:30 UTC): still quiet.
    const held = await x.emit('server.deleted', '2026-03-08T10:30:00Z')
    assertEquals(held.held, 1)
    assertEquals((await x.digest('2026-03-08T10:59:00Z')).digests, 0)
    // 07:00 EDT is 11:00 UTC (a fixed UTC-5 reading would still be quiet until 12:00 UTC).
    assertEquals((await x.digest('2026-03-08T11:00:00Z')).digests, 1)
    assertEquals(await x.statuses(channel.id), ['sent'])
    // The same wall time on a UTC channel is a different instant: 10:30 UTC is awake there.
    await x.db.update(user).set({ timeZone: null }).where(eq(user.id, x.memberId))
    const awake = await x.emit('server.deleted', '2026-03-08T10:30:00Z')
    assertEquals(awake.held, 0)
  })
})

test('quiet hours across the fall-back night end at the wall-clock hour', async () => {
  await withFixture(async (x) => {
    await x.db.update(user).set({ timeZone: 'America/New_York' }).where(eq(user.id, x.memberId))
    await x.channel({ scope: 'user', quiet: NIGHT })
    assertEquals((await x.emit('server.deleted', '2026-11-01T11:00:00Z')).held, 1)
    assertEquals((await x.digest('2026-11-01T11:59:00Z')).digests, 0)
    // 07:00 EST is 12:00 UTC.
    assertEquals((await x.digest('2026-11-01T12:00:00Z')).digests, 1)
  })
})

test('an hourly digest closes its window at the top of the hour and groups by event', async () => {
  await withFixture(async (x) => {
    const channel = await x.channel({ digestCadence: 'hourly' })
    for (let i = 0; i < 7; i++) {
      assertEquals((await x.emit('server.deleted', `2026-05-01T10:${10 + i}:00Z`, `s${i}`)).held, 1)
    }
    // Urgent events are never digested.
    assertEquals((await x.emit('server.offline', '2026-05-01T10:30:00Z')).sent, 1)
    // The 10:00 window had nothing in it and 11:00 has not come: nothing goes at 10:45.
    assertEquals((await x.digest('2026-05-01T10:45:00Z')).digests, 0)
    // Once 11:00 has passed the window closes: one email, capped to five items.
    assertEquals((await x.digest('2026-05-01T11:00:05Z')).digests, 1)
    const [job] = digests(x.jobs)
    assertEquals(job?.summary, 'hourly')
    assertEquals(job?.total, 7)
    assertEquals(job?.groups.length, 1)
    assertEquals(job?.groups[0]?.count, 7)
    assertEquals(job?.groups[0]?.items.length, 5)
    // An event after the close waits for the next window.
    await x.emit('server.deleted', '2026-05-01T11:10:00Z')
    assertEquals((await x.digest('2026-05-01T11:50:00Z')).digests, 0)
    assertEquals((await x.digest('2026-05-01T12:00:00Z')).digests, 1)
    assertEquals(digests(x.jobs).length, 2)
    assertEquals((await x.statuses(channel.id)).filter((s) => s === 'sent').length, 9)
  })
})

test('a daily digest with quiet hours holds until the 08:00 window, not the 07:00 end', async () => {
  await withFixture(async (x) => {
    await x.channel({ digestCadence: 'daily', quiet: NIGHT })
    await x.emit('server.deleted', '2026-05-01T23:00:00Z')
    // Quiet ended at 07:00 but the daily window has not closed.
    assertEquals((await x.digest('2026-05-02T07:30:00Z')).digests, 0)
    assertEquals((await x.digest('2026-05-02T08:00:00Z')).digests, 1)
    assertEquals(digests(x.jobs)[0]?.summary, 'daily')
  })
})

test('removing the settings flushes what was held', async () => {
  await withFixture(async (x) => {
    const channel = await x.channel({ digestCadence: 'daily' })
    await x.emit('server.deleted', '2026-05-01T10:00:00Z')
    assertEquals((await x.digest('2026-05-01T10:30:00Z')).digests, 0)
    await setChannelHoldSettings(x.db, channel.id, {
      digestCadence: null,
      quiet: null,
    })
    assertEquals((await x.digest('2026-05-01T10:31:00Z')).digests, 1)
    assertEquals(digests(x.jobs)[0]?.summary, 'quiet')
  })
})

test('a paused channel keeps its held events and receives them when it resumes', async () => {
  await withFixture(async (x) => {
    const channel = await x.channel({ digestCadence: 'hourly' })
    await x.emit('server.deleted', '2026-05-01T10:10:00Z')
    await setChannelDisabled(x.db, channel.id, true)
    // Paused: nothing is sent and the row stays put, even after the window closed.
    assertEquals((await x.digest('2026-05-01T11:05:00Z')).digests, 0)
    assertEquals(await x.statuses(channel.id), ['held'])
    // Events while paused are not routed to it at all.
    assertEquals((await x.emit('server.deleted', '2026-05-01T11:10:00Z')).deliveries, 0)
    await setChannelDisabled(x.db, channel.id, false)
    assertEquals((await x.digest('2026-05-01T11:15:00Z')).digests, 1)
    assertEquals(digests(x.jobs)[0]?.total, 1)
    assertEquals(await x.statuses(channel.id), ['sent'])
  })
})

test('a failed enqueue puts the rows back and the next sweep sends them', async () => {
  await withFixture(async (x) => {
    const channel = await x.channel({ quiet: NIGHT })
    await x.emit('server.deleted', '2026-07-01T23:00:00Z')
    x.failEnqueue.times = 1
    const failed = await x.digest('2026-07-02T07:10:00Z')
    assertEquals(failed.digests, 0)
    assertEquals(await x.statuses(channel.id), ['held'])
    assertEquals((await x.digest('2026-07-02T07:11:00Z')).digests, 1)
    assertEquals(await x.statuses(channel.id), ['sent'])
    assertEquals(digests(x.jobs).length, 1)
  })
})

test('a channel with neither setting is untouched: events send at once and never hold', async () => {
  await withFixture(async (x) => {
    const channel = await x.channel()
    const result = await x.emit('server.deleted', '2026-07-01T23:00:00Z')
    assertEquals(result.held, 0)
    assertEquals(result.sent, 1)
    assertEquals(await x.statuses(channel.id), ['sent'])
    assertEquals((await x.digest('2026-07-02T08:00:00Z')).channels, 0)
  })
})

test('quiet hours hold a routine event for each chat and webhook kind and one digest goes to each', async () => {
  await withFixture(async (x) => {
    const slack = await x.chat('slack', 'https://hooks.slack.example/a', {
      quiet: NIGHT,
    })
    const discord = await x.chat('discord', 'https://discord.example/b', {
      quiet: NIGHT,
    })
    const telegram = await x.chat('telegram', '123:abc/-100', { quiet: NIGHT })
    const hook = await x.chat('webhook', 'https://hook.example/c', {
      quiet: NIGHT,
      signingSecret: 'shh',
    })

    // Routine inside quiet hours: held everywhere, nothing posted. Urgent: sent at once to all four.
    assertEquals((await x.emitChat('server.deleted', '2026-07-01T23:00:00Z')).held, 4)
    assertEquals(x.posts.length, 0)
    assertEquals((await x.emitChat('server.offline', '2026-07-01T23:05:00Z')).held, 0)
    assertEquals(x.posts.length, 4)
    x.posts.length = 0

    assertEquals((await x.digestChat('2026-07-02T03:00:00Z')).digests, 0)
    const done = await x.digestChat('2026-07-02T07:00:00Z')
    assertEquals(done.digests, 4)
    assertEquals(done.events, 4)
    assertEquals(x.posts.length, 4)
    const by = (needle: string) => x.posts.find((p) => p.url.includes(needle))!
    assertEquals(Object.keys(by('hooks.slack.example').body), ['text'])
    assertEquals(Object.keys(by('discord.example').body), ['content'])
    assertEquals(by('api.telegram.org').body.chat_id, '-100')
    const body = by('hook.example').body
    assertEquals(body.type, 'digest')
    assertEquals(by('hook.example').headers.get('x-turbopanel-event'), 'digest')
    assertEquals(
      (by('hook.example').headers.get('x-turbopanel-signature') ?? '').startsWith('sha256='),
      true
    )
    for (const c of [slack, discord, telegram, hook]) {
      assertEquals((await x.statuses(c.id)).includes('held'), false)
    }
    // Sent once: a second sweep finds nothing.
    assertEquals((await x.digestChat('2026-07-02T07:01:00Z')).digests, 0)
  })
})

test('held chat digests wait for the secrets, however many ticks pass, then go out', async () => {
  await withFixture(async (x) => {
    const channel = await x.chat('slack', 'https://hooks.slack.example/a', {
      quiet: NIGHT,
    })
    await x.emitChat('server.deleted', '2026-07-01T23:00:00Z')
    for (let tick = 0; tick < 8; tick++) {
      const minute = String(tick).padStart(2, '0')
      const r = await x.digestChat(`2026-07-02T07:${minute}:00Z`, {
        secrets: null,
      })
      assertEquals(r.digests, 0)
    }
    // Still held, no attempt used up.
    assertEquals(await x.statuses(channel.id), ['held'])
    const [row] = await x.db
      .select({ attempts: notificationDelivery.attempts })
      .from(notificationDelivery)
      .where(eq(notificationDelivery.channelId, channel.id))
    assertEquals(row?.attempts, 0)
    assertEquals(x.posts.length, 0)
    assertEquals((await x.digestChat('2026-07-02T08:00:00Z')).digests, 1)
    assertEquals(await x.statuses(channel.id), ['sent'])
    assertEquals(x.posts.length, 1)
  })
})

test('a held email channel still sends without the secrets while chat waits', async () => {
  await withFixture(async (x) => {
    const mail = await x.channel({ quiet: NIGHT })
    const chat = await x.chat('slack', 'https://hooks.slack.example/a', {
      quiet: NIGHT,
    })
    await x.emitChat('server.deleted', '2026-07-01T23:00:00Z')
    const r = await x.digestChat('2026-07-02T07:00:00Z', { secrets: null })
    assertEquals(r.digests, 1)
    assertEquals(digests(x.jobs).length, 1)
    assertEquals(await x.statuses(mail.id), ['sent'])
    assertEquals(await x.statuses(chat.id), ['held'])
  })
})

test('a chat address that now fails the outbound URL rule is refused at send and put back', async () => {
  await withFixture(async (x) => {
    const channel = await x.chat('webhook', 'http://169.254.169.254/latest', {
      quiet: NIGHT,
    })
    await x.emitChat('server.deleted', '2026-07-01T23:00:00Z')
    const r = await sendDueDigests(x.db, {
      email: x.email,
      secrets: x.secrets,
      allowPrivateTargets: false,
      fetchImpl: (() => Promise.reject(new Error('must not be called'))) as unknown as typeof fetch,
      now: () => at('2026-07-02T07:00:00Z'),
    })
    assertEquals(r.digests, 0)
    assertEquals(await x.statuses(channel.id), ['held'])
  })
})

test('a push channel is never held, even with quiet hours set on it', async () => {
  await withFixture(async (x) => {
    const push = await createNotificationChannel(x.db, x.secrets, {
      scope: 'organization',
      organizationId: x.organizationId,
      userId: null,
      kind: 'push',
      label: 'Phone',
      address: 'ExponentPushToken[abc]',
    })
    await replaceRulesForChannel(x.db, push.id, [
      {
        event: '*',
        minSeverity: 'info',
      },
    ])
    await setChannelHoldSettings(x.db, push.id, {
      digestCadence: null,
      quiet: NIGHT,
    })
    const r = await x.emitChat('server.deleted', '2026-07-01T23:00:00Z')
    assertEquals(r.held, 0)
    assertEquals((await x.statuses(push.id)).includes('held'), false)
    assertEquals((await x.digestChat('2026-07-02T07:00:00Z')).channels, 0)
  })
})
