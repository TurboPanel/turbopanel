/**
 * The periodic step of server-placed certificate orders: each minute, on both
 * runtimes, a bounded batch of library rows is moved on. An open request is
 * advanced (the order goes out once the helpers answered, or the attempt is
 * given up on silence), a finished pair is handed to the serving servers, and a
 * row that needs a first certificate, or whose own certificate is two thirds
 * through its life, gets a new request. No timer of its own: it runs inside
 * the Workers cron and the Deno interval that already exist.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import { hosting, tls } from '../../db/schema.ts'
import { isServerConnected } from '../../daemon/cell/server-status.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import { runtimeDnsLookup } from '../../features/hostings/hosting-dns-check.ts'
import { organizationAcmeContactEmail } from '../../features/organizations/acme-contact-email.ts'
import { getServerDaemonStateByServerId } from '../../features/servers/server-identity-db.ts'
import {
  advanceHttpIssuance,
  deliverIssuedPair,
  sendPendingEnds,
  type HttpIssuanceDeps,
  startHttpIssuance,
} from '../../features/tls/http-issuance/orchestrator.ts'
import { renewalDue } from '../../features/tls/http-issuance/progress.ts'
import { readHttpIssuanceState } from '../../features/tls/http-issuance/state.ts'
import { logWarn } from '../../lib/logger.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import type { DerivedSecretsConfig, SecretsConfig } from '../../lib/secrets/secrets.ts'
import { renewalPusher } from './dns-certificate-context.ts'

/** Rows moved on per tick; the rest wait for the next minute. */
export const HTTP_ISSUANCE_SWEEP_BATCH = 25
/** After this long a tick starts no new row. */
export const HTTP_ISSUANCE_SWEEP_BUDGET_MS = 20_000
/** How long an unread message stays in a server's outbox before it is dropped. */
export const HTTP_ISSUANCE_SEND_TTL_SECONDS = 300

export type HttpIssuanceSweepWiring = {
  registry: DaemonCellRegistry
  /** With these a finished pair is sent to its sites at once; without, the next deploy carries it. */
  push?: { commandQueue: CommandQueue; secretsConfig: SecretsConfig | null }
  secrets: DerivedSecretsConfig
  env: Record<string, string | undefined>
  now?: () => Date
  dnsLookup?: HttpIssuanceDeps['dnsLookup']
}

export type HttpIssuanceSweepResult = {
  scanned: number
  advanced: number
  started: number
  delivered: number
}

/**
 * The platform switch for the whole flow: `TURBOPANEL_SHARED_CERTIFICATES=off` makes the
 * sweep do nothing (open requests are left to time out, nothing new starts). On by default.
 */
export function httpIssuanceEnabled(env: Record<string, string | undefined>): boolean {
  return (env.TURBOPANEL_SHARED_CERTIFICATES ?? '').trim().toLowerCase() !== 'off'
}

/** Order from the authority's test directory when the platform says so (`TURBOPANEL_ACME_STAGING=true`). */
export function httpIssuanceStaging(env: Record<string, string | undefined>): boolean {
  return (env.TURBOPANEL_ACME_STAGING ?? '').trim().toLowerCase() === 'true'
}

/** The orchestrator's seams, wired to the real cells, presence and settings. */
export function buildHttpIssuanceDeps(db: Db, wiring: HttpIssuanceSweepWiring): HttpIssuanceDeps {
  return {
    db,
    ...(wiring.now ? { now: wiring.now } : {}),
    send: async (serverId, envelope) => {
      await wiring.registry
        .getCell(serverId)
        .enqueue(envelope, { ttlSeconds: HTTP_ISSUANCE_SEND_TTL_SECONDS })
    },
    dnsLookup: wiring.dnsLookup ?? runtimeDnsLookup(),
    isOnline: (serverId) => isServerConnected(db, wiring.registry, serverId),
    daemonFeatures: async (serverId) =>
      (await getServerDaemonStateByServerId(db, serverId))?.projection?.features ?? [],
    contactEmail: (organizationId) => organizationAcmeContactEmail(db, organizationId),
    staging: httpIssuanceStaging(wiring.env),
  }
}

/**
 * Rows this flow may have work for right now: an automatic row with no
 * certificate yet, an open request, a finished pair not yet handed out or due
 * for renewal, and a failed attempt whose wait is over. A row a server's own
 * web server captured (a pair, no request) is left to that server. Times are
 * ISO text from `toISOString`, so comparing them as text is comparing them in time.
 */
