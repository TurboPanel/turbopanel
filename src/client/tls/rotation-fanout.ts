/**
 * Organization CA rotation fan-out: enumerate org-scoped managed targets and
 * enqueue `managed.apply` / `managed.ingress.reconcile` plus binding rematerialize.
 *
 * Does **not** enqueue `environment.deploy` — consumer compose pick-up of the
 * new `<PREFIX>_CA_CERT` is surfaced as `needsRedeploy`.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Context } from "hono";
import type { AppEnv } from "../../app.ts";
import type { Db } from "../../db.ts";
import { materializeBindingsForPrincipal } from "../bindings/materialize.ts";
import {
  enqueuePreparedManagedApply,
  isPrepareError,
  prepareManagedApplyPayloads,
} from "../managed/apply-prepare.ts";
import { enqueueManagedIngressReconcile } from "../managed/ingress-desired.ts";
import { parseManagedRowOptions } from "../managed/options.ts";
import { parseManagedResidual } from "../managed/serialize.ts";
import type { DerivedSecretsConfig, SecretsConfig } from "../authn/secrets.ts";
import type { CommandQueue } from "../../lib/commands/queue.ts";
import { getManagedEngineSpec } from "../../lib/managed/index.ts";
import {
  parseProjectOptions,
  resolveEffectivePlacementServerId,
} from "../../lib/project-options.ts";
import {
  binding,
  environment,
  managed,
  node,
  principal,
  project,
  server,
  service,
  task,
  workspace,
} from "../../lib/db/schema.ts";
import { updateCaRotationJournal } from "./rotation-lease.ts";

export const ROTATION_FANOUT_BATCH_SIZE = 10;

export type CaRotationFanoutKind = "ingress" | "apply" | "binding";

export type CaRotationResultRow = {
  serverId: string;
  kind: CaRotationFanoutKind;
  managedId?: string;
  commandId?: string;
  status: string;
  error?: string;
};

export type CaRotationNeedsRedeploy = {
  serverId: string;
  environmentId: string;
};

export type OrganizationRotationMember = {
  serverId: string;
  managedId: string;
};

export type OrganizationRotationTargets = {
  members: OrganizationRotationMember[];
  managedIds: string[];
  ingressServerIds: string[];
};

export type CaRotationFanoutParams = Readonly<{
  organizationId: string;
  secretsConfig: SecretsConfig;
  dataEncryptionSecrets: DerivedSecretsConfig;
  actorType: "user" | "system";
  actorId: string;
  cursor?: string;
  limit?: number;
  priorNeedsRedeploy?: CaRotationNeedsRedeploy[];
}>;

export type CaRotationFanoutOutcome = {
  results: CaRotationResultRow[];
  needsRedeploy: CaRotationNeedsRedeploy[];
  cursor: string | null;
  complete: boolean;
};

type RotationManagedRow = {
  id: string;
  environmentId: string;
  serverId: string | null;
  engine: string | null;
  metadata: unknown;
  options: unknown;
};

function compareId(a: string, b: string): number {
  return a.localeCompare(b);
}

function uniqueSorted(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort(compareId);
}

function addMember(
  members: OrganizationRotationMember[],
  serverId: string,
  managedId: string,
): void {
  if (!serverId || !managedId) return;
  members.push({ serverId, managedId });
}

/**
 * Collect `{ serverId, managedId }` pairs for nodes on this org's servers and
 * managed clusters owned by this org, then union bound-consumer servers.
 * Every query is `organizationId`-scoped; rows are filtered again in memory
 * so a mock that ignores `where` still cannot leak another org.
 */
export async function enumerateOrganizationRotationTargets(
  db: Db,
  organizationId: string,
): Promise<OrganizationRotationTargets> {
  const members: OrganizationRotationMember[] = [];
  await collectMemberNodesForOrganization(db, organizationId, members);
  const ownedManagedIds = await loadOwnedManagedIds(db, organizationId);
  await collectOwnedClusterMembers(
    db,
    organizationId,
    ownedManagedIds,
    members,
  );
  await collectConsumerServers(db, organizationId, ownedManagedIds, members);

  return {
    members,
    managedIds: ownedManagedIds,
    ingressServerIds: uniqueSorted(members.map((row) => row.serverId)),
  };
}

