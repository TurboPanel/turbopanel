/**
 * One-hour, single-use enrolment tickets (`ticket` table).
 *
 * A **join ticket** (bound to a registration key) travels in the install
 * value in place of the licence token, so the licence token itself is never
 * shown or sent: whoever captures the install command at an edge holds a
 * secret that expires in an hour and works once. A **re-enroll ticket**
 * (bound to one server) is how an owner lets a server whose daemon key was
 * lost replace it; presented for any other server it is refused.
 *
 * The secret is stored as an Argon2id hash, like a registration key's. Both kinds
 * ride the existing `licenseId` / `licenseToken` slots (`licenseId` carries
 * the ticket id) and the panel tells them apart from a licence by lookup.
 *
 * Workers-bundleable: nothing at module load.
 */
import { and, eq, gt, isNull, type SQL } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { ticket } from '../../db/schema.ts'
import { generatePassword } from '../../lib/secrets/generate-secret.ts'
import { hashPassword, verifyPassword } from '../../lib/secrets/password.ts'

/** How long a ticket stays usable. */
export const TICKET_TTL_MS = 60 * 60 * 1000

export type TicketRow = {
  id: string
  organizationId: string
  licenseId: string | null
  serverId: string | null
  serverName: string | null
  expiresAt: string
  usedAt: string | null
}

export type TicketCheck =
  { ok: true; ticket: TicketRow } | { ok: false; reason: 'bad' | 'expired' | 'used' }

const TICKET_COLUMNS = {
  id: ticket.id,
  organizationId: ticket.organizationId,
  licenseId: ticket.licenseId,
  serverId: ticket.serverId,
  serverName: ticket.serverName,
  token: ticket.token,
  expiresAt: ticket.expiresAt,
  usedAt: ticket.usedAt,
} as const

/** Mint a ticket. A re-enroll ticket sets `serverId`; a join ticket sets `licenseId`. */
export async function mintTicket(
  db: Db,
  input: {
    organizationId: string
    licenseId?: string
    serverId?: string
    serverName?: string | null
    userId?: string | null
  },
  nowMs: number = Date.now()
): Promise<{ id: string; plaintext: string; expiresAt: string }> {
  const plaintext = generatePassword()
  const expiresAt = new Date(nowMs + TICKET_TTL_MS).toISOString()
  const [row] = await db
    .insert(ticket)
    .values({
      organizationId: input.organizationId,
      licenseId: input.licenseId ?? null,
      serverId: input.serverId ?? null,
      serverName: input.serverName ?? null,
      token: await hashPassword(plaintext),
      expiresAt,
      createdByUserId: input.userId ?? null,
    })
    .returning({ id: ticket.id })
  if (!row) throw new Error('Ticket creation failed')
  return { id: row.id, plaintext, expiresAt }
}

/** Whether a value is shaped like a ticket id, so a non-UUID never reaches the query. */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

/** Read-only check: the secret matches, and the ticket is unused and unexpired. */
export async function checkTicket(
  db: Db,
  id: string,
  plaintext: string,
  nowMs: number = Date.now()
): Promise<TicketCheck> {
  if (!isUuid(id) || plaintext.length === 0) return { ok: false, reason: 'bad' }
  const [row] = await db.select(TICKET_COLUMNS).from(ticket).where(eq(ticket.id, id)).limit(1)
  if (!row) return { ok: false, reason: 'bad' }
  const { token, ...fields } = row
  if (!(await verifyPassword(plaintext, token))) return { ok: false, reason: 'bad' }
  if (fields.usedAt !== null) return { ok: false, reason: 'used' }
  if (Date.parse(fields.expiresAt) <= nowMs) return { ok: false, reason: 'expired' }
  return { ok: true, ticket: fields }
}

/**
 * Atomically mark a ticket used. Returns the `used_at` value it wrote (the
 * token {@link releaseTicket} needs), or null when someone else used it first
 * or it has expired.
 */
export async function consumeTicket(
  db: Db,
  id: string,
  nowMs: number = Date.now()
): Promise<string | null> {
  const now = new Date(nowMs).toISOString()
  const rows = await db
    .update(ticket)
    .set({ usedAt: now })
    .where(and(eq(ticket.id, id), isNull(ticket.usedAt), gt(ticket.expiresAt, now)))
    .returning({ id: ticket.id })
  return rows.length > 0 ? now : null
}

/**
 * Put a consumed ticket back when the enrolment it was spent on wrote nothing.
 * Compare-and-swap on `used_at`: only the value {@link consumeTicket} wrote is
 * undone, so a revoke or reissue that touched the ticket since stays in force.
 */
export async function releaseTicket(db: Db, id: string, consumedAt: string): Promise<void> {
  await db
    .update(ticket)
    .set({ usedAt: null, usedByServerId: null })
    .where(and(eq(ticket.id, id), eq(ticket.usedAt, consumedAt)))
}

/** Record which server a consumed ticket produced. */
export async function recordTicketServer(db: Db, id: string, serverId: string): Promise<void> {
  await db.update(ticket).set({ usedByServerId: serverId }).where(eq(ticket.id, id))
}

/** How often a stamp retries when a ticket changes under it. */
const STAMP_ATTEMPTS = 3

/**
 * Stamp every ticket matching `scope` that is not yet bound to a server: the
 * unused ones, and the ones a consume has spent but whose enrolment has not
 * recorded a server. The stamp is a value no consume could have written (the
 * later of the old `used_at` plus a millisecond and now), so a release that
 * compares against the consume's value finds it changed and leaves the ticket
 * spent. Bound tickets (a server recorded) are finished and left alone.
 */
async function stampTickets(db: Db, scope: SQL): Promise<number> {
  let live = 0
  for (let attempt = 0; attempt < STAMP_ATTEMPTS; attempt++) {
    const rows = await db
      .select({ id: ticket.id, usedAt: ticket.usedAt, usedByServerId: ticket.usedByServerId })
      .from(ticket)
      .where(scope)
    let raced = false
    // A ticket with a server recorded is finished; every other one is stamped.
    for (const row of rows.filter((entry) => entry.usedByServerId === null)) {
      if (await stampOne(db, row)) {
        if (row.usedAt === null) live++
      } else {
        raced = true
      }
    }
    if (!raced) return live
  }
  // A ticket may still be live: the caller must not go on as if it were cancelled.
  throw new Error('ticket stamp did not settle')
}

/** Stamp one ticket if it is still as read. False when it changed under us. */
async function stampOne(db: Db, row: { id: string; usedAt: string | null }): Promise<boolean> {
  const was = row.usedAt === null ? 0 : Date.parse(row.usedAt)
  const next = new Date(Math.max(Date.now(), was + 1)).toISOString()
  const unchanged = row.usedAt === null ? isNull(ticket.usedAt) : eq(ticket.usedAt, row.usedAt)
  const done = await db
    .update(ticket)
    .set({ usedAt: next })
    .where(and(eq(ticket.id, row.id), unchanged))
    .returning({ id: ticket.id })
  return done.length > 0
}

/** Revoke every re-enroll ticket of a server that has not produced a key yet. Returns how many were still unused. */
export function revokeServerTickets(db: Db, serverId: string): Promise<number> {
  return stampTickets(db, eq(ticket.serverId, serverId))
}

/** Cancel every join ticket of a key that has not produced a server yet (a burn replaces them). */
export function cancelLicenseTickets(db: Db, licenseId: string): Promise<number> {
  return stampTickets(db, eq(ticket.licenseId, licenseId))
}
