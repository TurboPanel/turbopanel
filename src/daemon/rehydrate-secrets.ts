import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import {
  ENVELOPE_PREFIX_SECRET,
  isDaemonSealedEnvelope,
  parseDaemonSecretEnvelope,
  parseSecretEnvelope,
  resealSecretForDaemon,
} from "../client/authn/data-encryption.ts";
import type {
  DerivedSecretsConfig,
  SecretsConfig,
} from "../client/authn/secrets.ts";
import {
  getServerDaemonStateByServerId,
  isDaemonKeyActive,
} from "./authn/server-identity-db.ts";
import { reapplyBindingOwnedVariables } from "../client/bindings/materialize.ts";
import {
  mergeHostingVariablesForService,
  type ResolvedVariableMap,
  resolveInheritedVariablesForService,
  resolveServerScopedVariables,
} from "../client/variables/resolve-inherited.ts";
import type { Db } from "../db.ts";
import {
  type EnvironmentDeploySecretPlanEntry,
  type EnvironmentDeployVariableMaterial,
  parseDeploySecretPlan,
} from "../lib/commands/schemas.ts";
import { deployment, environment, service } from "../lib/db/schema.ts";

export type RehydrateDeploymentRequest = {
  projectId: string;
  environmentId: string;
  generation?: number;
};

export type RehydrateDeploymentResult = {
  projectId: string;
  environmentId: string;
  generation: number;
  secretPlan: EnvironmentDeploySecretPlanEntry[];
  variableMaterial: EnvironmentDeployVariableMaterial[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fail-closed: rehydrate must not reseal plaintext, malformed `tpsecret`, or
 * leftover `tpdaemon` delivery envelopes as if they were at-rest material.
 */
class RehydrateSecretMaterialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RehydrateSecretMaterialError";
  }
}

function requireAtRestSecretEnvelope(key: string, value: string): void {
  if (parseSecretEnvelope(value) !== null) return;

  if (
    parseDaemonSecretEnvelope(value) !== null || isDaemonSealedEnvelope(value)
  ) {
    throw new RehydrateSecretMaterialError(
      `secret ${key} is a tpdaemon envelope; rehydrate requires at-rest tpsecret`,
    );
  }
  if (value.startsWith(ENVELOPE_PREFIX_SECRET)) {
    throw new RehydrateSecretMaterialError(
      `secret ${key} is a malformed tpsecret envelope`,
    );
  }
  throw new RehydrateSecretMaterialError(
    `secret ${key} is plaintext; rehydrate requires at-rest tpsecret`,
  );
}

export function parseRehydrateRequestBody(
  body: unknown,
): RehydrateDeploymentRequest[] {
  return parseRequestDeployments(body);
}

function parseRequestDeployments(value: unknown): RehydrateDeploymentRequest[] {
  if (!isRecord(value) || !Array.isArray(value.deployments)) {
    throw new TypeError("deployments must be an array");
  }
  const out: RehydrateDeploymentRequest[] = [];
  for (const entry of value.deployments) {
    if (!isRecord(entry)) continue;
    if (
      typeof entry.projectId !== "string" ||
      typeof entry.environmentId !== "string"
    ) {
      continue;
    }
    const item: RehydrateDeploymentRequest = {
      projectId: entry.projectId,
      environmentId: entry.environmentId,
    };
    if (
      typeof entry.generation === "number" && Number.isFinite(entry.generation)
    ) {
      item.generation = entry.generation;
    }
    out.push(item);
  }
  return out;
}

function secretPlanFromOptions(
  options: unknown,
): EnvironmentDeploySecretPlanEntry[] {
  if (!isRecord(options)) return [];
  try {
    return parseDeploySecretPlan(options.secretPlan) ?? [];
  } catch {
    return [];
  }
}

async function resolveServiceVariableMap(
  db: Db,
  environmentId: string,
  composeServiceName: string,
  serverId: string,
): Promise<ResolvedVariableMap> {
  const [row] = await db
    .select({ id: service.id })
    .from(service)
    .where(
      and(
        eq(service.environmentId, environmentId),
        eq(service.composeServiceName, composeServiceName),
      ),
    )
    .limit(1);
  if (!row) {
    const serverVars = await resolveServerScopedVariables(db, serverId);
    return serverVars;
  }
  const varMap = await resolveInheritedVariablesForService(db, row.id);
  await mergeHostingVariablesForService(db, row.id, varMap);
  await reapplyBindingOwnedVariables(db, row.id, varMap);
  const serverVars = await resolveServerScopedVariables(db, serverId);
  return new Map([...varMap, ...serverVars]);
}

