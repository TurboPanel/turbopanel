/**
 * Retries the Let's Encrypt requests that were waiting for DNS.
 *
 * Runs inside the scheduled surfaces that already exist (the Deno interval that
 * renews organization CA leaves, and the Workers cron), so it adds no timer of
 * its own. A tick looks at a bounded number of waiting hostings, the earliest
 * due first; each one repeats the pre-check (DNS, port 80, CAA) and pins its
 * certificate as soon as it passes. A request still waiting after 7 days is
 * dropped, with an audit entry and a notification. A pinned certificate is
 * sent to the servers by the same hostings-only apply the button queues
 * (`letsencrypt-apply.ts`), when the tick has a command queue and the secrets
 * the deploy needs; without them, or when the apply cannot be queued, the
 * panel asks for a redeploy.
 */
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { hosting } from '../../db/schema.ts'
import { HOSTING_LETS_ENCRYPT_DNS_KEY } from '../../features/hostings/hosting-certificate.ts'
import { type DnsLookup, runtimeDnsLookup } from '../../features/hostings/hosting-dns-check.ts'
import {
  type CaaLookup,
  type Port80Probe,
  precheckProbes,
} from '../../features/hostings/certificate-precheck.ts'
import { parseHostingOptions } from '../../features/hostings/hosting-options.ts'
import { recordAudit } from '../../features/audit/audit-records.ts'
import { emitCertificateRequestDropped } from '../../features/notifications/certificate-alerts.ts'
import { settleTunnelOnlyHosting } from '../../features/tunnels/tunnel-only-certificate.ts'
import { retryPendingLetsEncrypt } from '../../features/hostings/use-letsencrypt.ts'
import { logWarn } from '../../lib/logger.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { runStoredPairSweepTick } from '../tls/stored-pair.ts'
import { systemRotationContext } from '../tls/system-context.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import type { DerivedSecretsConfig, SecretsConfig } from '../../lib/secrets/secrets.ts'
import { runOriginCertificateSweepTick } from '../../features/tunnels/origin-certificate-sweep.ts'
import { createLetsEncryptStore, loadAcmeEnabled } from './letsencrypt-store.ts'
import { type HostingApplyDeps, queueHostingCertificateApply } from './letsencrypt-apply.ts'

/** Waiting hostings looked at per tick (each one costs a DNS lookup or two). */
export const HOSTING_LETS_ENCRYPT_SWEEP_BATCH = 10

/** Waiting hostings checked at the same time (each check can wait out a port-80 timeout). */
export const HOSTING_LETS_ENCRYPT_SWEEP_CONCURRENCY = 3

/**
 * The longest the waiting-request part of a tick may run. Rows not started by
 * then wait for the next tick, so a batch of unreachable names never holds up
 * the sweeps queued after this one.
 */
export const HOSTING_LETS_ENCRYPT_SWEEP_DEADLINE_MS = 20_000

export type HostingLetsEncryptSweepResult = {
  scanned: number
  pinned: number
  dropped: number
  /** Pinned certificates whose hostings-only apply was queued. */
  applied: number
}

/** What the tick needs to queue the hostings-only apply for a certificate it pins. */
export type HostingLetsEncryptSweepApply = {
  commandQueue: CommandQueue
  secretsConfig: SecretsConfig | null
  dataEncryptionSecrets: DerivedSecretsConfig | null
  runDeploy?: NonNullable<HostingApplyDeps['runDeploy']>
  daemonFeatures?: NonNullable<HostingApplyDeps['daemonFeatures']>
}

/**
 * Queues the hostings-only apply for a certificate the tick pinned; answers
 * whether it was queued. Without apply deps it never queues.
 */
