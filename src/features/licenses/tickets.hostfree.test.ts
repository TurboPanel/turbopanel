/**
 * Host-free coverage for enrolment tickets and credential resolution (no Postgres).
 */
import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import { hashPassword } from '../../lib/secrets/password.ts'
import { resolveEnrollCredential } from './enroll-credential.ts'
import { checkTicket, consumeTicket, TICKET_TTL_MS } from './tickets.ts'

/** Jest/Mocha-shaped alias so Sonar sees real tests. */
const test = Deno.test.bind(Deno)

const ORG_ID = '00000000-0000-4000-8000-0000000000a1'
const LICENSE_ID = '00000000-0000-4000-8000-0000000000a2'
const TICKET_ID = '00000000-0000-4000-8000-0000000000a3'
const SERVER_ID = '00000000-0000-4000-8000-0000000000a4'
const NOW = Date.parse('2026-11-01T12:00:00.000Z')
const TICKET_PLAINTEXT = 'ticket-plaintext-value'
/** `resolveEnrollCredential` reads the real clock, so its rows expire far away. */
const FAR_FUTURE = '2999-01-01T00:00:00.000Z'

type Row = Record<string, unknown>

/** A fake Db: each `select` takes the next queued row set; `update ... returning` answers `updated`. */
function fakeDb(selects: Row[][], updated: Row[] = []): Db {
  const queue = [...selects]
  return {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(queue.shift() ?? []) }),
      }),
    }),
    update: () => ({
      set: () => ({ where: () => ({ returning: () => Promise.resolve(updated) }) }),
    }),
  } as unknown as Db
}

async function ticketRow(overrides: Row = {}): Promise<Row> {
  return {
    id: TICKET_ID,
    organizationId: ORG_ID,
    licenseId: LICENSE_ID,
    serverId: null,
    serverName: null,
    token: await hashPassword(TICKET_PLAINTEXT),
    expiresAt: new Date(NOW + TICKET_TTL_MS).toISOString(),
    usedAt: null,
    ...overrides,
  }
}

test('checkTicket accepts an unused ticket with the right secret and drops the hash', async () => {
  const result = await checkTicket(fakeDb([[await ticketRow()]]), TICKET_ID, TICKET_PLAINTEXT, NOW)
  assertEquals(result.ok, true)
  if (result.ok) assertEquals('token' in result.ticket, false)
})

test('checkTicket refuses a wrong secret, a spent ticket and an expired one', async () => {
  const wrong = await checkTicket(fakeDb([[await ticketRow()]]), TICKET_ID, 'nope', NOW)
  assertEquals(wrong, { ok: false, reason: 'bad' })

  const spent = await ticketRow({ usedAt: new Date(NOW - 1000).toISOString() })
  assertEquals(await checkTicket(fakeDb([[spent]]), TICKET_ID, TICKET_PLAINTEXT, NOW), {
    ok: false,
    reason: 'used',
  })

  const lapsed = await checkTicket(
    fakeDb([[await ticketRow()]]),
    TICKET_ID,
    TICKET_PLAINTEXT,
    NOW + TICKET_TTL_MS + 1
  )
  assertEquals(lapsed, { ok: false, reason: 'expired' })
})

test('checkTicket answers bad for an unknown id, a non-UUID id and an empty secret without a query', async () => {
  assertEquals(await checkTicket(fakeDb([[]]), TICKET_ID, TICKET_PLAINTEXT, NOW), {
    ok: false,
    reason: 'bad',
  })
  assertEquals(
    await checkTicket(fakeDb([[await ticketRow()]]), 'not-a-uuid', TICKET_PLAINTEXT, NOW),
    {
      ok: false,
      reason: 'bad',
    }
  )
  assertEquals(await checkTicket(fakeDb([[await ticketRow()]]), TICKET_ID, '', NOW), {
    ok: false,
    reason: 'bad',
  })
})

test('consumeTicket is true only when the conditional update touched a row', async () => {
  assertEquals(await consumeTicket(fakeDb([], [{ id: TICKET_ID }]), TICKET_ID, NOW), true)
  assertEquals(await consumeTicket(fakeDb([], []), TICKET_ID, NOW), false)
})

test('resolveEnrollCredential tells a join ticket from a licence by lookup', async () => {
  // First select: the licence lookup finds nothing; then the ticket; then its target licence.
  const db = fakeDb([
    [],
    [await ticketRow({ expiresAt: FAR_FUTURE })],
    [{ organizationId: ORG_ID, token: null, serverId: null, expiresAt: null }],
  ])
  const credential = await resolveEnrollCredential(db, TICKET_ID, TICKET_PLAINTEXT)
  assertEquals(credential?.kind, 'join')
  if (credential?.kind === 'join') {
    assertEquals(credential.licenseId, LICENSE_ID)
    assertEquals(credential.verified, { organizationId: ORG_ID })
  }
})

test('resolveEnrollCredential refuses a join ticket whose key is bound, revoked or gone', async () => {
  const db = fakeDb([[], [await ticketRow({ expiresAt: FAR_FUTURE })], []])
  assertEquals(await resolveEnrollCredential(db, TICKET_ID, TICKET_PLAINTEXT), null)
})

test('resolveEnrollCredential recognises a re-enroll ticket', async () => {
  const row = await ticketRow({ licenseId: null, serverId: SERVER_ID, expiresAt: FAR_FUTURE })
  const credential = await resolveEnrollCredential(fakeDb([[], [row]]), TICKET_ID, TICKET_PLAINTEXT)
  assertEquals(credential?.kind, 'reenroll')
})

test('resolveEnrollCredential returns null for a pair that is neither a licence nor a ticket', async () => {
  assertEquals(await resolveEnrollCredential(fakeDb([[], []]), TICKET_ID, TICKET_PLAINTEXT), null)
})
