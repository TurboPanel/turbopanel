/**
 * Delivery behaviour against a real Postgres and a real HTTP receiver on
 * loopback (channel addresses must be https, so the transport rewrites the
 * scheme and host to the receiver and keeps the request untouched): a webhook is signed so a receiver can verify
 * it and is retried after a 5xx, the rules matrix decides what arrives, a
 * paused channel receives nothing until it resumes, and a stale server's
 * alert reaches every routed channel exactly once. Skipped without
 * TURBOPANEL_DATABASE_URL like every Postgres suite.
 */
import { assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { deriveEncryptionSecretsConfig, parseSecretsEnv } from '../../lib/secrets/secrets.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'
import {
  notificationDelivery,
  organization,
  server,
  team,
  teammate,
  user,
} from '../../db/schema.ts'
import { resolveAlertSender } from '../alerts/resolve-alert-sender.ts'
import { emitNotification, retryDueDeliveries } from './emit.ts'
import {
  createNotificationChannel,
  listNotificationsForUser,
  replaceRulesForChannel,
  setChannelDisabled,
} from './records.ts'

const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

type Received = { path: string; headers: Headers; body: string }

type Receiver = {
  /** The https address a channel stores for this path. */
  url: (path: string) => string
  /** Sends the request to the loopback receiver, headers and body as given. */
  deps: { allowPrivateTargets: boolean; fetchImpl: typeof fetch }
  received: Received[]
  /** Statuses to answer with, in order; 200 once the list is spent. */
  answers: number[]
  close: () => Promise<void>
}

function startReceiver(): Receiver {
  const received: Received[] = []
  const answers: number[] = []
  const srv = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async (req) => {
    received.push({
      path: new URL(req.url).pathname,
      headers: req.headers,
      body: await req.text(),
    })
    return new Response('', { status: answers.shift() ?? 200 })
  })
  const port = (srv.addr as Deno.NetAddr).port
  const loopback = ((input: string | URL | Request, init?: RequestInit) => {
    const target = new URL(String(input))
    return fetch(`http://127.0.0.1:${port}${target.pathname}`, init)
  }) as typeof fetch
  return {
    url: (path) => `https://hooks.example.com${path}`,
    deps: { allowPrivateTargets: true, fetchImpl: loopback },
    received,
    answers,
    close: () => srv.shutdown(),
  }
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('')
}

async function secrets() {
  return await deriveEncryptionSecretsConfig(
    parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno'),
    'data-encryption'
  )
}