export function selectHttpIssuanceCandidates(db: Db, now: Date, limit: number) {
  const at = now.toISOString()
  const h = sql`${tls.metadata} -> 'httpCert'`
  const central = sql`${h} ->> 'centralPair' = 'true'`
  const renewDue = sql`(${central} and coalesce(${h} ->> 'renewAt', '') <= ${at})`
  // Work already begun comes first, so an open request is advanced and a finished pair
  // delivered every minute however many rows are waiting. The rest rotate by a hash that
  // changes each minute: every waiting row gets its turn and nothing is written to them.
  const minute = Math.floor(now.getTime() / 60_000)
  const begun = sql`(${h} is not null and (
    ${h} ->> 'endedAt' is null
    or (${h} ->> 'phase' = 'issued' and ${h} ->> 'deliveredAt' is null)
    or (${h} ->> 'endedAt' is not null and ${h} ->> 'endsSentAt' is null
        and jsonb_array_length(coalesce(${h} -> 'forwards', '[]'::jsonb)) > 0)
  ))`
  return db
    .select({
      id: tls.id,
      metadata: tls.metadata,
      organizationId: tls.organizationId,
    })
    .from(tls)
    .where(
      and(
        eq(tls.source, 'lets_encrypt'),
        eq(tls.status, 'automatic'),
        // Only a row that a site pins, with exactly one name, and never a wildcard (that is the connected DNS host's).
        sql`exists (select 1 from ${hosting} where ${hosting.tlsId} = ${tls.id})`,
        sql`jsonb_array_length(coalesce(${tls.metadata} -> 'dnsNames', '[]'::jsonb)) = 1`,
        sql`not exists (
          select 1 from jsonb_array_elements_text(coalesce(${tls.metadata} -> 'dnsNames', '[]'::jsonb)) as n
          where n like '*%'
        )`,
        sql`(
          (${h} is null and ${tls.privateKeyPem} is null)
          or (${h} is not null and ${h} ->> 'endedAt' is null)
          or (${h} ->> 'phase' = 'issued' and (${h} ->> 'deliveredAt' is null or ${renewDue}))
          or (${h} ->> 'phase' = 'failed' and (${h} ->> 'nextAttemptAt' is null or ${h} ->> 'nextAttemptAt' <= ${at})
              and (${tls.privateKeyPem} is null or ${renewDue}))
          or (${h} ->> 'endedAt' is not null and ${h} ->> 'endsSentAt' is null
              and jsonb_array_length(coalesce(${h} -> 'forwards', '[]'::jsonb)) > 0)
        )`
      )
    )
    .orderBy(
      sql`case when ${begun} then 0 else 1 end`,
      sql`md5(${tls.id}::text || ${String(minute)})`
    )
    .limit(limit)
}

type Candidate = Awaited<ReturnType<typeof selectHttpIssuanceCandidates>>[number]

/** New orders begun in one tick, so a first run after a rollout is gradual. */
export const HTTP_ISSUANCE_STARTS_PER_TICK = 3

async function stepRow(
  deps: HttpIssuanceDeps,
  row: Candidate,
  step: {
    push: ((tlsId: string, organizationId: string) => Promise<void>) | null
    now: Date
    out: HttpIssuanceSweepResult
    startsLeft: number
  }
): Promise<void> {
  const { out, now } = step
  const state = readHttpIssuanceState(row.metadata)
  if (state?.endedAt === null) {
    await advanceHttpIssuance(deps, row.id)
    out.advanced += 1
    return
  }
  if (state?.phase === 'issued' && state.deliveredAt === null) {
    if ((await deliverIssuedPair(deps, row.id, step.push)) === 'delivered') out.delivered += 1
    return
  }
  if (state?.endedAt && state.endsSentAt === null && state.forwards.length > 0) {
    await sendPendingEnds(deps, row.id)
  }
  if (step.startsLeft <= 0) return
  const outcome = await startHttpIssuance(deps, row.id, (facts) =>
    facts.hasPair ? renewalDue(state, now) : true
  )
  if (outcome === 'started' || outcome === 'ordering') out.started += 1
}

export async function runHttpIssuanceSweepTick(
  db: Db,
  wiring: HttpIssuanceSweepWiring,
  options: { batch?: number; budgetMs?: number } = {}
): Promise<HttpIssuanceSweepResult> {
  if (!httpIssuanceEnabled(wiring.env)) return { scanned: 0, advanced: 0, started: 0, delivered: 0 }
  const startedAt = Date.now()
  const now = (wiring.now ?? (() => new Date()))()
  const deps = buildHttpIssuanceDeps(db, wiring)
  const push = wiring.push
    ? renewalPusher(db, { push: wiring.push, secrets: wiring.secrets })
    : null
  const rows = await selectHttpIssuanceCandidates(
    db,
    now,
    options.batch ?? HTTP_ISSUANCE_SWEEP_BATCH
  )
  const out: HttpIssuanceSweepResult = {
    scanned: rows.length,
    advanced: 0,
    started: 0,
    delivered: 0,
  }
  const budgetMs = options.budgetMs ?? HTTP_ISSUANCE_SWEEP_BUDGET_MS
  // Rows not started inside the budget simply wait for the next minute.
  await forEachSequential(rows, async (row) => {
    if (Date.now() - startedAt > budgetMs) return
    try {
      const startsLeft = HTTP_ISSUANCE_STARTS_PER_TICK - out.started
      await stepRow(deps, row, { push, now, out, startsLeft })
    } catch (err) {
      logWarn('tls', `server-placed certificate step failed for ${row.id}: ${String(err)}`)
    }
  })
  return out
}
