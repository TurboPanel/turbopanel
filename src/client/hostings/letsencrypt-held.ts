/**
 * The certificate pre-check for hostings a deploy holds: compose routes that
 * ask for `tls.mode: automatic` (the setup wizard's "Visitors reach it at").
 *
 * The deploy's reconcile pins nothing for such a route and records a waiting
 * request inside its transaction; this runs right after that transaction (the
 * DNS, port 80 and CAA probes never run while it holds locks) and before the
 * deploy reads its hosting rows. It is the same request the Hosting tab's
 * button makes: a name that passes is pinned now and this deploy carries it; a
 * name that fails stays waiting, and the sweep checks it again with a growing
 * wait and sends the certificate out once it passes.
 */

import { inArray } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { hosting } from '../../db/schema.ts'
import { type DnsLookup, runtimeDnsLookup } from '../../features/hostings/hosting-dns-check.ts'
import {
  type CaaLookup,
  type Port80Probe,
  precheckProbes,
} from '../../features/hostings/certificate-precheck.ts'
import { requestLetsEncrypt } from '../../features/hostings/use-letsencrypt.ts'
import { logWarn } from '../../lib/logger.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { createLetsEncryptStore, loadAcmeEnabled } from './letsencrypt-store.ts'

/** Probes and clock for the held pre-check; tests inject them, a deploy uses the runtime's. */
export type HeldLetsEncryptDeps = {
  lookup?: DnsLookup
  /** When `lookup` is injected, only the probes passed here run. */
  caaLookup?: CaaLookup
  port80?: Port80Probe
  now?: () => Date
}

/** Run the pre-check for each held hosting; a failure leaves the request waiting for the sweep. */
export async function precheckHeldLetsEncrypt(
  db: Db,
  organizationId: string,
  hostingIds: readonly string[],
  deps: HeldLetsEncryptDeps = {}
): Promise<void> {
  if (hostingIds.length === 0) return
  const rows = await db
    .select({
      id: hosting.id,
      tlsId: hosting.tlsId,
      options: hosting.options,
      metadata: hosting.metadata,
      pendingAt: hosting.pendingAt,
    })
    .from(hosting)
    .where(inArray(hosting.id, [...hostingIds]))
  const acmeEnabled = await loadAcmeEnabled(db, organizationId)
  const lookup = deps.lookup ?? runtimeDnsLookup()
  const probes = precheckProbes(deps)
  const store = createLetsEncryptStore(db)
  await forEachSequential(rows, async (row) => {
    try {
      await requestLetsEncrypt({
        store,
        lookup,
        probes,
        now: deps.now?.() ?? new Date(),
        hosting: { ...row, organizationId },
        acmeEnabled,
      })
    } catch (err) {
      logWarn(
        'tls',
        `certificate pre-check for hosting ${row.id} failed, the sweep tries again: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  })
}
