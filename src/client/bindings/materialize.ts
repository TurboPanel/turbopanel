/**
 * Materialize binding-owned `variable` rows from a principal + managed cluster.
 *
 * System-owned rows are ordinary service-scoped variables with `binding_id`
 * set; deploy reuses the existing secret seal / inject rail unchanged.
 */

import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import type { DerivedSecretsConfig } from '../authn/secrets.ts'
import {
  decryptSecret,
  encryptSecret,
} from '../authn/data-encryption.ts'
import type { Db } from '../../db.ts'
import {
  binding,
  environment,
  managed,
  principal,
  project,
  service,
  variable,
  workspace,
} from '../../lib/db/schema.ts'
import { getManagedEngineSpec } from '../../lib/managed/index.ts'
import { bindingPrefixedKeys } from '../../lib/naming.ts'
import type {
  ResolvedVariableEntry,
  ResolvedVariableMap,
} from '../variables/resolve-inherited.ts'
import { ensureActiveOrganizationCa } from '../managed/apply-prepare.ts'
import { parseManagedRowOptions } from '../managed/options.ts'
import {
  isBindingEndpointError,
  resolveBindingEndpoint,
  type BindingEndpointError,
} from './resolve-endpoint.ts'

export type MaterializeBindingError =
  | BindingEndpointError
  | { kind: 'binding_not_found' }
  | { kind: 'binding_password_unavailable' }
  | { kind: 'binding_principal_invalid' }
  | { kind: 'binding_engine_unsupported' }
  | { kind: 'binding_ca_unavailable' }
  | { kind: 'binding_cluster_invalid' }

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
export function computeBindingVariableSet(params: Readonly<{
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
  settings: Parameters<
    NonNullable<ReturnType<typeof getManagedEngineSpec>>['buildConnectionInfo']
  >[0]['settings']
}>): DesiredBindingVariable[] | { kind: 'binding_engine_unsupported' } {
  const spec = getManagedEngineSpec(params.engineCode)
  if (!spec?.binding) {
    return { kind: 'binding_engine_unsupported' }
  }

  const prefixed = bindingPrefixedKeys(params.keyPrefix)
  const dsn = spec.binding.buildBindingDsn({
    host: params.host,
    port: params.port,
    database: params.databaseName,
    username: params.username,
    password: params.password,
    settings: params.settings,
  })

  const rows: DesiredBindingVariable[] = [
    { key: prefixed.url, value: dsn, isSecret: true },
    { key: prefixed.caCert, value: params.caCertPem, isSecret: true },
    {
      key: prefixed.readSplit,
      value: params.readSplit ? 'true' : 'false',
      isSecret: false,
    },
    { key: prefixed.host, value: params.host, isSecret: false },
    { key: prefixed.port, value: String(params.port), isSecret: false },
    { key: prefixed.database, value: params.databaseName, isSecret: false },
    { key: prefixed.user, value: params.username, isSecret: false },
    { key: prefixed.password, value: params.password, isSecret: true },
  ]

  if (params.emitEngineDefaults) {
    const u = spec.binding.unprefixed
    rows.push(
      { key: u.host, value: params.host, isSecret: false },
      { key: u.port, value: String(params.port), isSecret: false },
      { key: u.database, value: params.databaseName, isSecret: false },
      { key: u.user, value: params.username, isSecret: false },
      { key: u.password, value: params.password, isSecret: true },
    )
    if (u.sslMode) {
      rows.push({ key: u.sslMode, value: 'verify-full', isSecret: false })
    }
  }

  return rows
}

/** Keys a binding emits for a given prefix/flags/engine (no values). */
export function listBindingEmittedKeys(params: Readonly<{
  keyPrefix: string
  emitEngineDefaults: boolean
  engineCode: string
}>): string[] | null {
  const spec = getManagedEngineSpec(params.engineCode)
  if (!spec?.binding) return null
  const prefixed = bindingPrefixedKeys(params.keyPrefix)
  const keys = Object.values(prefixed)
  if (params.emitEngineDefaults) {
    const u = spec.binding.unprefixed
    keys.push(u.host, u.port, u.database, u.user, u.password)
    if (u.sslMode) keys.push(u.sslMode)
  }
  return keys
}

async function sealIfNeeded(
  dataEncryptionSecrets: DerivedSecretsConfig,
  value: string,
  isSecret: boolean,
): Promise<string> {
  if (!isSecret) return value
  return encryptSecret(dataEncryptionSecrets, value)
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
  }>,
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

    for (const entry of params.desired) {
      const sealed = await sealIfNeeded(
        dataEncryptionSecrets,
        entry.value,
        entry.isSecret,
      )
      const existingId = existingByKey.get(entry.key)
      if (existingId) {
        await tx
          .update(variable)
          .set({
            value: sealed,
            isSecret: entry.isSecret,
            isLiteral: true,
            forBuild: false,
            forRuntime: true,
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
          forBuild: false,
          forRuntime: true,
        })
      }
    }

    // Drop binding-owned keys that are no longer emitted (prefix / flags flip).
    const staleIds = [...existingByKey.entries()]
      .filter(([key]) => !desiredKeys.has(key))
      .map(([, id]) => id)
    if (staleIds.length > 0) {
      await tx.delete(variable).where(inArray(variable.id, staleIds))
    }
  })
}

