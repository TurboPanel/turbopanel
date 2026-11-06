/**
 * The pieces the DNS-validated certificate work needs outside a request: the
 * provider adapters and DNS hosts, and the push that refreshes the sites
 * pinning a renewed certificate. The sweeps and the routes build one the same
 * way.
 */
import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { hosting } from '../../db/schema.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import type { DnsCertContext } from '../../features/tls/dns-certificates/context.ts'
import { createCloudflareDnsChallenge } from '../../features/tunnels/cloudflare-dns-challenge.ts'
import { createTunnelAdapterRegistry } from '../../features/tunnels/registry.ts'
import { logWarn } from '../../lib/logger.ts'
import type { DerivedSecretsConfig, SecretsConfig } from '../../lib/secrets/secrets.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { queueHostingCertificateApply } from '../hostings/letsencrypt-apply.ts'
import { systemRotationContext } from './system-context.ts'

export type DnsCertWiring = {
  secrets: DerivedSecretsConfig
  /** With these a renewed certificate is sent to its sites at once; without, the next deploy carries it. */
  push?: { commandQueue: CommandQueue; secretsConfig: SecretsConfig | null }
  fetch?: typeof fetch
  acmeFetch?: typeof fetch
  presentGraceMs?: number
}

/** Send a renewed certificate to every site that pins it, by the same apply a pick in the library queues. */
export function renewalPusher(db: Db, wiring: Required<Pick<DnsCertWiring, 'push' | 'secrets'>>) {
  const context = systemRotationContext({
    secretsConfig: wiring.push.secretsConfig,
    dataEncryptionSecrets: wiring.secrets,
  })
  return async (tlsId: string, organizationId: string): Promise<void> => {
    const sites = await db
      .select({ id: hosting.id, updatedAt: hosting.updatedAt })
      .from(hosting)
      .where(eq(hosting.tlsId, tlsId))
    await forEachSequential(sites, async (site) => {
      const outcome = await queueHostingCertificateApply(
        context,
        db,
        {
          hostingId: site.id,
          organizationId,
          actor: { actorType: 'system', actorId: site.id },
          editedAt: site.updatedAt,
        },
        { commandQueue: wiring.push.commandQueue }
      )
      if (outcome !== 'queued') {
        logWarn(
          'tls',
          `renewed certificate ${tlsId}: site ${site.id} will get it on its next deploy (${outcome})`
        )
      }
    })
  }
}

export function buildDnsCertContext(db: Db, wiring: DnsCertWiring): DnsCertContext {
  const { fetch: providerFetch, acmeFetch } = wiring
  return {
    db,
    secrets: wiring.secrets,
    adapters: createTunnelAdapterRegistry(providerFetch),
    dns: (_provider, token) => createCloudflareDnsChallenge({ token, fetch: providerFetch }),
    ...(acmeFetch ? { acmeFetch } : {}),
    ...(wiring.presentGraceMs === undefined ? {} : { presentGraceMs: wiring.presentGraceMs }),
    ...(wiring.push
      ? { onRenewed: renewalPusher(db, { push: wiring.push, secrets: wiring.secrets }) }
      : {}),
  }
}