async function collectMemberNodesForOrganization(
  db: Db,
  organizationId: string,
  members: OrganizationRotationMember[],
): Promise<void> {
  const rows = await db
    .select({
      serverId: node.serverId,
      managedId: node.managedId,
      serverOrganizationId: server.organizationId,
    })
    .from(node)
    .innerJoin(server, eq(node.serverId, server.id))
    .where(eq(server.organizationId, organizationId));

  for (const row of rows) {
    if (row.serverOrganizationId !== organizationId) continue;
    addMember(members, row.serverId, row.managedId);
  }
}

async function loadOwnedManagedIds(
  db: Db,
  organizationId: string,
): Promise<string[]> {
  const rows = await db
    .select({
      id: managed.id,
      workspaceOrganizationId: workspace.organizationId,
    })
    .from(managed)
    .innerJoin(environment, eq(managed.environmentId, environment.id))
    .innerJoin(project, eq(environment.projectId, project.id))
    .innerJoin(workspace, eq(project.workspaceId, workspace.id))
    .where(eq(workspace.organizationId, organizationId))
    .orderBy(asc(managed.id));

  return uniqueSorted(
    rows
      .filter((row) => row.workspaceOrganizationId === organizationId)
      .map((row) => row.id),
  );
}

async function collectOwnedClusterMembers(
  db: Db,
  organizationId: string,
  ownedManagedIds: readonly string[],
  members: OrganizationRotationMember[],
): Promise<void> {
  if (ownedManagedIds.length === 0) return;
  const rows = await db
    .select({
      serverId: node.serverId,
      managedId: node.managedId,
      workspaceOrganizationId: workspace.organizationId,
    })
    .from(node)
    .innerJoin(managed, eq(node.managedId, managed.id))
    .innerJoin(environment, eq(managed.environmentId, environment.id))
    .innerJoin(project, eq(environment.projectId, project.id))
    .innerJoin(workspace, eq(project.workspaceId, workspace.id))
    .where(
      and(
        eq(workspace.organizationId, organizationId),
        inArray(node.managedId, [...ownedManagedIds]),
      ),
    );
  for (const row of rows) {
    if (row.workspaceOrganizationId !== organizationId) continue;
    if (!ownedManagedIds.includes(row.managedId)) continue;
    addMember(members, row.serverId, row.managedId);
  }
}

async function collectConsumerServers(
  db: Db,
  organizationId: string,
  ownedManagedIds: readonly string[],
  members: OrganizationRotationMember[],
): Promise<void> {
  if (ownedManagedIds.length === 0) return;
  const rows = await db
    .select({
      managedId: principal.managedId,
      environmentServerId: environment.serverId,
      projectOptions: project.options,
      taskServerId: task.serverId,
      workspaceOrganizationId: workspace.organizationId,
    })
    .from(binding)
    .innerJoin(principal, eq(binding.principalId, principal.id))
    .innerJoin(service, eq(binding.serviceId, service.id))
    .innerJoin(environment, eq(service.environmentId, environment.id))
    .innerJoin(project, eq(environment.projectId, project.id))
    .innerJoin(workspace, eq(project.workspaceId, workspace.id))
    .leftJoin(task, eq(task.serviceId, service.id))
    .where(
      and(
        eq(workspace.organizationId, organizationId),
        inArray(principal.managedId, [...ownedManagedIds]),
      ),
    );

  for (const row of rows) {
    if (row.workspaceOrganizationId !== organizationId) continue;
    if (!row.managedId || !ownedManagedIds.includes(row.managedId)) continue;
    const placement = resolveEffectivePlacementServerId(
      row.environmentServerId,
      parseProjectOptions(row.projectOptions),
    );
    if (placement) addMember(members, placement, row.managedId);
    if (row.taskServerId) addMember(members, row.taskServerId, row.managedId);
  }
}

function nextManagedBatch(
  managedIds: readonly string[],
  cursor: string | undefined,
  limit: number,
): { batch: string[]; nextCursor: string | null; complete: boolean } {
  const start = cursor ? managedIds.findIndex((id) => id > cursor) : 0;
  const from = start < 0 ? managedIds.length : start;
  const batch = managedIds.slice(from, from + limit);
  const last = batch.at(-1);
  const complete = from + batch.length >= managedIds.length;
  return {
    batch,
    nextCursor: complete || !last ? null : last,
    complete,
  };
}

