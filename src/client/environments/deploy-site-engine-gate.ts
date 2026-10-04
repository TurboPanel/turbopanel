/**
 * An `nginx+apache` site, or any `backendPort`, only goes to a daemon that
 * advertises `site-engine-nginx-apache-v1`. An older daemon would refuse the
 * whole environment deploy at parse time, so the panel refuses first, naming
 * the site, and nothing is sent.
 */
import type { Db } from '../../db/connection.ts'
import type { EnvironmentDeploySite } from '../../contracts/commands/schemas.ts'
import { getServerDaemonStateByServerId } from '../../features/servers/server-identity-db.ts'

export const SITE_ENGINE_NGINX_APACHE_FEATURE = 'site-engine-nginx-apache-v1'

export type SiteEngineFeatureError = {
  kind: 'site_engine_feature_missing'
  composeServiceName: string
}

function needsFeature(site: Pick<EnvironmentDeploySite, 'engine' | 'backendPort'>): boolean {
  return site.engine === 'nginx+apache' || site.backendPort !== undefined
}

/** Pure check: the first site that needs the feature the daemon lacks. */
export function siteNeedingEngineFeature(
  sites: readonly Pick<EnvironmentDeploySite, 'composeServiceName' | 'engine' | 'backendPort'>[],
  features: readonly string[]
): SiteEngineFeatureError | undefined {
  if (features.includes(SITE_ENGINE_NGINX_APACHE_FEATURE)) return undefined
  const site = sites.find(needsFeature)
  return site
    ? { kind: 'site_engine_feature_missing', composeServiceName: site.composeServiceName }
    : undefined
}

/** Looks the daemon up only when a site needs the feature. */
export async function withSiteEngineFeature(
  db: Db,
  serverId: string,
  sites: readonly Pick<EnvironmentDeploySite, 'composeServiceName' | 'engine' | 'backendPort'>[],
  loadFeatures: (db: Db, serverId: string) => Promise<readonly string[]> = loadDaemonFeatures
): Promise<SiteEngineFeatureError | { ok: true }> {
  if (!sites.some(needsFeature)) return { ok: true }
  const missing = siteNeedingEngineFeature(sites, await loadFeatures(db, serverId))
  return missing ?? { ok: true }
}

async function loadDaemonFeatures(db: Db, serverId: string): Promise<readonly string[]> {
  const state = await getServerDaemonStateByServerId(db, serverId)
  return state?.projection?.features ?? []
}
