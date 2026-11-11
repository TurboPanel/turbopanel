import { forEachSequential } from '../lib/sequential.ts'
import { and, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import {
  ENVELOPE_PREFIX_SECRET,
  isDaemonSealedEnvelope,
  parseDaemonSecretEnvelope,
  parseSecretEnvelope,
  resealSecretForDaemon,
} from '../lib/secrets/data-encryption.ts'
import type { DerivedSecretsConfig, SecretsConfig } from '../lib/secrets/secrets.ts'
import {
  getServerDaemonStateByServerId,
  isDaemonKeyActive,
} from '../features/servers/server-identity-db.ts'
import { reapplyBindingOwnedVariables } from '../features/bindings/materialize.ts'
import { applyDbRefs, loadBindingRefTable } from '../features/bindings/db-refs.ts'
import {
  mergeHostingVariablesForService,
  type ResolvedVariableMap,
  resolveInheritedVariablesForService,
  resolveServerScopedVariables,
} from '../features/variables/resolve-inherited.ts'
import type { Db } from '../db/connection.ts'
import {
  type EnvironmentDeploySecretPlanEntry,
  type EnvironmentDeployVariableMaterial,
  parseDeploySecretPlan,
} from '../contracts/commands/schemas.ts'
import { deployment, environment, service } from '../db/schema.ts'

export type RehydrateDeploymentRequest = {
  projectId: string
  environmentId: string
  generation?: number
}

export type RehydrateDeploymentResult = {
  projectId: string
  environmentId: string
  generation: number
  secretPlan: EnvironmentDeploySecretPlanEntry[]
  variableMaterial: EnvironmentDeployVariableMaterial[]
}

/** A requested deployment whose environment no longer exists in this project. */
export type RehydrateGoneDeployment = {
  projectId: string
  environmentId: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Fail-closed: rehydrate must not reseal plaintext, malformed `tpsecret`, or
 * leftover `tpdaemon` delivery envelopes as if they were at-rest material.
 */
class RehydrateSecretMaterialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RehydrateSecretMaterialError'
  }
}

function requireAtRestSecretEnvelope(key: string, value: string): void {
  if (parseSecretEnvelope(value) !== null) return

  if (parseDaemonSecretEnvelope(value) !== null || isDaemonSealedEnvelope(value)) {
    throw new RehydrateSecretMaterialError(
      `secret ${key} is a tpdaemon envelope; rehydrate requires at-rest tpsecret`
    )
  }
  if (value.startsWith(ENVELOPE_PREFIX_SECRET)) {
    throw new RehydrateSecretMaterialError(`secret ${key} is a malformed tpsecret envelope`)
  }
  throw new RehydrateSecretMaterialError(
    `secret ${key} is plaintext; rehydrate requires at-rest tpsecret`
  )
}

export function parseRehydrateRequestBody(body: unknown): RehydrateDeploymentRequest[] {
  return parseRequestDeployments(body)
}

function parseRequestDeployments(value: unknown): RehydrateDeploymentRequest[] {
  if (!isRecord(value) || !Array.isArray(value.deployments)) {
    throw new TypeError('deployments must be an array')
  }
  const out: RehydrateDeploymentRequest[] = []
  for (const entry of value.deployments) {
    if (!isRecord(entry)) continue
    if (typeof entry.projectId !== 'string' || typeof entry.environmentId !== 'string') {
      continue
    }
    const item: RehydrateDeploymentRequest = {
      projectId: entry.projectId,
      environmentId: entry.environmentId,
    }
    if (typeof entry.generation === 'number' && Number.isFinite(entry.generation)) {
      item.generation = entry.generation
    }
    out.push(item)
  }
  return out
}

function secretPlanFromOptions(options: unknown): EnvironmentDeploySecretPlanEntry[] {
  if (!isRecord(options)) return []
  try {
    return parseDeploySecretPlan(options.secretPlan) ?? []
  } catch {
    return []
  }
}

/** A secret a generated config file reads: its service and key, no mount flags. */
type ConfigSecretRef = { composeServiceName: string; key: string }

export function configSecretRefsFromOptions(options: unknown): ConfigSecretRef[] {
  if (!isRecord(options) || !Array.isArray(options.configSecretRefs)) return []
  const refs: ConfigSecretRef[] = []
  for (const item of options.configSecretRefs) {
    if (!isRecord(item)) continue
    const { composeServiceName, key } = item
    if (typeof composeServiceName === 'string' && typeof key === 'string') {
      refs.push({ composeServiceName, key })
    }
  }
  return refs
}

/**
 * What to ask values for: every secret plan entry, then each secret only a
 * generated config file reads (deduped by service and key). A config-only
 * secret has no mount, so it carries neither flag.
 */
export type RehydrateSecretWant = ConfigSecretRef & { forBuild: boolean; forRuntime: boolean }

export function rehydrateSecretWants(
  secretPlan: readonly EnvironmentDeploySecretPlanEntry[],
  configRefs: readonly ConfigSecretRef[]
): RehydrateSecretWant[] {
  const wants: RehydrateSecretWant[] = secretPlan.map((plan) => ({
    composeServiceName: plan.composeServiceName,
    key: plan.key,
    forBuild: plan.forBuild,
    forRuntime: plan.forRuntime,
  }))
  for (const ref of configRefs) {
    if (wants.some((w) => w.key === ref.key && w.composeServiceName === ref.composeServiceName)) {
      continue
    }
    wants.push({ ...ref, forBuild: false, forRuntime: false })
  }
  return wants
}

