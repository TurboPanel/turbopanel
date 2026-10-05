/**
 * Retries the Let's Encrypt requests that were waiting for DNS.
 *
 * Runs inside the scheduled surfaces that already exist (the Deno interval that
 * renews organization CA leaves, and the Workers cron), so it adds no timer of
 * its own. A tick looks at a bounded number of waiting hostings, oldest check
 * first; each one repeats the DNS check and pins its certificate as soon as the
 * names point at the server. Pinning does not deploy: the owner redeploys, and
 * the panel says so.
 */
import { asc, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { hosting } from '../../db/schema.ts'
import { HOSTING_LETS_ENCRYPT_PENDING_KEY } from '../../features/hostings/hosting-certificate.ts'
import { type DnsLookup, runtimeDnsLookup } from '../../features/hostings/hosting-dns-check.ts'
import { retryPendingLetsEncrypt } from '../../features/hostings/use-letsencrypt.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { createLetsEncryptStore, loadAcmeEnabled } from './letsencrypt-store.ts'

/** Waiting hostings looked at per tick (each one costs a DNS lookup or two). */
export const HOSTING_LETS_ENCRYPT_SWEEP_BATCH = 10

export type HostingLetsEncryptSweepResult = {
  scanned: number
  pinned: number
  dropped: number
}

export async function runHostingLetsEncryptSweepTick(
  db: Db,
  deps: { lookup?: DnsLookup; now?: () => Date } = {}
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
    })
    .from(hosting)
    .where(sql`jsonb_exists(${hosting.metadata}, ${HOSTING_LETS_ENCRYPT_PENDING_KEY})`)
    .orderBy(asc(hosting.updatedAt))
    .limit(HOSTING_LETS_ENCRYPT_SWEEP_BATCH)

  const result: HostingLetsEncryptSweepResult = { scanned: rows.length, pinned: 0, dropped: 0 }
  const acmeByOrganization = new Map<string, boolean>()
  await forEachSequential(rows, async (row) => {
    const organizationId = await resolveEntityOrganizationId(db, 'hosting', row.id)
    if (organizationId === null) return
    if (!acmeByOrganization.has(organizationId)) {
      acmeByOrganization.set(organizationId, await loadAcmeEnabled(db, organizationId))
    }
    const outcome = await retryPendingLetsEncrypt({
      store,
      lookup,
      now: now(),
      hosting: { ...row, organizationId },
      acmeEnabled: acmeByOrganization.get(organizationId) === true,
    })
    if (outcome === 'pinned') result.pinned += 1
    if (outcome === 'expired' || outcome === 'refused') result.dropped += 1
  })
  return result
}
