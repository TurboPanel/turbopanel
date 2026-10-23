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
import { inArray } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { hosting } from '../../db/schema.ts'
import { readHostnames } from './deploy-routes-helpers.ts'
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

/** Refusal for a bound site that has no hostname: its variables ride the hostname's hosting. */
export type SiteDbBindingsError = {
  kind: 'binding_host_site_unsupported'
  message: string
}

export function siteNeedsHostnameError(composeServiceName: string): SiteDbBindingsError {
  return {
    kind: 'binding_host_site_unsupported',
    message: `Site "${composeServiceName}" is bound to a managed database but has no hostname. A site gets its database settings through its hostname, so add a hostname to the site, then deploy again.`,
  }
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
  /** Ids of the services that have at least one hosting with a hostname. */
  loadHostedServiceIds: (db: Db, serviceIds: readonly string[]) => Promise<Set<string>>
  loadCaPem: (
    db: Db,
    secrets: DerivedSecretsConfig,
    organizationId: string
  ) => Promise<string | undefined>
}

/** Ids of the given services that have at least one hosting with a hostname. */
export async function loadHostedServiceIds(
  db: Db,
  serviceIds: readonly string[]
): Promise<Set<string>> {
  if (serviceIds.length === 0) return new Set()
  const rows = await db
    .select({ serviceId: hosting.serviceId, options: hosting.options })
    .from(hosting)
    .where(inArray(hosting.serviceId, [...serviceIds]))
  return new Set(
    rows.filter((row) => readHostnames(row.options).length > 0).map((row) => row.serviceId)
  )
}

const defaultDeps: SiteDbBindingsDeps = {
  loadNeeds: loadHostSiteBindingNeeds,
  loadHostedServiceIds,
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
): Promise<EnvironmentDeploySite[] | SiteDbBindingsError> {
  if (params.sites.length === 0 || !dataEncryptionSecrets) return [...params.sites]
  const idByName = new Map(params.serviceRows.map((row) => [row.composeServiceName, row.id]))
  const needs = await deps.loadNeeds(
    db,
    params.sites.flatMap((site) => idByName.get(site.composeServiceName) ?? [])
  )
  if (needs.size === 0) return [...params.sites]

  const hosted = await deps.loadHostedServiceIds(db, [...needs.keys()])
  for (const site of params.sites) {
    const id = idByName.get(site.composeServiceName)
    if (id !== undefined && needs.has(id) && !hosted.has(id)) {
      return siteNeedsHostnameError(site.composeServiceName)
    }
  }

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
