/**
 * Materialize binding-owned `variable` rows from a login + managed cluster.
 *
 * System-owned rows are ordinary service-scoped variables with `binding_id`
 * set; deploy reuses the existing secret seal / inject rail unchanged.
 */

import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import { decryptSecret, encryptSecret } from '../../lib/secrets/data-encryption.ts'
import type { Db } from '../../db/connection.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { logWarn } from '../../lib/logger.ts'
import {
  binding,
  environment,
  managed,
  organization,
  login,
  managedDatabase,
  project,
  service,
  variable,
  workspace,
} from '../../db/schema.ts'
import { getManagedEngineSpec } from '../managed/index.ts'
import type { ManagedSslMode } from '../managed/ssl.ts'
import { resolveEffectiveManagedSsl } from '../managed/external-access-tls.ts'
import { parseOrganizationOptions } from '../organizations/organization-options.ts'
import { bindingPrefixedKeys } from '../../lib/naming.ts'
import type { ResolvedVariableEntry, ResolvedVariableMap } from '../variables/resolve-inherited.ts'
import { ensureActiveOrganizationCa } from '../managed/apply-prepare.ts'
import { loadManagedOptions } from '../managed/options.ts'
import {
  type BindingDelivery,
  HOST_RUN_LOOPBACK_HOST,
  hostSiteBindingRefusal,
  isHostRunDelivery,
  loadStoredDelivery,
} from './host-run.ts'
import {
  type BindingEndpointError,
  isBindingEndpointError,
  resolveBindingEndpoint,
} from './resolve-endpoint.ts'

export type MaterializeBindingError =
  | BindingEndpointError
  | { kind: 'binding_not_found' }
  | { kind: 'binding_password_unavailable' }
  | { kind: 'binding_principal_invalid' }
  | { kind: 'binding_engine_unsupported' }
  | { kind: 'binding_ca_unavailable' }
  | { kind: 'binding_cluster_invalid' }
  /** A PHP site cannot reach this database (its port); `message` is plain words. */
  | { kind: 'binding_host_site_unsupported'; message: string }

/** Where a container finds a binding's CA certificate (a file mount of the `_CA_CERT` secret). */
export function containerBindingCaPath(keyPrefix: string): string {
  return `/run/secrets/${bindingPrefixedKeys(keyPrefix).caCert}`
}

const VERIFY_SSL_MODES: ReadonlySet<ManagedSslMode> = new Set(['verify-ca', 'verify-full'])

/**
 * A container's Postgres URL names its CA file in the verify modes, so a
 * client that reads only the URL still verifies against the right root. A
 * PHP site gets the same from the daemon; MySQL URLs are unchanged.
 */
function withContainerRootCert(
  dsn: string,
  params: Readonly<{ keyPrefix: string; engineCode: string; sslMode: ManagedSslMode }>
): string {
  if (params.engineCode !== 'postgres' || !VERIFY_SSL_MODES.has(params.sslMode)) return dsn
  return `${dsn}&sslrootcert=${containerBindingCaPath(params.keyPrefix)}`
}

export type DesiredBindingVariable = {
  key: string
  value: string
  isSecret: boolean
}

/**
 * Pure: compute the key/value set a binding emits for unit tests and
 * materialization. Secret values are still plaintext here — the materialize
 * path seals them before write.
 */