async function withFixture(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    receiver: Receiver
    organizationId: string
    memberId: string
  }) => Promise<void>
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping delivery behaviour tests: TURBOPANEL_DATABASE_URL not set')
    return
  }
  const db = createDenoDb()
  const receiver = startReceiver()
  const [org] = await db
    .insert(organization)
    .values({ name: 'Delivery Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const [member] = await db
    .insert(user)
    .values({
      email: `delivery-member-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
      role: 'user',
    })
    .returning({ id: user.id })
  const [t] = await db
    .insert(team)
    .values({ name: 'Delivery Team', organizationId })
    .returning({ id: team.id })
  await db.insert(teammate).values({ teamId: t!.id, userId: member!.id })
  try {
    await fn({ db, receiver, organizationId, memberId: member!.id })
  } finally {
    await receiver.close()
    await db.delete(organization).where(eq(organization.id, organizationId))
    await db.delete(user).where(eq(user.id, member!.id))
    await endDbConnection(db)
  }
}

test('a webhook is signed so the receiver can verify it, and a 5xx is retried', async () => {
  await withFixture(async ({ db, receiver, organizationId }) => {
    const enc = await secrets()
    const signingSecret = crypto.randomUUID()
    const channel = await createNotificationChannel(db, enc, {
      scope: 'organization',
      organizationId,
      kind: 'webhook',
      label: 'Receiver',
      address: receiver.url('/hook'),
      signingSecret,
    })
    await replaceRulesForChannel(db, channel.id, [{ event: '*', minSeverity: 'info' }])

    receiver.answers.push(503)
    const first = await emitNotification(
      db,
      enc,
      { event: 'server.offline', organizationId, context: { serverName: 'db-1' } },
      receiver.deps
    )
    assertEquals(first.failed, 1)
    assertEquals(receiver.received.length, 1)
    const req = receiver.received[0]!
    assertEquals(req.headers.get('x-turbopanel-event'), 'server.offline')
    // Verified the way a receiver would: HMAC-SHA256 of the raw body under the shared secret.
    assertEquals(
      req.headers.get('x-turbopanel-signature'),
      `sha256=${await hmacHex(signingSecret, req.body)}`
    )
    assertEquals(JSON.parse(req.body).title, 'Server db-1 went offline')
    assertEquals(req.body.includes(signingSecret), false)

    // The 5xx left a failed ledger row; once its retry time arrives the sweep resends and it lands.
    await db
      .update(notificationDelivery)
      .set({ nextAttemptAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(notificationDelivery.channelId, channel.id))
    const swept = await retryDueDeliveries(db, enc, receiver.deps)
    assertEquals(swept.sent, 1)
    assertEquals(receiver.received.length, 2)
    const retried = receiver.received[1]!
    assertEquals(
      retried.headers.get('x-turbopanel-signature'),
      `sha256=${await hmacHex(signingSecret, retried.body)}`
    )
    const [row] = await db
      .select({ status: notificationDelivery.status, attempts: notificationDelivery.attempts })
      .from(notificationDelivery)
      .where(eq(notificationDelivery.channelId, channel.id))
    assertEquals(row, { status: 'sent', attempts: 2 })
  })
})

test('changing a channel’s rules changes what reaches it and nothing else', async () => {
  await withFixture(async ({ db, receiver, organizationId }) => {
    const enc = await secrets()
    const picky = await createNotificationChannel(db, enc, {
      scope: 'organization',
      organizationId,
      kind: 'webhook',
      label: 'Picky',
      address: receiver.url('/picky'),
    })
    const steady = await createNotificationChannel(db, enc, {
      scope: 'organization',
      organizationId,
      kind: 'webhook',
      label: 'Steady',
      address: receiver.url('/steady'),
    })
    await replaceRulesForChannel(db, steady.id, [{ event: '*', minSeverity: 'info' }])
    const arrived = (path: string) =>
      receiver.received.filter((r) => r.path === path).map((r) => JSON.parse(r.body).event)
    const emitAll = async () => {
      for (const event of [
        'server.offline',
        'server.deleted',
        'server.daemon_key_revoked',
      ] as const) {
        await emitNotification(
          db,
          enc,
          { event, organizationId, context: { serverName: 'db-1' } },
          receiver.deps
        )
      }
    }

    // A channel with no rule hears nothing.
    await emitAll()
    assertEquals(arrived('/picky'), [])
    assertEquals(arrived('/steady'), [
      'server.offline',
      'server.deleted',
      'server.daemon_key_revoked',
    ])

    // One named event: only that event arrives.
    await replaceRulesForChannel(db, picky.id, [{ event: 'server.deleted', minSeverity: 'info' }])
    await emitAll()
    assertEquals(arrived('/picky'), ['server.deleted'])

    // Every event with a warning floor: the info event stays out, warning and critical arrive.
    await replaceRulesForChannel(db, picky.id, [{ event: '*', minSeverity: 'warning' }])
    await emitAll()
    assertEquals(arrived('/picky'), [
      'server.deleted',
      'server.offline',
      'server.daemon_key_revoked',
    ])

    // The other channel's stream never changed.
    assertEquals(arrived('/steady').length, 9)
  })
})

test('a paused channel receives nothing and does not stall the others, then resumes', async () => {
  await withFixture(async ({ db, receiver, organizationId }) => {
    const enc = await secrets()
    const make = async (label: string) => {
      const channel = await createNotificationChannel(db, enc, {
        scope: 'organization',
        organizationId,
        kind: 'webhook',
        label,
        address: receiver.url(`/${label}`),
      })
      await replaceRulesForChannel(db, channel.id, [{ event: '*', minSeverity: 'info' }])
      return channel
    }
    const paused = await make('paused')
    await make('live')
    await setChannelDisabled(db, paused.id, true)

    const event = {
      event: 'server.offline',
      organizationId,
      context: { serverName: 'db-1' },
    } as const
    const while_paused = await emitNotification(db, enc, event, receiver.deps)
    assertEquals(while_paused.sent, 1)
    assertEquals(
      receiver.received.map((r) => r.path),
      ['/live']
    )

    await setChannelDisabled(db, paused.id, false)
    const resumed = await emitNotification(db, enc, event, receiver.deps)
    assertEquals(resumed.sent, 2)
    assertEquals(
      receiver.received.map((r) => r.path).toSorted((a, b) => a.localeCompare(b)),
      ['/live', '/live', '/paused']
    )
  })
})

test('a stale server\u2019s alert becomes one delivery per routed channel, named for the server, plus the bell', async () => {
  await withFixture(async ({ db, organizationId, memberId }) => {
    const enc = await secrets()
    const channelIds: string[] = []
    for (const label of ['ops', 'pager']) {
      const channel = await createNotificationChannel(db, enc, {
        scope: 'organization',
        organizationId,
        kind: 'webhook',
        label,
        // Nothing listens here; the ledger row is what the sweep owes the channel.
        address: `https://127.0.0.1:9/${label}`,
      })
      channelIds.push(channel.id)
      await replaceRulesForChannel(db, channel.id, [
        { event: 'server.offline', minSeverity: 'critical' },
      ])
    }
    const now = new Date().toISOString()
    const [srv] = await db
      .insert(server)
      .values({ createdAt: now, updatedAt: now, organizationId, name: 'Stopped Box' })
      .returning({ id: server.id })
    try {
      const send = await resolveAlertSender(db, enc)
      await send({
        kind: 'server.offline',
        text: 'a server went offline',
        detail: { serverId: srv!.id },
      })

      const rows = await db
        .select({
          channelId: notificationDelivery.channelId,
          payload: notificationDelivery.payload,
        })
        .from(notificationDelivery)
        .where(eq(notificationDelivery.organizationId, organizationId))
      assertEquals(
        rows.map((r) => r.channelId).toSorted((a, b) => a.localeCompare(b)),
        channelIds.toSorted((a, b) => a.localeCompare(b))
      )
      for (const r of rows) {
        assertEquals((r.payload as { title: string }).title, 'Server Stopped Box went offline')
      }
      const inbox = await listNotificationsForUser(db, memberId)
      assertEquals(
        inbox.map((n) => n.title),
        ['Server Stopped Box went offline']
      )
    } finally {
      await db.delete(server).where(eq(server.id, srv!.id))
    }
  })
})
