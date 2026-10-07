/**
 * What a PHP site bound to a managed database needs the daemon to deliver.
 *
 * The binding's variables (host, port, user, password, name, URL) ride the
 * site's ordinary variables. The certificate does not: a multi-line value
 * breaks the site's web server, so a daemon that lists `site-db-bindings-v1`
 * is sent the CA as `dbCa` (kept as a file only the site owner's Linux user can
 * read, with `<PREFIX>_CA_FILE` pointing at it) and `requiredEnv` (the settings
 * the site cannot run without, so a value its web server cannot carry stops the
 * deploy instead of leaving the site half configured). An older daemon is sent
 * neither: the site still gets its connection settings and a warning that the
 * certificate cannot be delivered.
 */
import type { Db } from '../../db/connection.ts'
import type { EnvironmentDeploySite } from '../../contracts/commands/schemas.ts'
import {
  type HostSiteBindingNeeds,
  loadHostSiteBindingNeeds,
} from '../../features/bindings/host-run.ts'
import { ensureActiveOrganizationCa } from '../../features/managed/apply-prepare.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import { SITE_DB_BINDINGS_FEATURE } from '../../lib/version-wire.ts'

export type SiteDbBindingsWarning = {
  code: 'site_db_ca_unavailable'
  message: string
  details: { composeServiceName: string }
}

export function siteDbCaUnavailableWarning(composeServiceName: string): SiteDbBindingsWarning {
  return {
    code: 'site_db_ca_unavailable',
    message: `Site "${composeServiceName}" is bound to a managed database, but the TurboPanel daemon on this server is too old to give a PHP site the database's certificate. The site gets its connection settings without it. Update the daemon on this server, then deploy again.`,
    details: { composeServiceName },
  }
}

/** The database reads, injectable so the rules above are testable without one. */
export type SiteDbBindingsDeps = {
  loadNeeds: (db: Db, serviceIds: readonly string[]) => Promise<Map<string, HostSiteBindingNeeds>>
  loadCaPem: (
    db: Db,
    secrets: DerivedSecretsConfig,
    organizationId: string
  ) => Promise<string | undefined>
}

const defaultDeps: SiteDbBindingsDeps = {
  loadNeeds: loadHostSiteBindingNeeds,
  loadCaPem: async (db, secrets, organizationId) => {
    const ca = await ensureActiveOrganizationCa(db, secrets, organizationId)
    return 'kind' in ca ? undefined : ca.trustBundlePem
  },
}

const unique = (names: readonly string[]): string[] => [...new Set(names)]

/**
 * Attach `dbCa` / `requiredEnv` to the sites that have bindings. Sites without
 * a binding, and every site on a daemon without the feature, come back as they
 * were (the latter with a warning).
 */
export async function withSiteDbBindings(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig | undefined,
  params: Readonly<{
    organizationId: string
    sites: readonly EnvironmentDeploySite[]
    serviceRows: readonly { id: string; composeServiceName: string }[]
    daemonFeatures: readonly string[]
    warnings: SiteDbBindingsWarning[]
  }>,
  deps: SiteDbBindingsDeps = defaultDeps
): Promise<EnvironmentDeploySite[]> {
  if (params.sites.length === 0 || !dataEncryptionSecrets) return [...params.sites]
  const idByName = new Map(params.serviceRows.map((row) => [row.composeServiceName, row.id]))
  const needs = await deps.loadNeeds(
    db,
    params.sites.flatMap((site) => idByName.get(site.composeServiceName) ?? [])
  )
  if (needs.size === 0) return [...params.sites]

  const supported = params.daemonFeatures.includes(SITE_DB_BINDINGS_FEATURE)
  const pem = supported
    ? await deps.loadCaPem(db, dataEncryptionSecrets, params.organizationId)
    : undefined

  return params.sites.map((site) => {
    const serviceId = idByName.get(site.composeServiceName)
    const siteNeeds = serviceId === undefined ? undefined : needs.get(serviceId)
    if (!siteNeeds) return site
    if (!supported || pem === undefined) {
      params.warnings.push(siteDbCaUnavailableWarning(site.composeServiceName))
      return site
    }
    return {
      ...site,
      dbCa: { variables: unique(siteNeeds.caFileKeys), pem },
      requiredEnv: unique(siteNeeds.requiredKeys),
    }
  })
}