function pinSender(
  db: Db,
  apply: HostingLetsEncryptSweepApply | undefined
): (hostingId: string, organizationId: string, editedAt: string) => Promise<boolean> {
  if (!apply) return () => Promise.resolve(false)
  const context = systemRotationContext({
    secretsConfig: apply.secretsConfig,
    dataEncryptionSecrets: apply.dataEncryptionSecrets,
  })
  const applyDeps: HostingApplyDeps = {
    commandQueue: apply.commandQueue,
    ...(apply.runDeploy ? { runDeploy: apply.runDeploy } : {}),
    ...(apply.daemonFeatures ? { daemonFeatures: apply.daemonFeatures } : {}),
  }
  return async (hostingId, organizationId, editedAt) =>
    (await queueHostingCertificateApply(
      context,
      db,
      { hostingId, organizationId, actor: { actorType: 'system', actorId: hostingId }, editedAt },
      applyDeps
    )) === 'queued'
}

/**
 * Origin certificates ride the same tick (renew, revoke retired ones, drop
 * expired ones). Needs the data-encryption secrets to open the tokens; without
 * them it does nothing. A site re-pinned to a renewed certificate gets its
 * hostings-only apply, like a newly pinned Let's Encrypt certificate. A failure
 * here must not hide the result of the tick.
 */
async function sweepOriginCertificatesToo(
  db: Db,
  deps: { now?: () => Date; apply?: HostingLetsEncryptSweepApply },
  sendPin: (hostingId: string, organizationId: string, editedAt: string) => Promise<boolean>
): Promise<void> {
  const secrets = deps.apply?.dataEncryptionSecrets
  if (!secrets) return
  try {
    const done = await runOriginCertificateSweepTick(db, secrets, {
      ...(deps.now ? { now: deps.now() } : {}),
    })
    await forEachSequential(done.repinned, async ({ hostingId, organizationId }) => {
      const [site] = await db
        .select({ updatedAt: hosting.updatedAt })
        .from(hosting)
        .where(eq(hosting.id, hostingId))
        .limit(1)
      if (site) await sendPin(hostingId, organizationId, site.updatedAt)
    })
  } catch (err) {
    logWarn('tls', `origin certificate sweep failed: ${err instanceof Error ? err.message : err}`)
  }
}

/**
 * A waiting request that ran out of time goes back to the self-signed
 * certificate; say so in the audit log and in the organization's
 * notifications, so it is not a silent change. Never fails the tick.
 */
async function announceDropped(
  db: Db,
  apply: HostingLetsEncryptSweepApply | undefined,
  row: { id: string; options: unknown; pendingAt: string | null },
  organizationId: string
): Promise<void> {
  const hostnames = parseHostingOptions(row.options)?.hostnames ?? []
  await recordAudit(db, {
    organizationId,
    actorUserId: null,
    action: 'hosting.letsencrypt.dropped',
    targetType: 'hosting',
    targetId: row.id,
    context: { reason: 'dns_not_ready', requestedAt: row.pendingAt, hostnames },
  })
  try {
    await emitCertificateRequestDropped(db, apply?.dataEncryptionSecrets ?? undefined, {
      organizationId,
      hostname: hostnames[0] ?? 'a domain',
    })
  } catch (err) {
    logWarn('tls', `dropped request alert failed: ${err instanceof Error ? err.message : err}`)
  }
}

/**
 * Runs `each` over `items`, at most `limit` at a time, and starts no new item
 * once `stop` has aborted (items already running finish).
 */
