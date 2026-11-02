/**
 * Context-free pieces of the public-URL apply: the payload (with the edge
 * address ranges) and a whole apply to the co-located daemon, so the admin
 * route and the self-hosted refresh tick send the same body.
 */

import type { Db } from '../db/connection.ts'
import type { DaemonCellRegistry } from '../contracts/cell.ts'
import type { DerivedSecretsConfig, SecretsConfig } from '../lib/secrets/secrets.ts'
import { resolveColocatedServerId } from '../client/authn/install-state.ts'
import { resolveInstanceSecretSealing } from '../features/install/instance-secret-sealing.ts'
import { listInstanceHostnames } from '../features/install/instance-hostnames.ts'
import { getPublicUrls } from '../features/install/public-urls.ts'
import { markEdgeTrustApplied, resolveEdgeTrustForServer } from '../features/install/edge-trust.ts'
import { resolvePublicUrlsApplyPayload } from './public-urls-apply-payload.ts'
import { waitForPublicUrlsApply, type PublicUrlsApplyPayload } from './routes-helpers.ts'

export type PublicUrlsPayloadDeps = {
  db: Db
  serverId: string
  urls: string[]
  daemonVersion: string | undefined
  secretsConfig: SecretsConfig | undefined
  dataEncryptionSecrets: DerivedSecretsConfig | undefined
  env: Record<string, string | undefined>
}

/** The apply body, plus `edgeTrust` when the daemon advertises it. */
export async function buildPublicUrlsPayload(
  deps: PublicUrlsPayloadDeps
): Promise<PublicUrlsApplyPayload> {
  const sealing = await resolveInstanceSecretSealing(deps.db, deps.serverId, deps.secretsConfig)
  const payload = await resolvePublicUrlsApplyPayload(
    deps.db,
    deps.urls,
    deps.daemonVersion,
    deps.dataEncryptionSecrets,
    deps.env,
    sealing
  )
  const modes = (await listInstanceHostnames(deps.db)).map((row) => row.mode)
  const edgeTrust = await resolveEdgeTrustForServer(deps.db, deps.serverId, modes)
  return edgeTrust ? { ...payload, edgeTrust } : payload
}

/** Record that the daemon rendered this set, once the apply succeeded. */
export async function recordEdgeTrustApplied(
  db: Db,
  payload: PublicUrlsApplyPayload
): Promise<void> {
  if (payload.edgeTrust) await markEdgeTrustApplied(db, payload.edgeTrust.hash, new Date())
}

/** Apply the stored hostnames, with current edge ranges, to the co-located daemon. */
export async function applyStoredPublicUrls(
  deps: Omit<PublicUrlsPayloadDeps, 'serverId' | 'urls' | 'daemonVersion'> & {
    registry: DaemonCellRegistry
  }
): Promise<void> {
  const serverId = await resolveColocatedServerId(deps.db, deps.registry)
  if (!serverId) throw new Error('no co-located daemon connected')
  const snapshot = (await deps.registry.getSnapshots([serverId])).get(serverId)
  if (!snapshot?.connected) throw new Error('co-located daemon disconnected')
  // A daemon that does not advertise the feature has nothing to render: skip
  // the payload (and any key resealing) and leave `appliedHash` unset so the
  // first tick after it upgrades does the apply.
  const modes = (await listInstanceHostnames(deps.db)).map((row) => row.mode)
  if (!(await resolveEdgeTrustForServer(deps.db, serverId, modes))) return
  const payload = await buildPublicUrlsPayload({
    ...deps,
    serverId,
    urls: await getPublicUrls(deps.db),
    daemonVersion: snapshot.daemonBuild?.version,
  })
  if (!payload.edgeTrust) return
  const result = await waitForPublicUrlsApply(deps.registry, serverId, payload)
  if (result.kind !== 'done') {
    throw new Error(result.kind === 'timeout' ? 'apply timed out' : result.error)
  }
  await recordEdgeTrustApplied(deps.db, payload)
}