export function computeBindingVariableSet(
  params: Readonly<{
    keyPrefix: string
    emitEngineDefaults: boolean
    databaseName: string
    username: string
    password: string
    host: string
    port: number
    caCertPem: string
    readSplit: boolean
    engineCode: string
    /**
     * **Effective** client TLS mode for the cluster (service override → org
     * default → platform), already resolved by the caller.
     */
    sslMode: ManagedSslMode
    /**
     * Where the consuming service runs. Omitted means `container`, which also
     * gets `<PREFIX>_CA_FILE` and, in the Postgres verify modes, a URL naming it. A host
     * kind dials ProxySQL on loopback (`host` is replaced); a PHP site gets no
     * `<PREFIX>_CA_CERT` (a multi-line value breaks its web server: the daemon
     * delivers the CA as a file and sets `<PREFIX>_CA_FILE`).
     */
    delivery?: BindingDelivery
  }>
): DesiredBindingVariable[] | { kind: 'binding_engine_unsupported' } {
  const spec = getManagedEngineSpec(params.engineCode)
  if (!spec?.binding) {
    return { kind: 'binding_engine_unsupported' }
  }

  const prefixed = bindingPrefixedKeys(params.keyPrefix)
  const delivery = params.delivery ?? 'container'
  const host = isHostRunDelivery(delivery) ? HOST_RUN_LOOPBACK_HOST : params.host
  const plainDsn = spec.binding.buildBindingDsn({
    host,
    port: params.port,
    database: params.databaseName,
    username: params.username,
    password: params.password,
    sslMode: params.sslMode,
  })
  const dsn =
    delivery === 'container'
      ? withContainerRootCert(plainDsn, {
          keyPrefix: params.keyPrefix,
          engineCode: params.engineCode,
          sslMode: params.sslMode,
        })
      : plainDsn

  const rows: DesiredBindingVariable[] = [
    { key: prefixed.url, value: dsn, isSecret: true },
    ...(delivery === 'host-site'
      ? []
      : [{ key: prefixed.caCert, value: params.caCertPem, isSecret: true }]),
    {
      key: prefixed.readSplit,
      value: params.readSplit ? 'true' : 'false',
      isSecret: false,
    },
    { key: prefixed.host, value: host, isSecret: false },
    { key: prefixed.port, value: String(params.port), isSecret: false },
    { key: prefixed.database, value: params.databaseName, isSecret: false },
    { key: prefixed.user, value: params.username, isSecret: false },
    { key: prefixed.password, value: params.password, isSecret: true },
    {
      key: prefixed.sslMode,
      value: spec.formatSslMode(params.sslMode),
      isSecret: false,
    },
    ...(delivery === 'container'
      ? [
          {
            key: prefixed.caFile,
            value: containerBindingCaPath(params.keyPrefix),
            isSecret: false,
          },
        ]
      : []),
  ]

  if (params.emitEngineDefaults) {
    const u = spec.binding.unprefixed
    rows.push(
      { key: u.host, value: host, isSecret: false },
      { key: u.port, value: String(params.port), isSecret: false },
      { key: u.database, value: params.databaseName, isSecret: false },
      { key: u.user, value: params.username, isSecret: false },
      { key: u.password, value: params.password, isSecret: true }
    )
    if (u.sslMode) {
      rows.push({
        key: u.sslMode,
        value: spec.formatSslMode(params.sslMode),
        isSecret: false,
      })
    }
  }

  return rows
}

/** Keys a binding emits for a given prefix/flags/engine (no values). */
export function listBindingEmittedKeys(
  params: Readonly<{
    keyPrefix: string
    emitEngineDefaults: boolean
    engineCode: string
    /**
     * Omitted lists `<PREFIX>_CA_FILE` (a container stores it; the daemon sets
     * it on a PHP site, so the name is taken either way). A native Node app has
     * no CA file.
     */
    delivery?: BindingDelivery
  }>
): string[] | null {
  const spec = getManagedEngineSpec(params.engineCode)
  if (!spec?.binding) return null
  const { caFile, ...rest } = bindingPrefixedKeys(params.keyPrefix)
  const keys = Object.values(rest)
  if (params.delivery !== 'host-node') keys.push(caFile)
  if (params.emitEngineDefaults) {
    const u = spec.binding.unprefixed
    keys.push(u.host, u.port, u.database, u.user, u.password)
    if (u.sslMode) keys.push(u.sslMode)
  }
  return keys
}

type VariableReader = Pick<Db, 'select'>