export async function buildDeploymentSecretsRehydrate(
  c: Context,
  db: Db,
  body: unknown,
): Promise<{ deployments: RehydrateDeploymentResult[] } | Response> {
  const dataEncryptionSecrets = c.get("dataEncryptionSecrets");
  const secretsConfig = c.get("secretsConfig");
  if (!dataEncryptionSecrets || !secretsConfig) {
    return c.json({ ok: false, error: "encryption unavailable" }, 503);
  }

  const daemonServerId = c.get("daemonServerId") as string;
  const daemonState = await getServerDaemonStateByServerId(db, daemonServerId);
  if (!daemonState || !isDaemonKeyActive(daemonState.key)) {
    return c.json(
      { ok: false, error: "No encryption-capable daemon key" },
      422,
    );
  }
  const keyId = daemonState.key.id;

  let requested: RehydrateDeploymentRequest[];
  try {
    requested = parseRequestDeployments(body);
  } catch {
    return c.json({ ok: false, error: "invalid body" }, 400);
  }

  const results: RehydrateDeploymentResult[] = [];
  for (const item of requested) {
    const result = await rehydrateOneDeployment(
      db,
      item,
      daemonServerId,
      keyId,
      dataEncryptionSecrets,
      secretsConfig,
    );
    if (result) results.push(result);
  }

  return { deployments: results };
}

async function collectRehydrateVariableMaterial(
  db: Db,
  item: RehydrateDeploymentRequest,
  daemonServerId: string,
  keyId: string,
  secretPlan: EnvironmentDeploySecretPlanEntry[],
  dataEncryptionSecrets: DerivedSecretsConfig,
  secretsConfig: SecretsConfig,
): Promise<EnvironmentDeployVariableMaterial[]> {
  const variableMaterial: EnvironmentDeployVariableMaterial[] = [];
  const maps = new Map<string, ResolvedVariableMap>();

  for (const plan of secretPlan) {
    let varMap = maps.get(plan.composeServiceName);
    if (!varMap) {
      varMap = await resolveServiceVariableMap(
        db,
        item.environmentId,
        plan.composeServiceName,
        daemonServerId,
      );
      maps.set(plan.composeServiceName, varMap);
    }
    const entry = varMap.get(plan.key);
    if (!entry?.isSecret) continue;
    requireAtRestSecretEnvelope(plan.key, entry.value);
    const valueEnvelope = await resealSecretForDaemon(
      secretsConfig,
      dataEncryptionSecrets,
      { serverId: daemonServerId, keyId },
      entry.value,
    );
    variableMaterial.push({
      key: plan.key,
      composeServiceName: plan.composeServiceName,
      forBuild: plan.forBuild,
      forRuntime: plan.forRuntime,
      isLiteral: entry.isLiteral,
      valueEnvelope,
    });
  }
  return variableMaterial;
}

async function rehydrateOneDeployment(
  db: Db,
  item: RehydrateDeploymentRequest,
  daemonServerId: string,
  keyId: string,
  dataEncryptionSecrets: DerivedSecretsConfig,
  secretsConfig: SecretsConfig,
): Promise<RehydrateDeploymentResult | null> {
  const [envRow] = await db
    .select({ id: environment.id, projectId: environment.projectId })
    .from(environment)
    .where(eq(environment.id, item.environmentId))
    .limit(1);
  if (envRow?.projectId !== item.projectId) return null;

  const [deployRow] = await db
    .select()
    .from(deployment)
    .where(
      and(
        eq(deployment.environmentId, item.environmentId),
        eq(deployment.serverId, daemonServerId),
      ),
    )
    .limit(1);
  if (!deployRow) return null;

  if (
    typeof item.generation === "number" &&
    item.generation !== deployRow.desiredGeneration
  ) {
    return null;
  }

  const secretPlan = secretPlanFromOptions(deployRow.options);
  try {
    const variableMaterial = await collectRehydrateVariableMaterial(
      db,
      item,
      daemonServerId,
      keyId,
      secretPlan,
      dataEncryptionSecrets,
      secretsConfig,
    );
    return {
      projectId: item.projectId,
      environmentId: item.environmentId,
      generation: deployRow.desiredGeneration,
      secretPlan,
      variableMaterial,
    };
  } catch (err) {
    if (err instanceof RehydrateSecretMaterialError) {
      return null;
    }
    throw err;
  }
}
