/**
 * Retries the Let's Encrypt requests that were waiting for DNS.
 *
 * Runs inside the scheduled surfaces that already exist (the Deno interval that
 * renews organization CA leaves, and the Workers cron), so it adds no timer of
 * its own. A tick looks at a bounded number of waiting hostings, oldest check
 * first; each one repeats the DNS check and pins its certificate as soon as the
 * names point at the server. A pinned certificate is sent to the servers by
 * the same hostings-only apply the button queues (`letsencrypt-apply.ts`),
 * when the tick has a command queue and the secrets the deploy needs; without
 * them, or when the apply cannot be queued, the panel asks for a redeploy.
 */
import { asc, eq, isNotNull, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { hosting } from '../../db/schema.ts'
import { HOSTING_LETS_ENCRYPT_DNS_KEY } from '../../features/hostings/hosting-certificate.ts'
import { type DnsLookup, runtimeDnsLookup } from '../../features/hostings/hosting-dns-check.ts'
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

export async function runHostingLetsEncryptSweepTick(
  db: Db,
  deps: { lookup?: DnsLookup; now?: () => Date; apply?: HostingLetsEncryptSweepApply } = {}
): Promise<HostingLetsEncryptSweepResult> {
  const lookup = deps.lookup ?? runtimeDnsLookup()
  const now = deps.now ?? (() => new Date())
  const store = createLetsEncryptStore(db)
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
    .where(isNotNull(hosting.pendingAt))
    // Never-checked requests first, then the oldest DNS check. A retry that is
    // still waiting stamps a new `checkedAt` (and leaves `updatedAt` alone), so
    // the batch rotates through every waiting hosting.
    .orderBy(
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
  await forEachSequential(rows, async (row) => {
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
      now: now(),
      hosting: { ...row, organizationId },
      acmeEnabled: acmeByOrganization.get(organizationId) === true,
    })
    if (outcome === 'pinned') {
      result.pinned += 1
      if (await sendPin(row.id, organizationId, row.updatedAt)) result.applied += 1
    }
    if (outcome === 'expired' || outcome === 'refused') result.dropped += 1
  })
  // Stored certificates nothing pins any more ride the same tick; a failure
  // here must not hide the result above.
  try {
    await runStoredPairSweepTick(db, deps.now ? { now: deps.now } : {})
  } catch (err) {
    logWarn('tls', `stored certificate sweep failed: ${err instanceof Error ? err.message : err}`)
  }
  await sweepOriginCertificatesToo(db, deps, sendPin)
  return result
}
