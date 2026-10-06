import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import type { ManagedHealthReportMember } from '../../contracts/cell-protocol.ts'
import { validateDaemonInboundFrame } from '../../contracts/cell-protocol.ts'
import { replica } from '../../db/schema.ts'
import { handleManagedHealthReport } from './health-report.ts'

/** Jest/Mocha-shaped alias so Sonar sees the tests (see ha-recovery.hostfree.test.ts). */
const test = Deno.test.bind(Deno)

const MANAGED = 'managed-1'
const MEMBER_OURS = '00000000-0000-4000-8000-000000000021'
const MEMBER_OTHER_SERVER = '00000000-0000-4000-8000-000000000022'
const MEMBER_PRIMARY = '00000000-0000-4000-8000-000000000020'
const REPORTER = 'server-a'
const NOW_MS = Date.parse('2026-10-06T12:00:00.000Z')
const iso = (offsetMs: number) => new Date(NOW_MS + offsetMs).toISOString()

type Row = {
  id: string
  managedId: string
  serverId: string
  role: string
  metadata: unknown
}

function thenableRows(rows: unknown[]) {
  const promise = Promise.resolve(rows)
  const chain: Record<string, unknown> = {}
  const self = () => chain
  chain.where = self
  chain.limit = self
  chain.then = promise.then.bind(promise)
  chain.catch = promise.catch.bind(promise)
  chain.finally = promise.finally.bind(promise)
  return chain
}

function harness() {
  const rows: Row[] = [
    {
      id: MEMBER_OURS,
      managedId: MANAGED,
      serverId: REPORTER,
      role: 'replica',
      metadata: {},
    },
    {
      id: MEMBER_OTHER_SERVER,
      managedId: MANAGED,
      serverId: 'server-b',
      role: 'replica',
      metadata: {},
    },
    {
      id: MEMBER_PRIMARY,
      managedId: MANAGED,
      serverId: REPORTER,
      role: 'primary',
      metadata: {},
    },
  ]
  const written: Array<{ metadata: Record<string, unknown> }> = []
  const db = {
    select: () => ({
      from: (table: unknown) => {
        if (table !== replica) return thenableRows([])
        return thenableRows(rows)
      },
    }),
    update: () => ({
      set: (patch: { metadata: Record<string, unknown> }) => ({
        where: () => {
          written.push({ metadata: patch.metadata })
          return Promise.resolve()
        },
      }),
    }),
  }
  return { db: db as unknown as Db, written }
}

test("a report stores the reading of the reporter's own replica and drops lastStreaming", async () => {
  const h = harness()
  const member: ManagedHealthReportMember = {
    managedId: MANAGED,
    memberId: MEMBER_OURS,
    replication: {
      state: 'streaming',
      observedAt: iso(-1000),
      lagBytes: 0,
      lastStreaming: { at: iso(-1000), ageMs: 5 },
    },
  }
  const outcome = await handleManagedHealthReport(h.db, {
    reporterServerId: REPORTER,
    members: [member],
    nowMs: NOW_MS,
  })
  assertEquals(outcome, { stored: 1, ignored: 0 })
  assertEquals(h.written.length, 1)
  const stored = h.written[0]!.metadata.replication as Record<string, unknown>
  assertEquals(stored.state, 'streaming')
  assertEquals('lastStreaming' in stored, false)
})

test('a replica reported down is stored as not streaming with the receipt time', async () => {
  const h = harness()
  await handleManagedHealthReport(h.db, {
    reporterServerId: REPORTER,
    members: [{ managedId: MANAGED, memberId: MEMBER_OURS, down: true }],
    nowMs: NOW_MS,
  })
  assertEquals(h.written[0]!.metadata.replication, {
    state: 'not_streaming',
    observedAt: iso(0),
  })
})

test('a reading dated in the future is stored with the receipt time', async () => {
  const h = harness()
  await handleManagedHealthReport(h.db, {
    reporterServerId: REPORTER,
    members: [
      {
        managedId: MANAGED,
        memberId: MEMBER_OURS,
        replication: { state: 'streaming', observedAt: iso(3_600_000) },
      },
    ],
    nowMs: NOW_MS,
  })
  const stored = h.written[0]!.metadata.replication as { observedAt: string }
  assertEquals(stored.observedAt, iso(0))
})

test("another server's member, a primary and a wrong cluster are ignored, never written", async () => {
  const h = harness()
  const reading = { state: 'streaming', observedAt: iso(0) }
  const outcome = await handleManagedHealthReport(h.db, {
    reporterServerId: REPORTER,
    members: [
      {
        managedId: MANAGED,
        memberId: MEMBER_OTHER_SERVER,
        replication: reading,
      },
      { managedId: MANAGED, memberId: MEMBER_PRIMARY, replication: reading },
      {
        managedId: 'other-cluster',
        memberId: MEMBER_OURS,
        replication: reading,
      },
      { managedId: MANAGED, memberId: 'unknown-member', replication: reading },
    ],
    nowMs: NOW_MS,
  })
  assertEquals(outcome, { stored: 0, ignored: 4 })
  assertEquals(h.written.length, 0)
})

const AT = '2026-10-06T12:00:00.000Z'

test('the wire check accepts a well-formed report and rejects malformed ones', () => {
  const frame = (members: unknown) =>
    validateDaemonInboundFrame(JSON.stringify({ type: 'managed-health-report', members, at: AT }))
  const good = {
    managedId: MANAGED,
    memberId: MEMBER_OURS,
    replication: { state: 'streaming', observedAt: AT },
  }
  assertEquals(frame([good]).ok, true)
  assertEquals(frame([{ managedId: MANAGED, memberId: MEMBER_OURS, down: true }]).ok, true)
  assertEquals(frame([]).ok, false)
  assertEquals(frame([{ managedId: MANAGED, memberId: MEMBER_OURS }]).ok, false)
  assertEquals(
    frame([{ ...good, down: true }]).ok,
    false,
    'a member is either down or has a reading, never both'
  )
  assertEquals(frame([{ ...good, replication: { state: 'streaming', observedAt: 'x' } }]).ok, false)
  assertEquals(frame(Array.from({ length: 33 }, () => good)).ok, false)
})
