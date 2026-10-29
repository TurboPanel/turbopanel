/**
 * The scheduled pass over origin certificates. It rides the sweep that already
 * runs on the Deno interval and the Workers cron (the Let's Encrypt retry tick
 * calls it), so it adds no timer. Per tick at most `ORIGIN_SWEEP_BATCH` rows are
 * handled across all organizations: certificates a site pins that are close to
 * expiry are renewed, retired ones are revoked once nothing pins them (or
 * dropped once expired). Rows that need nothing are not touched, so a quiet
 * instance costs one cheap query. Sites that were re-pinned to a renewed
 * certificate are returned so the caller can queue their hostings-only apply.
 */
import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { tls } from '../../db/schema.ts'
import { logWarn } from '../../lib/logger.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { ORIGIN_SWEEP_BATCH, sweepOriginCertificates } from './origin-certificate.ts'
import { createTunnelAdapterRegistry, type TunnelAdapterRegistry } from './registry.ts'
import { verifyOriginHostnames } from './verify-state.ts'

export type OriginCertificateSweepTick = {
  renewed: number
  removed: number
  failed: number
  /** Sites now pinned to a renewed certificate, with their organization. */
  repinned: { hostingId: string; organizationId: string }[]
}

export async function runOriginCertificateSweepTick(
  db: Db,
  secrets: DerivedSecretsConfig,
  deps: { registry?: TunnelAdapterRegistry; now?: Date; limit?: number } = {}
): Promise<OriginCertificateSweepTick> {
  const out: OriginCertificateSweepTick = { renewed: 0, removed: 0, failed: 0, repinned: [] }
  const orgs = await db
    .selectDistinct({ organizationId: tls.organizationId })
    .from(tls)
    .where(eq(tls.source, 'provider_origin'))
  const registry = deps.registry ?? createTunnelAdapterRegistry()
  let budget = deps.limit ?? ORIGIN_SWEEP_BATCH
  await forEachSequential(orgs, async ({ organizationId }) => {
    if (budget <= 0) return
    try {
      const done = await sweepOriginCertificates({
        db,
        secrets,
        registry,
        organizationId,
        usedHostnames: await verifyOriginHostnames(db, organizationId),
        limit: budget,
        ...(deps.now ? { now: deps.now } : {}),
      })
      budget -= done.renewed.length + done.removed.length + done.failed.length
      out.renewed += done.renewed.length
      out.removed += done.removed.length
      out.failed += done.failed.length
      out.repinned.push(
        ...done.repinnedHostingIds.map((hostingId) => ({ hostingId, organizationId }))
      )
    } catch (err) {
      out.failed += 1
      logWarn('tls', `origin certificate sweep failed: ${err instanceof Error ? err.message : err}`)
    }
  })
  return out
}
