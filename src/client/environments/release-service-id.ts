/**
 * Release-tree identity for sourced services (`sites/<id>/`, native systemd
 * units, cron, `siteReleases[]`, ingress rows that share the same service).
 *
 * **Canonical rule:** each environment's TurboPanel **service UUID** for that
 * compose service, carried on `sourceMaterial[].releaseServiceId`. The control
 * plane echoes the same value on `nativeAppServices[].serviceId`,
 * `hostings[].serviceId`, and `ingressServices[].serviceId` for the matching
 * `composeServiceName`. Every consumer resolves the directory segment through
 * {@link resolveDeployReleaseServiceId} — never pick hosting before native or
 * mix sources for one service.
 *
 * **Backward compatibility:** payloads without `releaseServiceId` (older control
 * planes) fall back to `nativeAppServices[].serviceId` when present, then
 * matching `hostings[]` / `ingressServices[]` `serviceId`, then the compose
 * service key. Older daemons ignore `releaseServiceId` and keep that same
 * fallback shape, so nothing breaks mid-rollout.
 *
 * **Legacy directories:** a single-environment site may still live under
 * `sites/<composeServiceName>/`. The daemon's {@link effectiveReleaseServiceId}
 * (turbopaneld twin) keeps serving from that tree until the canonical UUID
 * tree is populated.
 */

/**
 * Charset-safe release-tree segment. Values are environment **service** UUIDs
 * on the wire (`nativeAppServices[].serviceId` uses the same rule).
 */
export const RELEASE_TREE_SERVICE_ID_RE = /^[0-9A-Za-z][0-9A-Za-z_-]{0,63}$/

/**
 * Directory / unit segment for one compose service on the wire.
 *
 * `turboServiceId` is this environment's `service.id` when the row exists.
 */
export function resolveDeployReleaseServiceId(
  composeServiceName: string,
  turboServiceId?: string
): string {
  if (turboServiceId && RELEASE_TREE_SERVICE_ID_RE.test(turboServiceId)) {
    return turboServiceId
  }
  return composeServiceName
}
