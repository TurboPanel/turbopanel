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
  hostname,
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
  readHttpIssuanceState,
  withHttpIssuanceState,
} from '../../features/tls/http-issuance/state.ts'
import { removeUnusedSiteCertificates } from '../../features/tls/unused-letsencrypt.ts'
import { ensureNameHttpOrders } from '../hostings/name-http-orders.ts'
import {
  httpIssuanceStaging,
  httpIssuanceEnabled,
  markUnpinnedLibraryOrders,
  runHttpIssuanceSweepTick,
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

/** One pool for the file: a pool per test runs the server out of clients. */
let sharedDb: ReturnType<typeof createDenoDb> | undefined

const NOW = new Date('2026-11-01T12:00:00.000Z')
const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString()

/** Rows pinned by one site in a throwaway organization, made with `make`. */
async function sweepWorld() {
  sharedDb ??= createDenoDb()
  const db = sharedDb
  const stamp = new Date().toISOString()
  const [org] = await db
    .insert(organization)
    .values({ name: 'Sweep Org', isAcmeEnabled: true })
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
  return {
    db,
    make,
    async cleanup() {
      await db.delete(hosting).where(eq(hosting.serviceId, svc!.id))
      await db.delete(tls).where(eq(tls.organizationId, organizationId))
      await db.delete(service).where(eq(service.id, svc!.id))
      await db.delete(environment).where(eq(environment.id, env!.id))
      await db.delete(project).where(eq(project.id, proj!.id))
      await db.delete(workspace).where(eq(workspace.id, ws!.id))
      await db.delete(organization).where(eq(organization.id, organizationId))
    },
  }
}

test('the sweep picks up exactly the rows with work to do', async () => {
  if (!dbUrl) return skipWithoutDatabase('http issuance sweep tests')
  const w = await sweepWorld()
  const { db, make } = w
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
        // Several names are picked; who may take the order is decided per daemon.
        ids.twoNames,
      ].sort()
    )
  } finally {
    await w.cleanup()
  }
})

test('the test directory is a platform setting', () => {
  assertEquals(httpIssuanceStaging({}), false)
  assertEquals(httpIssuanceStaging({ TURBOPANEL_ACME_STAGING: ' TRUE ' }), true)
  assertEquals(httpIssuanceStaging({ TURBOPANEL_ACME_STAGING: 'no' }), false)
})

test('open requests and finished pairs are always inside the batch, however many rows are waiting', async () => {
  if (!dbUrl) return skipWithoutDatabase('http issuance sweep tests')
  const w = await sweepWorld()
  try {
    for (let i = 0; i < 40; i += 1) await w.make(`wait${i}`, {})
    const open = await w.make('openone', { state: {} })
    const undelivered = await w.make('undeliveredone', {
      key: true,
      state: {
        phase: 'issued',
        endedAt: iso(-1000),
        endsSentAt: iso(-900),
        deliveredAt: null,
        centralPair: true,
        renewAt: iso(86_400_000),
      },
    })
    const seen = new Set<string>()
    for (let minute = 0; minute < 6; minute += 1) {
      const at = new Date(NOW.getTime() + minute * 60_000)
      const batch = (await selectHttpIssuanceCandidates(w.db, at, 25)).map((r) => r.id)
      assertEquals(batch.length, 25)
      assertEquals(batch.includes(open), true)
      assertEquals(batch.includes(undelivered), true)
      for (const id of batch) seen.add(id)
    }
    // The waiting rows take turns: over six minutes most of them are looked at.
    assertEquals(seen.size > 30, true)
  } finally {
    await w.cleanup()
  }
})

test('the whole flow can be switched off for the platform', () => {
  assertEquals(httpIssuanceEnabled({}), true)
  assertEquals(httpIssuanceEnabled({ TURBOPANEL_SHARED_CERTIFICATES: 'on' }), true)
  assertEquals(httpIssuanceEnabled({ TURBOPANEL_SHARED_CERTIFICATES: ' OFF ' }), false)
})

test('an unpinned DNS library order is told to wait for a site, once; a pinned one is left alone', async () => {
  if (!dbUrl) return skipWithoutDatabase('http issuance sweep tests')
  const w = await sweepWorld()
  try {
    const dnsAcme = { managedBy: 'caddy', challengeType: 'dns-01', createdFor: 'library' }
    const mark = async (label: string, pinned: boolean) => {
      const id = await w.make(label, { pinned })
      const [row] = await w.db.select().from(tls).where(eq(tls.id, id))
      await w.db
        .update(tls)
        .set({ metadata: { ...(row!.metadata as object), acme: dnsAcme } })
        .where(eq(tls.id, id))
      return id
    }
    const loose = await mark('loose', false)
    const pinned = await mark('pinnedone', true)
    assertEquals(await markUnpinnedLibraryOrders(w.db, NOW), 1)
    assertEquals(await markUnpinnedLibraryOrders(w.db, NOW), 0)
    const warning = async (id: string) => {
      const [row] = await w.db.select().from(tls).where(eq(tls.id, id))
      return (row!.metadata as { acme?: { warning?: string } }).acme?.warning
    }
    assertEquals(await warning(loose), 'Waiting for a site to use this certificate.')
    assertEquals(await warning(pinned), undefined)
  } finally {
    await w.cleanup()
  }
})