function applyResultRow(
  managedId: string,
  serverId: string,
  status: string,
  commandId?: string,
  error?: string,
): CaRotationResultRow {
  const row: CaRotationResultRow = {
    serverId,
    kind: "apply",
    managedId,
    status,
  };
  if (commandId) row.commandId = commandId;
  if (error) row.error = error;
  return row;
}

function ingressResultRow(
  serverId: string,
  status: string,
  commandId?: string,
  error?: string,
  managedId?: string,
): CaRotationResultRow {
  const row: CaRotationResultRow = { serverId, kind: "ingress", status };
  if (managedId) row.managedId = managedId;
  if (commandId) row.commandId = commandId;
  if (error) row.error = error;
  return row;
}

function bindingResultRow(
  managedId: string,
  serverId: string,
  error: string,
): CaRotationResultRow {
  return {
    serverId,
    kind: "binding",
    managedId,
    status: "failed",
    error,
  };
}

function dropBindingResult(
  results: CaRotationResultRow[],
  managedId: string,
): void {
  for (let i = results.length - 1; i >= 0; i--) {
    if (
      results[i]?.kind === "binding" && results[i]?.managedId === managedId
    ) {
      results.splice(i, 1);
    }
  }
}

type RematerializeOutcome =
  | { ok: true; needsRedeploy: CaRotationNeedsRedeploy[] }
  | { ok: false; error: string };

async function loadManagedRowsForRotation(
  db: Db,
  organizationId: string,
  managedIds: readonly string[],
): Promise<RotationManagedRow[]> {
  if (managedIds.length === 0) return [];
  const rows = await db
    .select({
      id: managed.id,
      environmentId: managed.environmentId,
      serverId: managed.serverId,
      engine: managed.engine,
      metadata: managed.metadata,
      options: managed.options,
      workspaceOrganizationId: workspace.organizationId,
    })
    .from(managed)
    .innerJoin(environment, eq(managed.environmentId, environment.id))
    .innerJoin(project, eq(environment.projectId, project.id))
    .innerJoin(workspace, eq(project.workspaceId, workspace.id))
    .where(
      and(
        eq(workspace.organizationId, organizationId),
        inArray(managed.id, [...managedIds]),
      ),
    )
    .orderBy(asc(managed.id));

  return rows
    .filter((row) => row.workspaceOrganizationId === organizationId)
    .map((row) => ({
      id: row.id,
      environmentId: row.environmentId,
      serverId: row.serverId,
      engine: row.engine,
      metadata: row.metadata,
      options: row.options,
    }));
}

async function rematerializeClusterBindings(
  db: Db,
  managedId: string,
  dataEncryptionSecrets: DerivedSecretsConfig,
): Promise<RematerializeOutcome> {
  const principals = await db
    .select({ id: principal.id })
    .from(principal)
    .where(eq(principal.managedId, managedId));
  for (const row of principals) {
    const result = await materializeBindingsForPrincipal(
      db,
      dataEncryptionSecrets,
      row.id,
    );
    if (!("ok" in result)) {
      return { ok: false, error: result.kind };
    }
  }
  return {
    ok: true,
    needsRedeploy: await loadNeedsRedeployForManaged(db, managedId),
  };
}

