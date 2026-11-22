/**
 * The lookup a late terminal report uses to find its open row by sid, against a
 * real database: scoped to the server, open versus closed, and no row for an
 * unknown sid. Needs a database.
 */
import { assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { createDenoDb } from '../../db/connection.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { audit } from '../../db/schema.ts'
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { findTerminalOpenAudit, recordAuditOrThrow } from './audit-records.ts'

const test = Deno.test.bind(Deno)

const SERVER = '0192f3a0-0000-7000-8000-00000000a001'
const OTHER_SERVER = '0192f3a0-0000-7000-8000-00000000a002'
const SID_OPEN = '11111111-2222-4333-8444-5555555555a1'
const SID_CLOSED = '11111111-2222-4333-8444-5555555555a2'

function entry(
  action: 'server.terminal.open' | 'server.terminal.close',
  serverId: string,
  sid: string
) {
  return {
    organizationId: null,
    actorUserId: null,
    action,
    targetType: 'server',
    targetId: serverId,
    context: { sid, kind: 'container', loginUser: '' },
  }
}

test('a late report finds the open row by sid, scoped to its server', async () => {
  if (!getDatabaseUrl()) {
    skipWithoutDatabase('terminal open audit lookup')
    return
  }
  const db = createDenoDb()
  try {
    await recordAuditOrThrow(db, entry('server.terminal.open', SERVER, SID_OPEN))
    await recordAuditOrThrow(db, entry('server.terminal.open', SERVER, SID_CLOSED))
    await recordAuditOrThrow(db, entry('server.terminal.close', SERVER, SID_CLOSED))

    const open = await findTerminalOpenAudit(db, SERVER, SID_OPEN)
    assertEquals(open?.closed, false)
    assertEquals(open?.context.sid, SID_OPEN)

    assertEquals((await findTerminalOpenAudit(db, SERVER, SID_CLOSED))?.closed, true)
    // Another server's daemon cannot reach this session, and an unknown sid has no row.
    assertEquals(await findTerminalOpenAudit(db, OTHER_SERVER, SID_OPEN), null)
    assertEquals(
      await findTerminalOpenAudit(db, SERVER, '11111111-2222-4333-8444-5555555555a3'),
      null
    )
  } finally {
    await db.delete(audit).where(eq(audit.targetId, SERVER))
  }
})
