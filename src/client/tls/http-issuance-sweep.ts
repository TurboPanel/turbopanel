/**
 * The periodic step of server-placed certificate orders: each minute, on both
 * runtimes, a bounded batch of library rows is moved on. An open request is
 * advanced (the order goes out once the helpers answered, or the attempt is
 * given up on silence), a finished pair is handed to the serving servers, and a
 * row that needs a first certificate, or whose own certificate is two thirds
 * through its life, gets a new request. No timer of its own: it runs inside
 * the Workers cron and the Deno interval that already exist.
 */
import { and, asc, eq, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import { tls } from '../../db/schema.ts'
import { isServerConnected } from '../../daemon/cell/server-status.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import { runtimeDnsLookup } from '../../features/hostings/hosting-dns-check.ts'
import { resolveInstanceAcmeSettings } from '../../features/install/instance-acme-settings.ts'
import { getServerDaemonStateByServerId } from '../../features/servers/server-identity-db.ts'
import {
  advanceHttpIssuance,
  deliverIssuedPair,
  type HttpIssuanceDeps,
  startHttpIssuance,
} from '../../features/tls/http-issuance/orchestrator.ts'
import { renewalDue } from '../../features/tls/http-issuance/progress.ts'
import { readHttpIssuanceState } from '../../features/tls/http-issuance/state.ts'
import { logWarn } from '../../lib/logger.ts'
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
    contact: async () => {
      const settings = await resolveInstanceAcmeSettings(db, wiring.env)
      return { contactEmail: settings.contactEmail, staging: settings.useStaging }
    },
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
        sql`(
          (${h} is null and ${tls.privateKeyPem} is null)
          or (${h} is not null and ${h} ->> 'endedAt' is null)
          or (${h} ->> 'phase' = 'issued' and (${h} ->> 'deliveredAt' is null or ${h} ->> 'renewAt' <= ${at}))
          or (${h} ->> 'phase' = 'failed' and (${h} ->> 'nextAttemptAt' is null or ${h} ->> 'nextAttemptAt' <= ${at}))
        )`
      )
    )
    .orderBy(asc(tls.updatedAt), asc(tls.id))
    .limit(limit)
}

type Candidate = Awaited<ReturnType<typeof selectHttpIssuanceCandidates>>[number]

async function stepRow(
  deps: HttpIssuanceDeps,
  row: Candidate,
  push: ((tlsId: string, organizationId: string) => Promise<void>) | null,
  now: Date,
  out: HttpIssuanceSweepResult
): Promise<void> {
  const state = readHttpIssuanceState(row.metadata)
  if (state && state.endedAt === null) {
    await advanceHttpIssuance(deps, row.id)
    out.advanced += 1
    return
  }
  if (state?.phase === 'issued' && state.deliveredAt === null) {
    if ((await deliverIssuedPair(deps, row.id, push)) === 'delivered') out.delivered += 1
    return
  }
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
  for (const row of rows) {
    if (Date.now() - startedAt > budgetMs) break
    try {
      await stepRow(deps, row, push, now, out)
    } catch (err) {
      logWarn('tls', `server-placed certificate step failed for ${row.id}: ${String(err)}`)
    }
  }
  return out
}
