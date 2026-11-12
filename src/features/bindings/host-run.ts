/**
 * How a binding reaches its database from a service that does not run in a
 * container.
 *
 * A container service dials its server's ProxySQL by container name over the
 * organization's managed network (see `resolve-endpoint.ts`). A PHP site or a
 * native Node app runs on the host as the site owner's Linux user, where that
 * name does not resolve; it dials the same ProxySQL on loopback, at the port
 * the proxy publishes there. Container output is untouched by anything here.
 */

import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { binding, login, managed, variable } from '../../db/schema.ts'
import { isNodeComposeService, isSiteComposeService } from '../compose/service-kind.ts'
import { MANAGED_INGRESS_MYSQL_PORT, MANAGED_INGRESS_PGSQL_PORT } from '../managed/ingress-ports.ts'
import { bindingPrefixedKeys, HOST_RUN_LOOPBACK_HOST } from '../../lib/naming.ts'
import { type BindingPreset, effectivePreset, presetSiteNames } from './presets.ts'

export { HOST_RUN_LOOPBACK_HOST }

/**
 * The only database ports a PHP site's Linux user may reach on loopback: the
 * default MySQL-family and Postgres listeners. The daemon's `tp-php-loopback`
 * firewall script refuses every other loopback destination for that user and
 * names these two ports; keep them in step.
 */
export const HOST_SITE_PROXY_PORTS: readonly number[] = [
  MANAGED_INGRESS_MYSQL_PORT,
  MANAGED_INGRESS_PGSQL_PORT,
]

/**
 * `container`: the compose service (container name, CA as PEM text).
 * `host-site`: a PHP site (loopback, CA delivered as a file by the daemon).
 * `host-node`: a native Node app (loopback, CA as PEM text: the app's private
 * environment file carries a multi-line value).
 */
export type BindingDelivery = 'container' | 'host-site' | 'host-node'

export function isHostRunDelivery(delivery: BindingDelivery): boolean {
  return delivery !== 'container'
}

/** Compose service name to delivery, for the host-run services of a document. */
export function hostRunDeliveryByComposeName(
  documentData: Record<string, unknown>
): Map<string, BindingDelivery> {
  const out = new Map<string, BindingDelivery>()
  const services = documentData.services
  if (typeof services !== 'object' || services === null) return out
  for (const [name, body] of Object.entries(services)) {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) continue
    const record = body as Record<string, unknown>
    if (isSiteComposeService(record)) out.set(name, 'host-site')
    else if (isNodeComposeService(record)) out.set(name, 'host-node')
  }
  return out
}

/** Service id to delivery for every service row (container when not host-run). */
export function deliveryByServiceId(
  byComposeName: ReadonlyMap<string, BindingDelivery>,
  serviceRows: readonly { id: string; composeServiceName: string }[]
): Map<string, BindingDelivery> {
  return new Map(
    serviceRows.map((row) => [row.id, byComposeName.get(row.composeServiceName) ?? 'container'])
  )
}

/**
 * The form a binding's stored rows are in, so a re-materialize that is not a
 * deploy (a rotated CA, a changed password) does not flip a host-run service
 * back to the container name. Host rows say loopback; the CA row (a native
 * app keeps it as text) tells the two host kinds apart.
 */
export function inferStoredDelivery(
  rows: readonly { key: string; value: string; isSecret: boolean }[],
  keyPrefix: string
): BindingDelivery {
  const keys = bindingPrefixedKeys(keyPrefix)
  const host = rows.find((row) => row.key === keys.host && !row.isSecret)
  if (host?.value !== HOST_RUN_LOOPBACK_HOST) return 'container'
  return rows.some((row) => row.key === keys.caCert) ? 'host-node' : 'host-site'
}

export async function loadStoredDelivery(
  db: Db,
  bindingId: string,
  keyPrefix: string
): Promise<BindingDelivery> {
  const rows = await db
    .select({ key: variable.key, value: variable.value, isSecret: variable.isSecret })
    .from(variable)
    .where(eq(variable.bindingId, bindingId))
  return inferStoredDelivery(rows, keyPrefix)
}