export async function materializeBinding(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  bindingId: string,
): Promise<{ ok: true } | MaterializeBindingError> {
  const [row] = await db
    .select({
      id: binding.id,
      principalId: binding.principalId,
      serviceId: binding.serviceId,
      databaseName: binding.databaseName,
      keyPrefix: binding.keyPrefix,
      emitEngineDefaults: binding.emitEngineDefaults,
      principalKind: principal.kind,
      principalUsername: principal.username,
      principalPassword: principal.password,
      principalManagedId: principal.managedId,
      managedId: managed.id,
      managedEngine: managed.engine,
      managedOptions: managed.options,
      organizationId: workspace.organizationId,
    })
    .from(binding)
    .innerJoin(principal, eq(binding.principalId, principal.id))
    .innerJoin(managed, eq(principal.managedId, managed.id))
    .innerJoin(service, eq(binding.serviceId, service.id))
    .innerJoin(environment, eq(service.environmentId, environment.id))
    .innerJoin(project, eq(environment.projectId, project.id))
    .innerJoin(workspace, eq(project.workspaceId, workspace.id))
    .where(eq(binding.id, bindingId))
    .limit(1)

  if (!row) return { kind: 'binding_not_found' }

  if (
    row.principalKind !== 'database' ||
    !row.principalManagedId ||
    !row.principalUsername
  ) {
    return { kind: 'binding_principal_invalid' }
  }

  if (!row.managedEngine) return { kind: 'binding_engine_unsupported' }

  const spec = getManagedEngineSpec(row.managedEngine)
  if (!spec?.binding) return { kind: 'binding_engine_unsupported' }

  const options = parseManagedRowOptions(spec, row.managedOptions)
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
    plaintextPassword = await decryptSecret(
      dataEncryptionSecrets,
      row.principalPassword,
    )
  } catch {
    return { kind: 'binding_password_unavailable' }
  }

  const ca = await ensureActiveOrganizationCa(
    db,
    dataEncryptionSecrets,
    row.organizationId,
  )
  if ('kind' in ca) {
    return { kind: 'binding_ca_unavailable' }
  }

  const endpoint = await resolveBindingEndpoint(db, {
    serviceId: row.serviceId,
    managedId: row.managedId,
    protocolPort: spec.defaultPort,
  })
  if (isBindingEndpointError(endpoint)) {
    return endpoint
  }

  const desired = computeBindingVariableSet({
    keyPrefix: row.keyPrefix,
    emitEngineDefaults: row.emitEngineDefaults,
    databaseName: row.databaseName,
    username: row.principalUsername,
    password: plaintextPassword,
    host: endpoint.host,
    port: endpoint.port,
    caCertPem: ca.certificatePem,
    readSplit: endpoint.readSplit,
    engineCode: row.managedEngine,
    settings: options.settings,
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
): Promise<{ ok: true } | MaterializeBindingError> {
  if (serviceIds.length === 0) return { ok: true }
  const rows = await db
    .select({ id: binding.id })
    .from(binding)
    .where(inArray(binding.serviceId, [...serviceIds]))
  for (const row of rows) {
    const result = await materializeBinding(db, dataEncryptionSecrets, row.id)
    if (!('ok' in result)) return result
  }
  return { ok: true }
}

export async function materializeBindingsForPrincipal(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  principalId: string,
): Promise<{ ok: true } | MaterializeBindingError> {
  const rows = await db
    .select({ id: binding.id })
    .from(binding)
    .where(eq(binding.principalId, principalId))
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
  map: ResolvedVariableMap,
): Promise<void> {
  const rows = await db
    .select({
      key: variable.key,
      value: variable.value,
      isSecret: variable.isSecret,
      isLiteral: variable.isLiteral,
      forBuild: variable.forBuild,
      forRuntime: variable.forRuntime,
      bindingId: variable.bindingId,
    })
    .from(variable)
    .where(
      and(
        eq(variable.serviceId, serviceId),
        isNotNull(variable.bindingId),
      ),
    )

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
  serviceId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ key: variable.key })
    .from(variable)
    .where(
      and(
        eq(variable.serviceId, serviceId),
        isNotNull(variable.bindingId),
      ),
    )
  return new Set(rows.map((r) => r.key))
}