test('a row made for one name by its HTTP choice is picked up by the sweep; once unpinned, its open order is skipped', async () => {
  if (!dbUrl) return skipWithoutDatabase('http issuance sweep tests')
  const w = await sweepWorld()
  const { db } = w
  const stamp = new Date().toISOString()
  try {
    // The world's own hosting is not used: a site with two names is made here.
    const anchor = await w.make('anchor', {})
    const [anchorRow] = await db.select().from(tls).where(eq(tls.id, anchor))
    const organizationId = anchorRow!.organizationId
    const [pinnedSite] = await db.select().from(hosting).where(eq(hosting.tlsId, anchor))
    const [site] = await db
      .insert(hosting)
      .values({
        serviceId: pinnedSite!.serviceId,
        name: 'two-names',
        options: { hostnames: ['one.example.net', 'two.example.net'] },
        createdAt: stamp,
        updatedAt: stamp,
      })
      .returning({ id: hosting.id })
    await db.insert(hostname).values(
      ['one.example.net', 'two.example.net'].map((name) => ({
        hostingId: site!.id,
        routingOrganizationId: organizationId,
        hostname: name,
        certificate: 'letsencrypt_http',
      }))
    )
    assertEquals((await ensureNameHttpOrders(db, site!.id, organizationId)).length, 2)
    const candidates = async () =>
      (await selectHttpIssuanceCandidates(db, NOW, 25)).map((r) => r.id)
    const pins = await db
      .select({ name: hostname.hostname, tlsId: hostname.tlsId })
      .from(hostname)
      .where(eq(hostname.hostingId, site!.id))
    const rowOf = (name: string) => pins.find((p) => p.name === name)!.tlsId!
    const ids = await candidates()
    assertEquals(ids.includes(rowOf('one.example.net')), true)
    assertEquals(ids.includes(rowOf('two.example.net')), true)
    // A tick scans both new rows (the anchor is pinned too).
    const tick = await runHttpIssuanceSweepTick(
      db,
      {
        registry: {} as never,
        secrets: {} as never,
        env: {},
        now: () => NOW,
        dnsLookup: async () => [],
      },
      { budgetMs: 5_000 }
    )
    assertEquals(tick.scanned >= 3, true)
    // One order is open; the name then moves to another choice and drops its pin.
    const [one] = await db
      .select()
      .from(tls)
      .where(eq(tls.id, rowOf('one.example.net')))
    await db
      .update(tls)
      .set({
        metadata: withHttpIssuanceState(
          one!.metadata as Record<string, unknown>,
          newHttpIssuanceState({
            issuingServerId: 'a',
            requestId: 'req_one',
            startedAt: iso(-60_000),
            startByAt: iso(60_000),
          })
        ),
      })
      .where(eq(tls.id, one!.id))
    await db
      .update(hostname)
      .set({ certificate: 'self_signed', tlsId: null })
      .where(eq(hostname.tlsId, one!.id))
    // The abandoned open order is still picked up, so the sweep can end it.
    const wiring = {
      registry: {} as never,
      secrets: {} as never,
      env: {},
      now: () => NOW,
      dnsLookup: async () => [],
    }
    assertEquals((await candidates()).includes(one!.id), true)
    await runHttpIssuanceSweepTick(db, wiring, { budgetMs: 5_000 })
    const [ended] = await db.select().from(tls).where(eq(tls.id, one!.id))
    assertEquals(readHttpIssuanceState(ended!.metadata)?.endedAt === null, false)
    // Ended and unpinned: nothing left to do, so it is no candidate, holds no issuer and can be removed.
    const after = await candidates()
    assertEquals(after.includes(one!.id), false)
    assertEquals(after.includes(rowOf('two.example.net')), true)
    await db.transaction((tx) =>
      removeUnusedSiteCertificates(tx as never, [one!.id], { reason: 'test' })
    )
    assertEquals((await db.select().from(tls).where(eq(tls.id, one!.id))).length, 0)
    await db.delete(hostname).where(eq(hostname.hostingId, site!.id))
    await db.delete(hosting).where(eq(hosting.id, site!.id))
  } finally {
    await w.cleanup()
  }
})
