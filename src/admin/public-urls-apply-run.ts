/**
 * Context-free pieces of the public-URL apply: the payload (with the edge
 * address ranges) and a whole apply to the co-located daemon, so the admin
 * route and the self-hosted maintenance tick send the same body. The tick
 * sends only when the body differs from the one last applied, so a field a
 * new build adds (such as `publicPort`) reaches the daemon once after an
 * upgrade without anyone pressing Save.
 */

import type { Db } from '../db/connection.ts'
import type { DaemonCellRegistry } from '../contracts/cell.ts'
import type { DerivedSecretsConfig, SecretsConfig } from '../lib/secrets/secrets.ts'
import { resolveColocatedServerId } from '../client/authn/install-state.ts'
import { resolveInstanceSecretSealing } from '../features/install/instance-secret-sealing.ts'
import {
  clearInstalledCertificateErrors,
  listInstanceHostnames,
} from '../features/install/instance-hostnames.ts'
import { getPublicUrls } from '../features/install/public-urls.ts'
import {
  EDGE_TRUST_FEATURE,
  loadEdgeTrustState,
  markPublicUrlsApplied,
  resolveEdgeTrustForServer,
  sha256Hex,
} from '../features/install/edge-trust.ts'
import { INSTANCE_HOSTNAME_PUBLIC_PORT_FEATURE } from '../lib/version-wire.ts'
import {
  colocatedDaemonFeatures,
  resolvePublicUrlsApplyPayload,
} from './public-urls-apply-payload.ts'
import {
  waitForPublicUrlsApply,
  type PublicUrlsApplyPayload,
  type PublicUrlsApplyWaitResult,
} from './routes-helpers.ts'

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
    sealing,
    { daemonFeatures: await colocatedDaemonFeatures(deps.db, deps.serverId) }
  )
  const modes = (await listInstanceHostnames(deps.db)).map((row) => row.mode)
  const edgeTrust = await resolveEdgeTrustForServer(deps.db, deps.serverId, modes)
  return edgeTrust ? { ...payload, edgeTrust } : payload
}

/**
 * Identifies what the daemon renders from a body. Key material is left out:
 * a sealed key is new on every build, so hashing it would resend forever.
 */
export async function publicUrlsPayloadFingerprint(
  payload: PublicUrlsApplyPayload
): Promise<string> {
  const hostnames =
    payload.hostnames?.map((entry) => [
      entry.host,
      entry.source,
      entry.publicPort ?? null,
      entry.uploadedCertId ?? null,
      entry.certPem ?? null,
    ]) ?? null
  return sha256Hex(
    JSON.stringify([
      payload.urls,
      hostnames,
      payload.instanceAcme ?? null,
      payload.edgeTrust?.hash ?? null,
    ])
  )
}

/**
 * Record that the daemon rendered this body, once the apply succeeded, and
 * clear the "not loaded yet" error of each certificate it carried.
 */
export async function recordPublicUrlsApplied(
  db: Db,
  payload: PublicUrlsApplyPayload
): Promise<void> {
  await clearInstalledCertificateErrors(db, payload.hostnames)
  await markPublicUrlsApplied(
    db,
    {
      payloadHash: await publicUrlsPayloadFingerprint(payload),
      ...(payload.edgeTrust ? { edgeTrustHash: payload.edgeTrust.hash } : {}),
    },
    new Date()
  )
}

/**
 * Send `payload` unless it matches the body the daemon last applied.
 * Returns whether it was sent.
 */
export async function applyPublicUrlsIfChanged(
  db: Db,
  payload: PublicUrlsApplyPayload,
  send: (payload: PublicUrlsApplyPayload) => Promise<PublicUrlsApplyWaitResult>
): Promise<boolean> {
  const hash = await publicUrlsPayloadFingerprint(payload)
  if ((await loadEdgeTrustState(db)).appliedPayloadHash === hash) {
    // The daemon already rendered this body, so its certificates are loaded.
    await clearInstalledCertificateErrors(db, payload.hostnames)
    return false
  }
  const result = await send(payload)
  if (result.kind !== 'done') {
    throw new Error(result.kind === 'timeout' ? 'apply timed out' : result.error)
  }
  await recordPublicUrlsApplied(db, payload)
  return true
}

/** Wire features whose fields only reach a daemon through a fresh apply. */
const REAPPLY_FEATURES: readonly string[] = [
  EDGE_TRUST_FEATURE,
  INSTANCE_HOSTNAME_PUBLIC_PORT_FEATURE,
]

/**
 * Apply the stored hostnames, with current edge ranges, to the co-located
 * daemon when the body changed since the last apply.
 */
export async function applyStoredPublicUrls(
  deps: Omit<PublicUrlsPayloadDeps, 'serverId' | 'urls' | 'daemonVersion'> & {
    registry: DaemonCellRegistry
  }
): Promise<void> {
  const serverId = await resolveColocatedServerId(deps.db, deps.registry)
  if (!serverId) throw new Error('no co-located daemon connected')
  const snapshot = (await deps.registry.getSnapshots([serverId])).get(serverId)
  // The tick runs every few minutes: a daemon that is down gets the body on
  // the first pass after it reconnects.
  if (!snapshot?.connected) return
  // An older daemon has nothing new to render: skip the payload (and any key
  // resealing) and leave the stored hash alone so the first tick after it
  // upgrades does the apply.
  const features = await colocatedDaemonFeatures(deps.db, serverId)
  if (!REAPPLY_FEATURES.some((feature) => features.includes(feature))) return
  // Nothing is published before install finishes; never send an empty list.
  const urls = await getPublicUrls(deps.db)
  if (urls.length === 0) return
  const payload = await buildPublicUrlsPayload({
    ...deps,
    serverId,
    urls,
    daemonVersion: snapshot.daemonBuild?.version,
  })
  await applyPublicUrlsIfChanged(deps.db, payload, (body) =>
    waitForPublicUrlsApply(deps.registry, serverId, body)
  )
}
