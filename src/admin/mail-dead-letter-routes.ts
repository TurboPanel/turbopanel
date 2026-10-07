import type { Context, Hono } from 'hono'
import type { AppEnv } from '../app/app.ts'
import { getDb } from '../db/connection.ts'
import { recordAudit } from '../features/audit/audit-records.ts'
import {
  DEAD_LETTER_LIST_DEFAULT,
  DEAD_LETTER_LIST_MAX,
  DEAD_LETTER_REPLAY_MAX,
  type MailDeadLetterStore,
  MailQueueUnavailableError,
} from '../features/email/smtp/dead-letter-replay.ts'

const UNSUPPORTED = {
  error: 'mail_dead_letters_unsupported',
  message:
    'The mail dead-letter queue is only available where mail goes through RabbitMQ (self-hosted control planes). Hosted mail uses Cloudflare Queues, which has its own dead-letter queue.',
} as const

const UNAVAILABLE = {
  error: 'mail_queue_unavailable',
  message: 'The mail queue could not be reached. Try again in a moment.',
} as const

function parseLimit(raw: string | undefined, fallback: number, max: number): number | null {
  if (raw === undefined || raw === '') return fallback
  if (!/^\d+$/.test(raw)) return null
  const value = Number.parseInt(raw, 10)
  return value >= 1 && value <= max ? value : null
}

async function readReplayAllLimit(c: Context<AppEnv>): Promise<number | null> {
  const body: unknown = await c.req.json().catch(() => ({}))
  const raw =
    typeof body === 'object' && body !== null ? (body as { limit?: unknown }).limit : undefined
  if (raw === undefined) return DEAD_LETTER_REPLAY_MAX
  return Number.isInteger(raw) && (raw as number) >= 1 && (raw as number) <= DEAD_LETTER_REPLAY_MAX
    ? (raw as number)
    : null
}

/**
 * Admin routes for the mail dead-letter queue: list what gave up, replay one
 * or all. Mounted under `/api/admin/v1` after the admin middleware, so only an
 * administrator reaches them. Without a store (Workers, or no broker) every
 * route answers 501; a broker that cannot be reached answers 503.
 *
 * The listing never returns a job's body (sign-in codes, reset links) and
 * masks the recipient.
 */
export function registerMailDeadLetterAdminRoutes(
  admin: Hono<AppEnv>,
  opts: { store?: MailDeadLetterStore }
): void {
  const store = opts.store

  const audit = async (c: Context<AppEnv>, context: Record<string, unknown>) => {
    const session = c.get('session')
    await recordAudit(getDb(c), {
      organizationId: null,
      actorUserId: session?.userId ?? null,
      actorEmail: session?.email ?? null,
      action: 'mail.dead_letter.replay',
      targetType: 'mail_queue',
      context,
    })
  }

  const guarded = async (
    c: Context<AppEnv>,
    run: (s: MailDeadLetterStore) => Promise<Response>
  ) => {
    if (!store) return c.json(UNSUPPORTED, 501)
    try {
      return await run(store)
    } catch (error) {
      if (error instanceof MailQueueUnavailableError) return c.json(UNAVAILABLE, 503)
      throw error
    }
  }

  admin.get('/mail/dead-letters', (c) =>
    guarded(c, async (s) => {
      const limit = parseLimit(c.req.query('limit'), DEAD_LETTER_LIST_DEFAULT, DEAD_LETTER_LIST_MAX)
      if (limit === null) {
        return c.json({ error: `limit must be 1 to ${DEAD_LETTER_LIST_MAX}` }, 400)
      }
      return c.json(await s.list(limit))
    })
  )

  admin.post('/mail/dead-letters/replay-all', (c) =>
    guarded(c, async (s) => {
      const limit = await readReplayAllLimit(c)
      if (limit === null) {
        return c.json({ error: `limit must be 1 to ${DEAD_LETTER_REPLAY_MAX}` }, 400)
      }
      const result = await s.replayAll(limit)
      await audit(c, { ...result, scope: 'all' })
      return c.json(result)
    })
  )

  admin.post('/mail/dead-letters/:id/replay', (c) =>
    guarded(c, async (s) => {
      const id = c.req.param('id')
      const result = await s.replayOne(id)
      if (!result.replayed) return c.json({ error: 'Not found' }, 404)
      await audit(c, { replayed: 1, scope: 'one' })
      return c.json({ replayed: 1 })
    })
  )
}