/** Keys of the service's own variables that no binding owns. */
async function loadHandSetServiceKeys(
  reader: VariableReader,
  serviceId: string
): Promise<Set<string>> {
  const rows = await reader
    .select({ key: variable.key })
    .from(variable)
    .where(and(eq(variable.serviceId, serviceId), isNull(variable.bindingId)))
  return new Set(rows.map((row) => row.key))
}

async function sealIfNeeded(
  dataEncryptionSecrets: DerivedSecretsConfig,
  value: string,
  isSecret: boolean
): Promise<string> {
  if (!isSecret) return value
  return await encryptSecret(dataEncryptionSecrets, value)
}

/**
 * Upsert binding-owned variable rows for a desired key set (insert / update /
 * delete stale). Extracted for host-free coverage of the write path.
 */
export async function upsertBindingOwnedVariables(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  params: Readonly<{
    bindingId: string
    serviceId: string
    desired: DesiredBindingVariable[]
  }>
): Promise<void> {
  const desiredKeys = new Set(params.desired.map((d) => d.key))

  await db.transaction(async (tx) => {
    const existing = await tx
      .select({
        id: variable.id,
        key: variable.key,
      })
      .from(variable)
      .where(eq(variable.bindingId, params.bindingId))

    const existingByKey = new Map(existing.map((e) => [e.key, e.id]))
    const heldByHand = await loadHandSetServiceKeys(tx, params.serviceId)

    await forEachSequential(params.desired, async (entry) => {
      // A newer default name (`<PREFIX>_SSL_MODE`) may already be a variable the
      // user set on this service: the unique index would fail the insert and
      // stop every deploy. Leave their row alone; a reference then reads
      // "set by hand on this service". Only inserts are skipped.
      if (!existingByKey.has(entry.key) && heldByHand.has(entry.key)) {
        logWarn('bindings', 'binding key skipped: a variable of that name is set by hand', {
          serviceId: params.serviceId,
          key: entry.key,
        })
        return
      }
      const sealed = await sealIfNeeded(dataEncryptionSecrets, entry.value, entry.isSecret)
      const existingId = existingByKey.get(entry.key)
      if (existingId) {
        await tx
          .update(variable)
          .set({
            value: sealed,
            isSecret: entry.isSecret,
            isLiteral: true,
            isForBuild: false,
            isForRuntime: true,
            serviceId: params.serviceId,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(variable.id, existingId))
        existingByKey.delete(entry.key)
      } else {
        await tx.insert(variable).values({
          serviceId: params.serviceId,
          bindingId: params.bindingId,
          key: entry.key,
          value: sealed,
          isSecret: entry.isSecret,
          isLiteral: true,
          isForBuild: false,
          isForRuntime: true,
        })
      }
    })

    // Drop binding-owned keys that are no longer emitted (prefix / flags flip).
    const staleIds = [...existingByKey.entries()]
      .filter(([key]) => !desiredKeys.has(key))
      .map(([, id]) => id)
    if (staleIds.length > 0) {
      await tx.delete(variable).where(inArray(variable.id, staleIds))
    }
  })
}

/**
 * The form this binding is written in: what the deploy said, else what its
 * stored rows already are. A PHP site that could not reach the listener is
 * refused here, before anything is written.
 */
export async function resolveBindingDelivery(
  db: Db,
  binding: Readonly<{ bindingId: string; keyPrefix: string; listenerPort: number }>,
  delivery: BindingDelivery | undefined
): Promise<BindingDelivery | MaterializeBindingError> {
  const effective = delivery ?? (await loadStoredDelivery(db, binding.bindingId, binding.keyPrefix))
  if (effective !== 'host-site') return effective
  const refusal = hostSiteBindingRefusal(binding.listenerPort)
  return refusal ? { kind: 'binding_host_site_unsupported', message: refusal } : effective
}

/**
 * @param delivery where the consuming service runs. A deploy passes what the
 *   compose document says; any other caller omits it and the binding keeps the
 *   form its stored rows are already in.
 */
export async function materializeBinding(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  bindingId: string,
  delivery?: BindingDelivery
): Promise<{ ok: true } | MaterializeBindingError> {
  const [row] = await db
    .select({
      id: binding.id,
      serviceId: binding.serviceId,
      databaseName: managedDatabase.name,
      keyPrefix: binding.keyPrefix,
      emitEngineDefaults: binding.isEmitEngineDefaults,
      loginId: login.id,
      // Applied login — bindings hand services the real engine credential.
      principalUsername: login.appliedUsername,
      principalPassword: login.password,
      principalManagedId: login.managedId,
      managedId: managed.id,
      managedEngine: managed.engine,
      managedOptions: managed.options,
      organizationId: workspace.organizationId,
      organizationOptions: organization.options,
    })
    .from(binding)
    .innerJoin(login, eq(login.id, binding.loginId))
    .innerJoin(managedDatabase, eq(managedDatabase.id, binding.databaseId))
    .innerJoin(managed, eq(login.managedId, managed.id))
    .innerJoin(service, eq(binding.serviceId, service.id))
    .innerJoin(environment, eq(service.environmentId, environment.id))
    .innerJoin(project, eq(environment.projectId, project.id))
    .innerJoin(workspace, eq(project.workspaceId, workspace.id))
    .innerJoin(organization, eq(workspace.organizationId, organization.id))
    .where(eq(binding.id, bindingId))
    .limit(1)

  if (!row) return { kind: 'binding_not_found' }

  if (!row.principalManagedId || !row.principalUsername) {
    return { kind: 'binding_principal_invalid' }
  }

  if (!row.managedEngine) return { kind: 'binding_engine_unsupported' }

  const spec = getManagedEngineSpec(row.managedEngine)
  if (!spec?.binding) return { kind: 'binding_engine_unsupported' }

  const options = await loadManagedOptions(db, spec, {
    id: row.managedId,
    options: row.managedOptions,
  })
  if (!options) return { kind: 'binding_cluster_invalid' }

  if (
    !row.principalPassword ||
    typeof row.principalPassword !== 'string' ||
    row.principalPassword.length === 0
  ) {
    return { kind: 'binding_password_unavailable' }
  }

  let plaintextPassword: string
  try {
    plaintextPassword = await decryptSecret(dataEncryptionSecrets, row.principalPassword)
  } catch {
    return { kind: 'binding_password_unavailable' }
  }

  const ca = await ensureActiveOrganizationCa(db, dataEncryptionSecrets, row.organizationId)
  if ('kind' in ca) {
    return { kind: 'binding_ca_unavailable' }
  }

  const orgManagedDefaults = parseOrganizationOptions(row.organizationOptions).managedDatabase

  // The listener port is resolved from the server-owner org inside
  // `resolveBindingEndpoint`, not from this consuming project's org.
  const endpoint = await resolveBindingEndpoint(db, {
    serviceId: row.serviceId,
    managedId: row.managedId,
    engineCode: row.managedEngine,
    engineDefaultPort: spec.defaultPort,
  })
  if (isBindingEndpointError(endpoint)) {
    return endpoint
  }

  const effectiveDelivery = await resolveBindingDelivery(
    db,
    { bindingId, keyPrefix: row.keyPrefix, listenerPort: endpoint.port },
    delivery
  )
  if (typeof effectiveDelivery === 'object') return effectiveDelivery

  // Raised to require while a server fronting the cluster allows external
  // access: its listener refuses plaintext, so a weaker mode cannot connect.
  const ssl = await resolveEffectiveManagedSsl(db, {
    managedId: row.managedId,
    configured: options.settings.ssl.mode,
    organizationDefault: orgManagedDefaults?.sslMode,
  })

  const desired = computeBindingVariableSet({
    keyPrefix: row.keyPrefix,
    emitEngineDefaults: row.emitEngineDefaults,
    databaseName: row.databaseName,
    username: row.principalUsername,
    password: plaintextPassword,
    host: endpoint.host,
    port: endpoint.port,
    caCertPem: ca.trustBundlePem,
    readSplit: endpoint.readSplit,
    engineCode: row.managedEngine,
    sslMode: ssl.mode,
    delivery: effectiveDelivery,
  })
  if ('kind' in desired) return desired

  await upsertBindingOwnedVariables(db, dataEncryptionSecrets, {
    bindingId,
    serviceId: row.serviceId,
    desired,
  })

  return { ok: true }
}

export async function materializeBindingsForServices(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  serviceIds: readonly string[],
  /** What the compose document says each service is; absent means keep stored form. */
  deliveries?: ReadonlyMap<string, BindingDelivery>
): Promise<{ ok: true } | MaterializeBindingError> {
  if (serviceIds.length === 0) return { ok: true }
  const rows = await db
    .select({ id: binding.id, serviceId: binding.serviceId })
    .from(binding)
    .where(inArray(binding.serviceId, [...serviceIds]))
  for (const row of rows) {
    const result = await materializeBinding(
      db,
      dataEncryptionSecrets,
      row.id,
      deliveries?.get(row.serviceId)
    )
    if (!('ok' in result)) return result
  }
  return { ok: true }
}

/** Every binding of one login. */
export async function materializeBindingsForLogin(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  loginId: string
): Promise<{ ok: true } | MaterializeBindingError> {
  const rows = await db
    .select({ id: binding.id })
    .from(binding)
    .innerJoin(login, eq(login.id, binding.loginId))
    .where(eq(login.id, loginId))
  return materializeEach(db, dataEncryptionSecrets, rows)
}

/** Every binding of every login of one cluster. */
export async function materializeBindingsForManaged(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  managedId: string
): Promise<{ ok: true } | MaterializeBindingError> {
  const rows = await db
    .select({ id: binding.id })
    .from(binding)
    .innerJoin(login, eq(login.id, binding.loginId))
    .where(eq(login.managedId, managedId))
  return materializeEach(db, dataEncryptionSecrets, rows)
}

async function materializeEach(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  rows: ReadonlyArray<{ id: string }>
): Promise<{ ok: true } | MaterializeBindingError> {
  for (const row of rows) {
    const result = await materializeBinding(db, dataEncryptionSecrets, row.id)
    if (!('ok' in result)) return result
  }
  return { ok: true }
}

/**
 * Load binding-owned variables for a service and re-assert them onto a
 * resolved variable map so hosting-scope keys cannot shadow binding output.
 */
export async function reapplyBindingOwnedVariables(
  db: Db,
  serviceId: string,
  map: ResolvedVariableMap
): Promise<void> {
  const rows = await db
    .select({
      key: variable.key,
      value: variable.value,
      isSecret: variable.isSecret,
      isLiteral: variable.isLiteral,
      forBuild: variable.isForBuild,
      forRuntime: variable.isForRuntime,
      bindingId: variable.bindingId,
    })
    .from(variable)
    .where(and(eq(variable.serviceId, serviceId), isNotNull(variable.bindingId)))

  for (const row of rows) {
    const entry: ResolvedVariableEntry = {
      value: row.value,
      isSecret: row.isSecret,
      isLiteral: row.isLiteral,
      forBuild: row.forBuild,
      forRuntime: row.forRuntime,
      bindingId: row.bindingId ?? null,
    }
    map.set(row.key, entry)
  }
}

/** Binding-owned keys currently stored for a service (for strip/collision). */
export async function loadBindingOwnedKeysForService(
  db: Db,
  serviceId: string
): Promise<Set<string>> {
  const rows = await db
    .select({ key: variable.key })
    .from(variable)
    .where(and(eq(variable.serviceId, serviceId), isNotNull(variable.bindingId)))
  return new Set(rows.map((r) => r.key))
}
