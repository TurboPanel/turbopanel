/**
 * Push the hostname list (with every pair) to the co-located daemon, the
 * same request Apply in Admin › Access sends, so a freshly issued DNS-01
 * certificate, or the Platform CA fallback at expiry, reaches Caddy without
 * a click.
 */
import { resolvePublicUrlsApplyPayload } from '../../../../admin/public-urls-apply-payload.ts'
import {
  resolvePublicUrlsForApply,
  waitForPublicUrlsApply,
} from '../../../../admin/routes-helpers.ts'
import { resolveColocatedServerId } from '../../../../client/authn/install-state.ts'
import type { DaemonCellRegistry } from '../../../../contracts/cell.ts'
import type { Db } from '../../../../db/connection.ts'
import { resolveInstanceSecretSealing } from '../../../../features/install/instance-secret-sealing.ts'
import type { DerivedSecretsConfig, SecretsConfig } from '../../../../lib/secrets/secrets.ts'

export type DaemonApplyDeps = {
  registry: DaemonCellRegistry
  secretsConfig: SecretsConfig | undefined
  dataEncryption: DerivedSecretsConfig
  env: Record<string, string | undefined>
}

export async function pushHostnamesToDaemon(db: Db, deps: DaemonApplyDeps): Promise<void> {
  const serverId = await resolveColocatedServerId(db, deps.registry)
  const snapshot = serverId
    ? (await deps.registry.getSnapshots([serverId])).get(serverId)
    : undefined
  if (!serverId || !snapshot?.connected) {
    throw new Error('the daemon on the control plane host is not connected')
  }
  const urls = await resolvePublicUrlsForApply(db, null)
  if (!urls.ok) throw new Error('the public URL list could not be read')
  const sealing = await resolveInstanceSecretSealing(db, serverId, deps.secretsConfig)
  const payload = await resolvePublicUrlsApplyPayload(
    db,
    urls.urls,
    snapshot.daemonBuild?.version,
    deps.dataEncryption,
    deps.env,
    sealing
  )
  const result = await waitForPublicUrlsApply(deps.registry, serverId, payload)
  if (result.kind === 'timeout') throw new Error('the daemon did not answer in time')
  if (result.kind !== 'done') throw new Error(result.error)
}
