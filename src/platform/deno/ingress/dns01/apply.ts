/**
 * Push the hostname list (with every pair) to the co-located daemon, the
 * same body Apply in Admin › Access and the maintenance tick send (edge
 * ranges included), so a freshly issued DNS-01 certificate, or the Platform
 * CA fallback at expiry, reaches Caddy without a click and without dropping
 * the edge trust ranges.
 */
import {
  buildPublicUrlsPayload,
  recordPublicUrlsApplied,
} from '../../../../admin/public-urls-apply-run.ts'
import {
  resolvePublicUrlsForApply,
  waitForPublicUrlsApply,
} from '../../../../admin/routes-helpers.ts'
import { resolveColocatedServerId } from '../../../../client/authn/install-state.ts'
import type { DaemonCellRegistry } from '../../../../contracts/cell.ts'
import type { Db } from '../../../../db/connection.ts'
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
  await pushHostnamesToServer(db, deps, serverId, snapshot.daemonBuild?.version)
}

/**
 * Build the shared apply body for `serverId`, send it, and record what the
 * daemon rendered (body fingerprint and edge set) the way a Save does.
 */
async function pushHostnamesToServer(
  db: Db,
  deps: DaemonApplyDeps,
  serverId: string,
  daemonVersion: string | undefined
): Promise<void> {
  const urls = await resolvePublicUrlsForApply(db, null)
  if (!urls.ok) throw new Error('the public URL list could not be read')
  const payload = await buildPublicUrlsPayload({
    db,
    serverId,
    urls: urls.urls,
    daemonVersion,
    secretsConfig: deps.secretsConfig,
    dataEncryptionSecrets: deps.dataEncryption,
    env: deps.env,
  })
  const result = await waitForPublicUrlsApply(deps.registry, serverId, payload)
  if (result.kind === 'timeout') throw new Error('the daemon did not answer in time')
  if (result.kind !== 'done') throw new Error(result.error)
  await recordPublicUrlsApplied(db, payload)
}
