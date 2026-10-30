/**
 * Real-Postgres coverage for which library rows the server-placed order sweep
 * picks up: a row with no certificate, an open request, a finished pair not yet
 * handed out or due for renewal, and a failed attempt whose wait is over. A row
 * a server captured by itself, a delivered pair that is not due and a failed
 * attempt still waiting are left alone.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { createDenoDb } from '../../db/connection.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { organization, tls } from '../../db/schema.ts'
import {
  type HttpIssuanceState,
  newHttpIssuanceState,
  withHttpIssuanceState,
} from '../../features/tls/http-issuance/state.ts'
import { selectHttpIssuanceCandidates } from './http-issuance-sweep.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const NOW = new Date('2026-11-01T12:00:00.000Z')
const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString()

test('the sweep picks up exactly the rows with work to do', async () => {
  if (!dbUrl) return skipWithoutDatabase('http issuance sweep tests')
  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'Sweep Org', options: { acmeEnabled: true } })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const make = async (
    label: string,
    options: { key?: boolean; state?: Partial<HttpIssuanceState> | null }
  ): Promise<string> => {
    const metadata: Record<string, unknown> = {
      dnsNames: [`${label}.example.com`],
      acme: { managedBy: 'caddy' },
    }
    const withState =
      options.state === null || options.state === undefined
        ? metadata
        : withHttpIssuanceState(
            metadata,
            newHttpIssuanceState({
              issuingServerId: 'a',
              requestId: `req_${label}`,
              startedAt: iso(-60_000),
              startByAt: iso(60_000),
              ...options.state,
            })
          )
    const [row] = await db
      .insert(tls)
      .values({
        organizationId,
        name: label,
        source: 'lets_encrypt',
        status: 'automatic',
        privateKeyPem: options.key ? 'tpsecret.x' : null,
        metadata: withState,
        options: {},
      })
      .returning({ id: tls.id })
    return row!.id
  }
  try {
    const ids = {
      fresh: await make('fresh', {}),
      open: await make('open', { state: {} }),
      undelivered: await make('undelivered', {
        key: true,
        state: {
          phase: 'issued',
          endedAt: iso(-1000),
          deliveredAt: null,
          renewAt: iso(86_400_000),
        },
      }),
      renewDue: await make('renewdue', {
        key: true,
        state: { phase: 'issued', endedAt: iso(-1000), deliveredAt: iso(-500), renewAt: iso(-10) },
      }),
      idle: await make('idle', {
        key: true,
        state: {
          phase: 'issued',
          endedAt: iso(-1000),
          deliveredAt: iso(-500),
          renewAt: iso(86_400_000),
        },
      }),
      retryDue: await make('retrydue', {
        state: { phase: 'failed', endedAt: iso(-1000), nextAttemptAt: iso(-1) },
      }),
      waiting: await make('waiting', {
        state: { phase: 'failed', endedAt: iso(-1000), nextAttemptAt: iso(600_000) },
      }),
      ownCaptured: await make('owncaptured', { key: true }),
    }
    const picked = (await selectHttpIssuanceCandidates(db, NOW, 100))
      .map((r) => r.id)
      .filter((id) => Object.values(ids).includes(id))
      .sort()
    assertEquals(picked, [ids.fresh, ids.open, ids.undelivered, ids.renewDue, ids.retryDue].sort())
  } finally {
    await db.delete(tls).where(eq(tls.organizationId, organizationId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
})