async function resolveServiceVariableMap(
  db: Db,
  environmentId: string,
  composeServiceName: string,
  serverId: string
): Promise<ResolvedVariableMap> {
  const [row] = await db
    .select({ id: service.id })
    .from(service)
    .where(
      and(
        eq(service.environmentId, environmentId),
        eq(service.composeServiceName, composeServiceName)
      )
    )
    .limit(1)
  if (!row) {
    const serverVars = await resolveServerScopedVariables(db, serverId)
    return serverVars
  }
  const varMap = await resolveInheritedVariablesForService(db, row.id)
  await mergeHostingVariablesForService(db, row.id, varMap)
  await reapplyBindingOwnedVariables(db, row.id, varMap)
  const serverVars = await resolveServerScopedVariables(db, serverId)
  // A secret made by `{$db.<binding>.<field>}` rehydrates under its own key.
  // Issues are not reported here: the deploy that made the plan already was.
  const table = await loadBindingRefTable(db, row.id)
  return applyDbRefs(new Map([...varMap, ...serverVars]), table, { ownScopeKeys: new Set() }).map
}

export async function buildDeploymentSecretsRehydrate(
  c: Context,
  db: Db,
  body: unknown
): Promise<
  { deployments: RehydrateDeploymentResult[]; gone: RehydrateGoneDeployment[] } | Response
> {
  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  const secretsConfig = c.get('secretsConfig')
  if (!dataEncryptionSecrets || !secretsConfig) {
    return c.json({ ok: false, error: 'encryption unavailable' }, 503)
  }

  const daemonServerId = c.get('daemonServerId') as string
  const daemonState = await getServerDaemonStateByServerId(db, daemonServerId)
  if (!daemonState || !isDaemonKeyActive(daemonState.key)) {
    return c.json({ ok: false, error: 'No encryption-capable daemon key' }, 422)
  }
  const keyId = daemonState.key.id

  let requested: RehydrateDeploymentRequest[]
  try {
    requested = parseRequestDeployments(body)
  } catch {
    return c.json({ ok: false, error: 'invalid body' }, 400)
  }

  const results: RehydrateDeploymentResult[] = []
  const gone: RehydrateGoneDeployment[] = []
  await forEachSequential(requested, async (item) => {
    const result = await rehydrateOneDeployment(
      db,
      item,
      daemonServerId,
      keyId,
      dataEncryptionSecrets,
      secretsConfig
    )
    if (result === 'gone') {
      // Definitive only: the environment row is absent (the project or
      // environment was deleted). A live environment with no deployment row on
      // this server, or a generation mismatch, is never reported as gone.
      gone.push({ projectId: item.projectId, environmentId: item.environmentId })
    } else if (result) {
      results.push(result)
    }
  })

  return { deployments: results, gone }
}

async function collectRehydrateVariableMaterial(
  db: Db,
  item: RehydrateDeploymentRequest,
  daemonServerId: string,
  keyId: string,
  wants: readonly RehydrateSecretWant[],
  dataEncryptionSecrets: DerivedSecretsConfig,
  secretsConfig: SecretsConfig
): Promise<EnvironmentDeployVariableMaterial[]> {
  const variableMaterial: EnvironmentDeployVariableMaterial[] = []
  const maps = new Map<string, ResolvedVariableMap>()

  await forEachSequential(wants, async (plan) => {
    let varMap = maps.get(plan.composeServiceName)
    if (!varMap) {
      varMap = await resolveServiceVariableMap(
        db,
        item.environmentId,
        plan.composeServiceName,
        daemonServerId
      )
      maps.set(plan.composeServiceName, varMap)
    }
    const entry = varMap.get(plan.key)
    if (!entry?.isSecret) return
    requireAtRestSecretEnvelope(plan.key, entry.value)
    const valueEnvelope = await resealSecretForDaemon(
      secretsConfig,
      dataEncryptionSecrets,
      { serverId: daemonServerId, keyId },
      entry.value
    )
    variableMaterial.push({
      key: plan.key,
      composeServiceName: plan.composeServiceName,
      forBuild: plan.forBuild,
      forRuntime: plan.forRuntime,
      isLiteral: entry.isLiteral,
      valueEnvelope,
    })
  })
  return variableMaterial
}

async function rehydrateOneDeployment(
  db: Db,
  item: RehydrateDeploymentRequest,
  daemonServerId: string,
  keyId: string,
  dataEncryptionSecrets: DerivedSecretsConfig,
  secretsConfig: SecretsConfig
): Promise<RehydrateDeploymentResult | 'gone' | null> {
  const [envRow] = await db
    .select({ id: environment.id, projectId: environment.projectId })
    .from(environment)
    .where(eq(environment.id, item.environmentId))
    .limit(1)
  if (!envRow) return 'gone'
  if (envRow.projectId !== item.projectId) return null

  const [deployRow] = await db
    .select()
    .from(deployment)
    .where(
      and(eq(deployment.environmentId, item.environmentId), eq(deployment.serverId, daemonServerId))
    )
    .limit(1)
  if (!deployRow) return null

  if (typeof item.generation === 'number' && item.generation !== deployRow.desiredGeneration) {
    return null
  }

  const secretPlan = secretPlanFromOptions(deployRow.options)
  try {
    const variableMaterial = await collectRehydrateVariableMaterial(
      db,
      item,
      daemonServerId,
      keyId,
      rehydrateSecretWants(secretPlan, configSecretRefsFromOptions(deployRow.options)),
      dataEncryptionSecrets,
      secretsConfig
    )
    return {
      projectId: item.projectId,
      environmentId: item.environmentId,
      generation: deployRow.desiredGeneration,
      secretPlan,
      variableMaterial,
    }
  } catch (err) {
    if (err instanceof RehydrateSecretMaterialError) {
      return null
    }
    throw err
  }
}
