/**
 * Host-free coverage for the trust level a server is held to and the audit of
 * a refused downgrade (no Postgres).
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import type { AuditEntry } from '../audit/audit-records.ts'
import {
  effectiveTrustLevel,
  recordTrustDowngradeRefused,
  TRUST_DOWNGRADE_AUDIT_WINDOW_MS,
} from './trust-level.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SERVER_ID = '00000000-0000-4000-8000-0000000000c1'
const ORG_ID = '00000000-0000-4000-8000-0000000000c2'
const PIN = 'P'.repeat(43)

test('the stored level stands when no pin report verified', () => {
  assertEquals(effectiveTrustLevel({ trustLevel: 0 }), 0)
  assertEquals(effectiveTrustLevel({ trustLevel: 2 }), 2)
  assertEquals(effectiveTrustLevel({ trustLevel: null }), 0)
})

test('a verified pin report naming a key holds the server at level 2', () => {
  const reportedAt = new Date('2026-11-01T00:00:00.000Z')
  assertEquals(
    effectiveTrustLevel({
      trustLevel: 0,
      trustPinFingerprint: PIN,
      trustPinReportedAt: reportedAt,
    }),
    2
  )
  assertEquals(
    effectiveTrustLevel({
      trustLevel: 2,
      trustPinFingerprint: PIN,
      trustPinReportedAt: '2026-11-01T00:00:00.000Z',
    }),
    2
  )
})

test('an unsafe report (empty pin) or a pin without a report does not count', () => {
  assertEquals(
    effectiveTrustLevel({ trustLevel: 0, trustPinFingerprint: '', trustPinReportedAt: new Date() }),
    0
  )
  assertEquals(
    effectiveTrustLevel({ trustLevel: 0, trustPinFingerprint: PIN, trustPinReportedAt: null }),
    0
  )
})

/** Answers the server row, then the recent-audit lookup, in that order. */
function fakeDb(params: {
  server: Array<{ organizationId: string | null }>
  recent: unknown[]
}): Db {
  const answers = [params.server, params.recent]
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(answers.shift() ?? []),
  }
  return { select: () => chain } as unknown as Db
}

test('a refused downgrade writes one audit row for the server', async () => {
  const written: AuditEntry[] = []
  const wrote = await recordTrustDowngradeRefused(
    fakeDb({ server: [{ organizationId: ORG_ID }], recent: [] }),
    SERVER_ID,
    { stage: 'attach', reason: 'attach proof missing' },
    {
      audit: (_db, entry) => {
        written.push(entry)
        return Promise.resolve()
      },
    }
  )
  assertEquals(wrote, true)
  assertEquals(written, [
    {
      organizationId: ORG_ID,
      actorUserId: null,
      action: 'server.trust_downgrade.refused',
      targetType: 'server',
      targetId: SERVER_ID,
      context: { stage: 'attach', reason: 'attach proof missing' },
    },
  ])
})

test('no second row inside the window, and none for an unknown server', async () => {
  const written: AuditEntry[] = []
  const audit = (_db: Db | undefined, entry: AuditEntry) => {
    written.push(entry)
    return Promise.resolve()
  }
  const refusal = { stage: 'auth-session', reason: 'request signature missing' } as const
  assertEquals(
    await recordTrustDowngradeRefused(
      fakeDb({ server: [{ organizationId: null }], recent: [{ id: 'a' }] }),
      SERVER_ID,
      refusal,
      { audit }
    ),
    false
  )
  assertEquals(
    await recordTrustDowngradeRefused(fakeDb({ server: [], recent: [] }), SERVER_ID, refusal, {
      audit,
    }),
    false
  )
  assertEquals(written, [])
  assertEquals(TRUST_DOWNGRADE_AUDIT_WINDOW_MS, 3_600_000)
})

test('a database error is logged, never thrown', async () => {
  const db = {
    select: () => {
      throw new Error('connection lost')
    },
  } as unknown as Db
  assertEquals(
    await recordTrustDowngradeRefused(db, SERVER_ID, { stage: 'attach', reason: 'x' }),
    false
  )
})