/**
 * Plain-words reason a PHP site cannot use this binding, or `null`. Any engine
 * works on its default listener port; a changed port is not open to a site's
 * Linux user.
 */
export function hostSiteBindingRefusal(listenerPort: number): string | null {
  if (HOST_SITE_PROXY_PORTS.includes(listenerPort)) return null
  return `A PHP site can only reach a database on a default database port (${HOST_SITE_PROXY_PORTS.join(' or ')}); this database is on port ${listenerPort}. Run the app in a container to use it.`
}

/** Variable names a host-run service cannot work without. */
export function bindingRequiredKeys(
  params: Readonly<{
    keyPrefix: string
    preset: BindingPreset | null
    engineCode: string
    /** The stored TLS mode text, when known (decides the verify-only names). */
    sslMode?: string | null
  }>
): string[] {
  const keys = bindingPrefixedKeys(params.keyPrefix)
  const out = [keys.host, keys.port, keys.database, keys.user, keys.password]
  if (params.preset !== null) {
    out.push(...presetSiteNames(params.preset, params.engineCode, params.sslMode ?? null).required)
  }
  return out
}

export type HostSiteBindingNeeds = {
  /** `<PREFIX>_CA_FILE` names, one per binding on the service. */
  caFileKeys: string[]
  /** `<PREFIX>_URL` names of the Postgres bindings: the daemon adds `sslrootcert` to them. */
  urlKeys: string[]
  requiredKeys: string[]
}

/** Stored `<PREFIX>_SSL_MODE` text per binding id (the mode every kind keeps as a plain row). */
async function loadStoredSslModes(
  db: Db,
  rows: readonly { id: string; keyPrefix: string }[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (rows.length === 0) return out
  const keyById = new Map(rows.map((row) => [row.id, bindingPrefixedKeys(row.keyPrefix).sslMode]))
  const stored = await db
    .select({ bindingId: variable.bindingId, key: variable.key, value: variable.value })
    .from(variable)
    .where(and(inArray(variable.bindingId, [...keyById.keys()]), eq(variable.isSecret, false)))
  for (const row of stored) {
    if (row.bindingId && keyById.get(row.bindingId) === row.key) out.set(row.bindingId, row.value)
  }
  return out
}

/** Per service id: what the daemon must deliver for its bindings. */
export async function loadHostSiteBindingNeeds(
  db: Db,
  serviceIds: readonly string[]
): Promise<Map<string, HostSiteBindingNeeds>> {
  const out = new Map<string, HostSiteBindingNeeds>()
  if (serviceIds.length === 0) return out
  const rows = await db
    .select({
      id: binding.id,
      serviceId: binding.serviceId,
      keyPrefix: binding.keyPrefix,
      isEmitEngineDefaults: binding.isEmitEngineDefaults,
      preset: binding.preset,
      engine: managed.engine,
    })
    .from(binding)
    .innerJoin(login, eq(login.id, binding.loginId))
    .innerJoin(managed, eq(managed.id, login.managedId))
    .where(and(inArray(binding.serviceId, [...serviceIds])))
  const sslModes = await loadStoredSslModes(db, rows)
  for (const row of rows) {
    if (!row.engine) continue
    const needs = out.get(row.serviceId) ?? { caFileKeys: [], urlKeys: [], requiredKeys: [] }
    const keys = bindingPrefixedKeys(row.keyPrefix)
    const preset = effectivePreset(row, row.engine)
    const sslMode = sslModes.get(row.id) ?? null
    needs.caFileKeys.push(keys.caFile)
    if (row.engine === 'postgres') needs.urlKeys.push(keys.url)
    if (preset !== null) {
      const names = presetSiteNames(preset, row.engine, sslMode)
      needs.caFileKeys.push(...names.caFile)
      needs.urlKeys.push(...names.url)
    }
    needs.requiredKeys.push(
      ...bindingRequiredKeys({ keyPrefix: row.keyPrefix, preset, engineCode: row.engine, sslMode })
    )
    out.set(row.serviceId, needs)
  }
  return out
}