export async function forEachBounded<T>(
  items: readonly T[],
  limit: number,
  stop: AbortSignal,
  each: (item: T) => Promise<void>
): Promise<void> {
  let next = 0
  // Each worker takes the next item when its last one settles.
  const worker = async (): Promise<void> => {
    if (next >= items.length || stop.aborted) return
    const item = items[next]!
    next += 1
    await each(item)
    return worker()
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

export async function runHostingLetsEncryptSweepTick(
  db: Db,
  deps: {
    lookup?: DnsLookup
    caaLookup?: CaaLookup
    port80?: Port80Probe
    now?: () => Date
    apply?: HostingLetsEncryptSweepApply
    /** The caller's tick: once it aborts, no further row is started. */
    signal?: AbortSignal
    /** Test seam for {@link HOSTING_LETS_ENCRYPT_SWEEP_DEADLINE_MS}. */
    deadlineMs?: number
  } = {}
): Promise<HostingLetsEncryptSweepResult> {
  const deadline = AbortSignal.timeout(deps.deadlineMs ?? HOSTING_LETS_ENCRYPT_SWEEP_DEADLINE_MS)
  const stop = deps.signal ? AbortSignal.any([deps.signal, deadline]) : deadline
  const lookup = deps.lookup ?? runtimeDnsLookup()
  const probes = precheckProbes(deps)
  const now = deps.now ?? (() => new Date())
  const store = createLetsEncryptStore(db)
  const nextCheckAt = sql`(${hosting.metadata} -> ${HOSTING_LETS_ENCRYPT_DNS_KEY}::text ->> 'nextCheckAt')`
  const rows = await db
    .select({
      id: hosting.id,
      tlsId: hosting.tlsId,
      options: hosting.options,
      metadata: hosting.metadata,
      pendingAt: hosting.pendingAt,
      updatedAt: hosting.updatedAt,
    })
    .from(hosting)
    // Only requests whose next check is due (ISO times compare as text). Each
    // miss doubles the wait, from 5 minutes up to an hour.
    .where(
      and(
        isNotNull(hosting.pendingAt),
        sql`(${nextCheckAt} is null or ${nextCheckAt} <= ${now().toISOString()})`
      )
    )
    // Never-checked requests first, then the earliest due. A retry that is
    // still waiting stamps a new `nextCheckAt` (and leaves `updatedAt` alone),
    // so the batch rotates through every waiting hosting.
    .orderBy(
      sql`${nextCheckAt} asc nulls first`,
      sql`(${hosting.metadata} -> ${HOSTING_LETS_ENCRYPT_DNS_KEY}::text ->> 'checkedAt') asc nulls first`,
      asc(hosting.id)
    )
    .limit(HOSTING_LETS_ENCRYPT_SWEEP_BATCH)

  const result: HostingLetsEncryptSweepResult = {
    scanned: rows.length,
    pinned: 0,
    dropped: 0,
    applied: 0,
  }
  const sendPin = pinSender(db, deps.apply)
  const acmeByOrganization = new Map<string, boolean>()
  await forEachBounded(rows, HOSTING_LETS_ENCRYPT_SWEEP_CONCURRENCY, stop, async (row) => {
    const organizationId = await resolveEntityOrganizationId(db, 'hosting', row.id)
    if (organizationId === null) return
    if (!acmeByOrganization.has(organizationId)) {
      acmeByOrganization.set(organizationId, await loadAcmeEnabled(db, organizationId))
    }
    // A request waiting on a name that has since become tunnel-only is dropped.
    if (await settleTunnelOnlyHosting(db, { organizationId, hostingId: row.id })) {
      result.dropped += 1
      return
    }
    const outcome = await retryPendingLetsEncrypt({
      store,
      lookup,
      probes,
      now: now(),
      hosting: { ...row, organizationId },
      acmeEnabled: acmeByOrganization.get(organizationId) === true,
    })
    if (outcome === 'expired') await announceDropped(db, deps.apply, row, organizationId)
    if (outcome === 'pinned') {
      result.pinned += 1
      if (await sendPin(row.id, organizationId, row.updatedAt)) result.applied += 1
    }
    if (outcome === 'expired' || outcome === 'refused') result.dropped += 1
  })
  // Stored certificates nothing pins any more ride the same tick; a failure
  // here must not hide the result above. Nothing more starts once the caller's
  // tick has ended.
  if (deps.signal?.aborted) return result
  try {
    await runStoredPairSweepTick(db, deps.now ? { now: deps.now } : {})
  } catch (err) {
    logWarn('tls', `stored certificate sweep failed: ${err instanceof Error ? err.message : err}`)
  }
  await sweepOriginCertificatesToo(db, deps, sendPin)
  return result
}
