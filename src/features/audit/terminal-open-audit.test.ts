/**
 * The lookup a late terminal report uses to find its open row by sid, against a
 * real database: scoped to the server and its organization, open versus
 * closed, and no row for an unknown sid. Needs a database.
 */
import { assertEquals } from '@std/assert'
import { and, eq, inArray } from 'drizzle-orm'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { audit, organization, server } from '../../db/schema.ts'
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import {
  closeAbandonedTerminalOpens,
  findTerminalOpenAudit,
  recordAuditOrThrow,
  TERMINAL_LOST_CLOSE_REASON,
} from './audit-records.ts'
import { auditBoundaryId } from './prune.ts'

const test = Deno.test.bind(Deno)

const SID_OPEN = '11111111-2222-4333-8444-5555555555a1'
const SID_CLOSED = '11111111-2222-4333-8444-5555555555a2'
const SID_OTHER_ORG = '11111111-2222-4333-8444-5555555555a4'

type Action = 'server.terminal.open' | 'server.terminal.close'

function entry(action: Action, organizationId: string | null, serverId: string, sid: string) {
  return {
    organizationId,
    actorUserId: null,
    action,
    targetType: 'server',
    targetId: serverId,
    context: { sid, kind: 'container', loginUser: '' },
  }
}

test('a late report finds the open row by sid, scoped to its server and organization', async () => {
  if (!getDatabaseUrl()) {
    skipWithoutDatabase('terminal open audit lookup')
    return
  }
  const db = createDenoDb()
  const orgs = await db
    .insert(organization)
    .values([{ name: 'Terminal Audit Org A' }, { name: 'Terminal Audit Org B' }])
    .returning({ id: organization.id })
  const orgA = orgs[0]!.id
  const orgB = orgs[1]!.id
  const servers = await db
    .insert(server)
    .values([{ organizationId: orgA }, { organizationId: orgA }, { organizationId: null }])
    .returning({ id: server.id })
  const [serverId, otherServer, unowned] = servers.map((row) => row.id) as [string, string, string]
  try {
    await recordAuditOrThrow(db, entry('server.terminal.open', orgA, serverId, SID_OPEN))
    await recordAuditOrThrow(db, entry('server.terminal.open', orgA, serverId, SID_CLOSED))
    await recordAuditOrThrow(db, entry('server.terminal.close', orgA, serverId, SID_CLOSED))
    // An open row under another organization (the server moved since) is still found.
    await recordAuditOrThrow(db, entry('server.terminal.open', orgB, serverId, SID_OTHER_ORG))

    const open = await findTerminalOpenAudit(db, serverId, SID_OPEN)
    assertEquals(open?.closed, false)
    assertEquals(open?.organizationId, orgA)
    assertEquals(open?.context.sid, SID_OPEN)

    assertEquals((await findTerminalOpenAudit(db, serverId, SID_CLOSED))?.closed, true)
    const moved = await findTerminalOpenAudit(db, serverId, SID_OTHER_ORG)
    assertEquals(moved?.organizationId, orgB)
    assertEquals(moved?.closed, false)
    // Another server's daemon cannot reach this session; a server without an
    // organization and an unknown server have nothing to find.
    assertEquals(await findTerminalOpenAudit(db, otherServer, SID_OPEN), null)
    assertEquals(await findTerminalOpenAudit(db, unowned, SID_OPEN), null)
    assertEquals(await findTerminalOpenAudit(db, crypto.randomUUID(), SID_OPEN), null)
    assertEquals(
      await findTerminalOpenAudit(db, serverId, '11111111-2222-4333-8444-5555555555a3'),
      null
    )
  } finally {
    await db.delete(audit).where(inArray(audit.organizationId, [orgA, orgB]))
    await db.delete(server).where(inArray(server.id, [serverId, otherServer, unowned]))
    await db.delete(organization).where(inArray(organization.id, [orgA, orgB]))
    await endDbConnection(db)
  }
})

test('an old open row with no close row gets one, under the open row organization, once', async () => {
  if (!getDatabaseUrl()) {
    skipWithoutDatabase('terminal abandoned open sweep')
    return
  }
  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'Terminal Sweep Org' })
    .returning({ id: organization.id })
  const orgId = org!.id
  const [srv] = await db
    .insert(server)
    .values({ organizationId: null })
    .returning({ id: server.id })
  const serverId = srv!.id
  const sidLost = '11111111-2222-4333-8444-5555555555b1'
  const sidClosed = '11111111-2222-4333-8444-5555555555b2'
  const sidYoung = '11111111-2222-4333-8444-5555555555b3'
  const hoursAgo = (h: number) => Date.now() - h * 3_600_000
  const open = (sid: string, ms: number, counter: number, action = 'server.terminal.open') => ({
    id: `${auditBoundaryId(ms).slice(0, 24)}${counter.toString(16).padStart(12, '0')}`,
    createdAt: new Date(ms).toISOString(),
    organizationId: orgId,
    actorUserId: null,
    action,
    targetType: 'server',
    targetId: serverId,
    context: { sid, kind: 'container', containerId: 'c1', loginUser: 'app' },
  })
  try {
    await db
      .insert(audit)
      .values([
        open(sidLost, hoursAgo(12), 1),
        open(sidClosed, hoursAgo(12), 2),
        open(sidClosed, hoursAgo(11), 3, 'server.terminal.close'),
        open(sidYoung, hoursAgo(1), 4),
      ])
    assertEquals(await closeAbandonedTerminalOpens(db), 1)
    assertEquals(await closeAbandonedTerminalOpens(db), 0)
    const closes = await db
      .select({ organizationId: audit.organizationId, context: audit.context })
      .from(audit)
      .where(and(eq(audit.targetId, serverId), eq(audit.action, 'server.terminal.close')))
    const lost = closes.filter((row) => (row.context as { sid?: string }).sid === sidLost)
    assertEquals(lost.length, 1)
    assertEquals(lost[0]?.organizationId, orgId)
    assertEquals((lost[0]?.context as { reason?: string }).reason, TERMINAL_LOST_CLOSE_REASON)
    assertEquals(closes.length, 2)
  } finally {
    await db.delete(audit).where(eq(audit.organizationId, orgId))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(organization).where(eq(organization.id, orgId))
    await endDbConnection(db)
  }
})