async function loadNeedsRedeployForManaged(
  db: Db,
  managedId: string,
): Promise<CaRotationNeedsRedeploy[]> {
  const rows = await db
    .select({
      environmentId: environment.id,
      environmentServerId: environment.serverId,
      projectOptions: project.options,
    })
    .from(binding)
    .innerJoin(principal, eq(binding.principalId, principal.id))
    .innerJoin(service, eq(binding.serviceId, service.id))
    .innerJoin(environment, eq(service.environmentId, environment.id))
    .innerJoin(project, eq(environment.projectId, project.id))
    .where(eq(principal.managedId, managedId));

  const seen = new Set<string>();
  const needs: CaRotationNeedsRedeploy[] = [];
  for (const row of rows) {
    const serverId = resolveEffectivePlacementServerId(
      row.environmentServerId,
      parseProjectOptions(row.projectOptions),
    );
    if (!serverId) continue;
    const key = `${serverId}:${row.environmentId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    needs.push({ serverId, environmentId: row.environmentId });
  }
  return needs;
}

export async function fanOutApplyForCluster(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  params: {
    actorId: string;
    organizationId: string;
    row: RotationManagedRow;
  },
): Promise<CaRotationResultRow[]> {
  const spec = params.row.engine
    ? getManagedEngineSpec(params.row.engine)
    : null;
  if (!spec || !params.row.serverId) {
    return [applyResultRow(
      params.row.id,
      params.row.serverId ?? params.organizationId,
      "failed",
      undefined,
      "managed_apply_unavailable",
    )];
  }
  const parsed = parseManagedRowOptions(spec, params.row.options);
  if (!parsed) {
    return [applyResultRow(
      params.row.id,
      params.row.serverId,
      "failed",
      undefined,
      "managed_settings_invalid",
    )];
  }
  const residual = parseManagedResidual(params.row.metadata);
  const prepared = await prepareManagedApplyPayloads(c, db, {
    managedRow: params.row,
    spec,
    settings: parsed.settings,
    databases: parsed.databases,
    serverId: params.row.serverId,
    environmentId: params.row.environmentId,
    organizationId: params.organizationId,
    rootUsername: residual.rootUsername ?? spec.rootUsername,
  });
  if (isPrepareError(prepared)) {
    return [applyResultRow(
      params.row.id,
      params.row.serverId,
      "failed",
      undefined,
      prepared.kind,
    )];
  }
  const enqueued = await enqueuePreparedManagedApply(c, db, commandQueue, {
    userId: params.actorId,
    managedId: params.row.id,
    members: prepared.members,
  });
  if (enqueued instanceof Response) {
    return [applyResultRow(
      params.row.id,
      params.row.serverId,
      "failed",
      undefined,
      "Command queue unavailable",
    )];
  }
  return enqueued.map((entry) =>
    applyResultRow(
      params.row.id,
      entry.serverId,
      entry.status,
      entry.commandId,
      entry.error,
    )
  );
}

/**
 * Load one org-scoped managed cluster and enqueue `managed.apply` for it.
 * Shared by Organization CA rotation fan-out and the leaf-renewal sweep.
 */
export async function enqueueApplyForManagedCluster(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  params: {
    actorId: string;
    organizationId: string;
    managedId: string;
  },
): Promise<CaRotationResultRow[]> {
  const rows = await loadManagedRowsForRotation(db, params.organizationId, [
    params.managedId,
  ]);
  const row = rows[0];
  if (!row) {
    return [
      applyResultRow(
        params.managedId,
        params.organizationId,
        "failed",
        undefined,
        "managed_not_found",
      ),
    ];
  }
  return fanOutApplyForCluster(c, db, commandQueue, {
    actorId: params.actorId,
    organizationId: params.organizationId,
    row,
  });
}

async function fanOutIngressForServers(
  db: Db,
  commandQueue: CommandQueue,
  params: {
    serverIds: readonly string[];
    actorType: "user" | "system";
    actorId: string;
    secretsConfig: SecretsConfig;
    dataEncryptionSecrets: DerivedSecretsConfig;
    alreadyQueued: Set<string>;
  },
): Promise<CaRotationResultRow[]> {
  const results: CaRotationResultRow[] = [];
  for (const serverId of params.serverIds) {
    if (params.alreadyQueued.has(serverId)) continue;
    params.alreadyQueued.add(serverId);
    const enqueued = await enqueueManagedIngressReconcile(db, commandQueue, {
      serverId,
      actorType: params.actorType,
      actorId: params.actorId,
      secretsConfig: params.secretsConfig,
      dataEncryptionSecrets: params.dataEncryptionSecrets,
    });
    if (enqueued.ok) {
      results.push(ingressResultRow(serverId, "queued", enqueued.commandId));
      continue;
    }
    if (enqueued.reason === "not_needed") continue;
    results.push(ingressResultRow(
      serverId,
      "failed",
      undefined,
      enqueued.reason,
    ));
  }
  return results;
}

function mergeNeedsRedeploy(
  into: CaRotationNeedsRedeploy[],
  extra: readonly CaRotationNeedsRedeploy[],
): void {
  const seen = new Set(
    into.map((row) => `${row.serverId}:${row.environmentId}`),
  );
  for (const row of extra) {
    const key = `${row.serverId}:${row.environmentId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    into.push(row);
  }
}

function rotationMetadata(
  cursor: string | null,
  needsRedeploy: readonly CaRotationNeedsRedeploy[],
): Record<string, unknown> {
  return {
    ...(cursor ? { resumeAfterManagedId: cursor } : {}),
    needsRedeploy,
  };
}

type RotationFanoutRunParams = CaRotationFanoutParams & {
  rotationId?: string;
  priorResults?: CaRotationResultRow[];
};

type RotationFanoutState = {
  results: CaRotationResultRow[];
  needsRedeploy: CaRotationNeedsRedeploy[];
  alreadyQueuedIngress: Set<string>;
  resumeAfter: string | null;
};

type RotationFanoutContext = {
  c: Context<AppEnv>;
  db: Db;
  commandQueue: CommandQueue;
  params: RotationFanoutRunParams;
  targets: OrganizationRotationTargets;
  state: RotationFanoutState;
  complete: boolean;
};

function journalCursor(complete: boolean, managedId: string): string | null {
  if (complete) return null;
  return managedId;
}

async function persistRotationProgress(
  db: Db,
  rotationId: string | undefined,
  state: Pick<RotationFanoutState, "results" | "needsRedeploy">,
  cursor: string | null,
): Promise<void> {
  if (!rotationId) return;
  await updateCaRotationJournal(db, rotationId, {
    results: state.results,
    metadata: rotationMetadata(cursor, state.needsRedeploy),
  });
}

async function recordMissingManagedCluster(
  ctx: RotationFanoutContext,
  managedId: string,
): Promise<void> {
  const { db, params, state, complete } = ctx;
  state.results.push(applyResultRow(
    managedId,
    params.organizationId,
    "failed",
    undefined,
    "managed_not_found",
  ));
  state.resumeAfter = managedId;
  await persistRotationProgress(
    db,
    params.rotationId,
    state,
    journalCursor(complete, managedId),
  );
}

async function recordBindingRematerializeFailure(
  ctx: RotationFanoutContext,
  managedId: string,
  row: RotationManagedRow,
  error: string,
): Promise<void> {
  const { db, params, state } = ctx;
  dropBindingResult(state.results, managedId);
  state.results.push(bindingResultRow(
    managedId,
    row.serverId ?? params.organizationId,
    error,
  ));
  await persistRotationProgress(
    db,
    params.rotationId,
    state,
    state.resumeAfter,
  );
}

async function fanOutOneManagedCluster(
  ctx: RotationFanoutContext,
  row: RotationManagedRow | undefined,
  managedId: string,
): Promise<"continue" | "abort"> {
  if (!row) {
    await recordMissingManagedCluster(ctx, managedId);
    return "continue";
  }
  const { c, db, commandQueue, params, targets, state, complete } = ctx;
  const applyRows = await fanOutApplyForCluster(c, db, commandQueue, {
    actorId: params.actorId,
    organizationId: params.organizationId,
    row,
  });
  state.results.push(...applyRows);

  const clusterServers = uniqueSorted(
    targets.members
      .filter((member) => member.managedId === managedId)
      .map((member) => member.serverId),
  );
  const ingressRows = await fanOutIngressForServers(db, commandQueue, {
    serverIds: clusterServers,
    actorType: params.actorType,
    actorId: params.actorId,
    secretsConfig: params.secretsConfig,
    dataEncryptionSecrets: params.dataEncryptionSecrets,
    alreadyQueued: state.alreadyQueuedIngress,
  });
  state.results.push(...ingressRows);

  const rematerialized = await rematerializeClusterBindings(
    db,
    managedId,
    params.dataEncryptionSecrets,
  );
  if (!rematerialized.ok) {
    await recordBindingRematerializeFailure(
      ctx,
      managedId,
      row,
      rematerialized.error,
    );
    return "abort";
  }
  dropBindingResult(state.results, managedId);
  mergeNeedsRedeploy(state.needsRedeploy, rematerialized.needsRedeploy);
  state.resumeAfter = managedId;
  await persistRotationProgress(
    db,
    params.rotationId,
    state,
    journalCursor(complete, managedId),
  );
  return "continue";
}

async function fanOutLeftoverIngress(
  ctx: RotationFanoutContext,
): Promise<void> {
  const { db, commandQueue, params, targets, state } = ctx;
  const leftoverIngress = targets.ingressServerIds.filter(
    (serverId) => !state.alreadyQueuedIngress.has(serverId),
  );
  const leftoverRows = await fanOutIngressForServers(db, commandQueue, {
    serverIds: leftoverIngress,
    actorType: params.actorType,
    actorId: params.actorId,
    secretsConfig: params.secretsConfig,
    dataEncryptionSecrets: params.dataEncryptionSecrets,
    alreadyQueued: state.alreadyQueuedIngress,
  });
  state.results.push(...leftoverRows);
  await persistRotationProgress(db, params.rotationId, state, null);
}

/**
 * Bounded/resumable fan-out across managed clusters in id order.
 * Persist each batch onto `tlsRotation.results` when `rotationId` is set.
 */
export async function runOrganizationCaRotationFanout(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  params: RotationFanoutRunParams,
): Promise<CaRotationFanoutOutcome> {
  const targets = await enumerateOrganizationRotationTargets(
    db,
    params.organizationId,
  );
  const limit = params.limit ?? ROTATION_FANOUT_BATCH_SIZE;
  const { batch, nextCursor, complete } = nextManagedBatch(
    targets.managedIds,
    params.cursor,
    limit,
  );
  const results: CaRotationResultRow[] = [...(params.priorResults ?? [])];
  const state: RotationFanoutState = {
    results,
    needsRedeploy: [...(params.priorNeedsRedeploy ?? [])],
    alreadyQueuedIngress: new Set(
      results.filter((row) => row.kind === "ingress").map((row) =>
        row.serverId
      ),
    ),
    resumeAfter: params.cursor ?? null,
  };
  const ctx: RotationFanoutContext = {
    c,
    db,
    commandQueue,
    params,
    targets,
    state,
    complete,
  };

  const rows = await loadManagedRowsForRotation(
    db,
    params.organizationId,
    batch,
  );
  const rowById = new Map(rows.map((row) => [row.id, row]));

  for (const managedId of batch) {
    const step = await fanOutOneManagedCluster(
      ctx,
      rowById.get(managedId),
      managedId,
    );
    if (step === "abort") {
      return {
        results: state.results,
        needsRedeploy: state.needsRedeploy,
        cursor: state.resumeAfter,
        complete: false,
      };
    }
  }

  if (complete) {
    await fanOutLeftoverIngress(ctx);
  }

  return {
    results: state.results,
    needsRedeploy: state.needsRedeploy,
    cursor: nextCursor,
    complete,
  };
}

export function parseCaRotationResults(value: unknown): CaRotationResultRow[] {
  if (!Array.isArray(value)) return [];
  const rows: CaRotationResultRow[] = [];
  for (const entry of value) {
    const parsed = parseOneCaRotationResult(entry);
    if (parsed) rows.push(parsed);
  }
  return rows;
}

function parseOneCaRotationResult(value: unknown): CaRotationResultRow | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.serverId !== "string" || typeof record.status !== "string"
  ) {
    return null;
  }
  if (
    record.kind !== "ingress" && record.kind !== "apply" &&
    record.kind !== "binding"
  ) {
    return null;
  }
  const row: CaRotationResultRow = {
    serverId: record.serverId,
    kind: record.kind,
    status: record.status,
  };
  if (typeof record.managedId === "string") row.managedId = record.managedId;
  if (typeof record.commandId === "string") row.commandId = record.commandId;
  if (typeof record.error === "string") row.error = record.error;
  return row;
}

