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
import {
  environment,
  hosting,
  organization,
  project,
  service,
  tls,
  workspace,
} from '../../db/schema.ts'
import {
  type HttpIssuanceState,
  newHttpIssuanceState,
  withHttpIssuanceState,
} from '../../features/tls/http-issuance/state.ts'
import {
  httpIssuanceContact,
  markChecked as markCheckedForTest,
  selectHttpIssuanceCandidates,
} from './http-issuance-sweep.ts'

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
  const stamp = new Date().toISOString()
  const [org] = await db
    .insert(organization)
    .values({ name: 'Sweep Org', options: { acmeEnabled: true } })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const [ws] = await db
    .insert(workspace)
    .values({ organizationId, name: 'WS', createdAt: stamp, updatedAt: stamp })
    .returning({ id: workspace.id })
  const [proj] = await db
    .insert(project)
    .values({ workspaceId: ws!.id, organizationId, name: 'P', createdAt: stamp, updatedAt: stamp })
    .returning({ id: project.id })
  const [env] = await db
    .insert(environment)
    .values({ projectId: proj!.id, name: 'e', createdAt: stamp, updatedAt: stamp })
    .returning({ id: environment.id })
  const [svc] = await db
    .insert(service)
    .values({
      environmentId: env!.id,
      name: 's',
      composeServiceName: 's',
      createdAt: stamp,
      updatedAt: stamp,
    })
    .returning({ id: service.id })
  const make = async (
    label: string,
    options: {
      key?: boolean
      state?: Partial<HttpIssuanceState> | null
      names?: string[]
      pinned?: boolean
    }
  ): Promise<string> => {
    const metadata: Record<string, unknown> = {
      dnsNames: options.names ?? [`${label}.example.com`],
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
    if (options.pinned !== false) {
      await db.insert(hosting).values({
        serviceId: svc!.id,
        name: label,
        tlsId: row!.id,
        options: { hostnames: [`${label}.example.com`] },
        createdAt: stamp,
        updatedAt: stamp,
      })
    }
    return row!.id
  }
  const issued = { phase: 'issued' as const, endedAt: iso(-1000), endsSentAt: iso(-900) }
  try {
    const ids = {
      fresh: await make('fresh', {}),
      open: await make('open', { state: {} }),
      undelivered: await make('undelivered', {
        key: true,
        state: { ...issued, deliveredAt: null, centralPair: true, renewAt: iso(86_400_000) },
      }),
      renewDue: await make('renewdue', {
        key: true,
        state: { ...issued, deliveredAt: iso(-500), centralPair: true, renewAt: iso(-10) },
      }),
      renewMissing: await make('renewmissing', {
        key: true,
        state: { ...issued, deliveredAt: iso(-500), centralPair: true },
      }),
      idle: await make('idle', {
        key: true,
        state: { ...issued, deliveredAt: iso(-500), centralPair: true, renewAt: iso(86_400_000) },
      }),
      notOurPair: await make('notourpair', {
        key: true,
        state: { ...issued, deliveredAt: iso(-500), centralPair: false },
      }),
      retryDue: await make('retrydue', {
        state: {
          phase: 'failed',
          endedAt: iso(-1000),
          endsSentAt: iso(-900),
          nextAttemptAt: iso(-1),
        },
      }),
      waiting: await make('waiting', {
        state: {
          phase: 'failed',
          endedAt: iso(-1000),
          endsSentAt: iso(-900),
          nextAttemptAt: iso(600_000),
        },
      }),
      failedWithPairNotDue: await make('failedpair', {
        key: true,
        state: {
          phase: 'failed',
          endedAt: iso(-1000),
          endsSentAt: iso(-900),
          nextAttemptAt: iso(-1),
          centralPair: true,
          renewAt: iso(86_400_000),
        },
      }),
      failedWithPairDue: await make('failedpairdue', {
        key: true,
        state: {
          phase: 'failed',
          endedAt: iso(-1000),
          endsSentAt: iso(-900),
          nextAttemptAt: iso(-1),
          centralPair: true,
          renewAt: iso(-5),
        },
      }),
      endsPending: await make('endspending', {
        state: {
          phase: 'failed',
          endedAt: iso(-1000),
          endsSentAt: null,
          nextAttemptAt: iso(600_000),
          forwards: [{ serverId: 'b', outcome: 'ready', reason: null, at: null }],
        },
      }),
      ownCaptured: await make('owncaptured', { key: true }),
      unpinned: await make('unpinned', { pinned: false }),
      wildcard: await make('wildcard', { names: ['*.example.com'] }),
      twoNames: await make('twonames', {
        names: ['twonames.example.com', 'www.twonames.example.com'],
      }),
    }
    const picked = (await selectHttpIssuanceCandidates(db, NOW, 100))
      .map((r) => r.id)
      .filter((id) => Object.values(ids).includes(id))
      .sort()
    assertEquals(
      picked,
      [
        ids.fresh,
        ids.open,
        ids.undelivered,
        ids.renewDue,
        ids.renewMissing,
        ids.retryDue,
        ids.failedWithPairDue,
        ids.endsPending,
      ].sort()
    )
    // Looking at a row notes it inside its request, leaves its own time alone and sends it to the back.
    const before = (await db.select().from(tls).where(eq(tls.id, ids.retryDue)))[0]!
    await markCheckedForTest(db, ids.retryDue, NOW)
    const after = (await db.select().from(tls).where(eq(tls.id, ids.retryDue)))[0]!
    assertEquals(after.updatedAt, before.updatedAt)
    assertEquals(
      (after.metadata as { httpCert: { checkedAt: string } }).httpCert.checkedAt,
      NOW.toISOString()
    )
    const order = (await selectHttpIssuanceCandidates(db, NOW, 100)).map((r) => r.id)
    assertEquals(order.indexOf(ids.retryDue) > order.indexOf(ids.fresh), true)
    // A row with no request is never written to by being looked at.
    await markCheckedForTest(db, ids.fresh, NOW)
    const fresh = (await db.select().from(tls).where(eq(tls.id, ids.fresh)))[0]!
    assertEquals('httpCert' in (fresh.metadata as object), false)
  } finally {
    await db.delete(hosting).where(eq(hosting.serviceId, svc!.id))
    await db.delete(tls).where(eq(tls.organizationId, organizationId))
    await db.delete(service).where(eq(service.id, svc!.id))
    await db.delete(environment).where(eq(environment.id, env!.id))
    await db.delete(project).where(eq(project.id, proj!.id))
    await db.delete(workspace).where(eq(workspace.id, ws!.id))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
})

test('the contact address and directory come from the platform environment', () => {
  assertEquals(httpIssuanceContact({}), { contactEmail: '', staging: false })
  assertEquals(
    httpIssuanceContact({
      TURBOPANEL_ACME_CONTACT_EMAIL: ' ops@example.com ',
      TURBOPANEL_ACME_STAGING: 'TRUE',
    }),
    { contactEmail: 'ops@example.com', staging: true }
  )
})