export function parseResumeAfterManagedId(
  metadata: unknown,
): string | undefined {
  if (
    typeof metadata !== "object" || metadata === null || Array.isArray(metadata)
  ) {
    return undefined;
  }
  const cursor = (metadata as Record<string, unknown>).resumeAfterManagedId;
  return typeof cursor === "string" && cursor.length > 0 ? cursor : undefined;
}

export function parseNeedsRedeploy(
  metadata: unknown,
): CaRotationNeedsRedeploy[] {
  if (
    typeof metadata !== "object" || metadata === null || Array.isArray(metadata)
  ) {
    return [];
  }
  const raw = (metadata as Record<string, unknown>).needsRedeploy;
  if (!Array.isArray(raw)) return [];
  const rows: CaRotationNeedsRedeploy[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.serverId !== "string" ||
      typeof record.environmentId !== "string"
    ) {
      continue;
    }
    rows.push({
      serverId: record.serverId,
      environmentId: record.environmentId,
    });
  }
  return rows;
}

/** Exported for tests that assert cursor paging without a live DB. */
export function selectManagedBatchForRotation(
  managedIds: readonly string[],
  cursor: string | undefined,
  limit: number,
): { batch: string[]; nextCursor: string | null; complete: boolean } {
  return nextManagedBatch(managedIds, cursor, limit);
}
