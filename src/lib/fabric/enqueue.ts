/**
 * Enqueue `server.fabric.reconcile` for TurboFabric relays.
 */

import type { Db } from "../../db.ts";
import type { DaemonCellRegistry } from "../../daemon/cell/contracts.ts";
import type {
  DerivedSecretsConfig,
  SecretsConfig,
} from "../../client/authn/secrets.ts";
import { resealSecretForDaemon } from "../../client/authn/data-encryption.ts";
import { getServerDaemonStateByServerId } from "../../daemon/authn/server-identity-db.ts";
import { isDaemonKeyActive } from "../../daemon/authn/daemon-state.ts";
import { compatLogWarn } from "../../log-compat.ts";
import type { CommandEnvelope } from "../commands/envelope.ts";
import type { CommandQueue } from "../commands/queue.ts";
import {
  createCommandRecord,
  transitionCommand,
} from "../db/command-records.ts";
import {
  buildFabricReconcilePayloadFromSnapshot,
  ensureFabricRelays,
  FabricAllocationError,
  type FabricReconcileSnapshot,
  type FabricRecord,
  getOrganizationFabric,
  loadFabricReconcileSnapshot,
  type RelayRecord,
} from "../db/fabric-records.ts";
import type { FabricReconcileCommandPayload } from "../commands/schemas.ts";
import {
  awaitFabricReconcile,
  FABRIC_GATE_POLL_MS,
  FABRIC_GATE_TIMEOUT_MS,
  type FabricGateCommand,
  type FabricGateOutcome,
} from "./gate.ts";
import {
  fabricNeedsRendezvous,
  hydrateFabricPathStates,
  runFabricRendezvousRound,
  type FabricRendezvousRoundResult,
} from "./rendezvous.ts";

export type FabricEnqueueResult = {
  serverId: string;
  commandId?: string;
  status: "queued" | "failed" | "skipped" | "converged";
  error?: string;
  unreachablePeers?: Array<{ serverId: string }>;
  gatewayRoutedPeers?: Array<{ serverId: string; viaServerId: string }>;
  natCandidates?: number;
  degradedPeers?: number;
};

export { fabricNeedsRendezvous } from "./rendezvous.ts";

export type FabricEnqueueTypedError =
  | "relay_endpoint_unavailable"
  | "fabric_segment_pool_exhausted"
  | "relay_missing";

const TYPED_ENQUEUE_ERRORS = new Set<FabricEnqueueTypedError>([
  "relay_endpoint_unavailable",
  "fabric_segment_pool_exhausted",
  "relay_missing",
]);

export function fabricEnqueueTypedError(
  results: readonly FabricEnqueueResult[],
): FabricEnqueueTypedError | null {
  for (const row of results) {
    if (row.error === "relay_endpoint_unavailable") {
      return "relay_endpoint_unavailable";
    }
    if (row.error === "fabric_segment_pool_exhausted") {
      return "fabric_segment_pool_exhausted";
    }
    if (row.error === "relay_missing") return "relay_missing";
  }
  return null;
}

export function isFabricEnqueueTypedError(
  value: string,
): value is FabricEnqueueTypedError {
  return TYPED_ENQUEUE_ERRORS.has(value as FabricEnqueueTypedError);
}

export function relayNeedsFabricEnqueue(
  appliedPayloadHash: string | undefined,
  desiredHash: string,
  force = false,
): boolean {
  if (force) return true;
  return appliedPayloadHash !== desiredHash;
}

type FabricSecretDeps = {
  secretsConfig?: SecretsConfig;
  dataEncryptionSecrets?: DerivedSecretsConfig;
};

function fabricSecretEnqueueFields(source: FabricSecretDeps): FabricSecretDeps {
  return {
    ...(source.secretsConfig ? { secretsConfig: source.secretsConfig } : {}),
    ...(source.dataEncryptionSecrets
      ? { dataEncryptionSecrets: source.dataEncryptionSecrets }
      : {}),
  };
}

async function resealPresharedKeyForTarget(
  db: Db,
  serverId: string,
  secrets: FabricSecretDeps,
  sealed: string,
): Promise<string | null> {
  if (!secrets.secretsConfig || !secrets.dataEncryptionSecrets) return null;
  const state = await getServerDaemonStateByServerId(db, serverId);
  const key = state?.key;
  if (!key || !isDaemonKeyActive(key)) {
    compatLogWarn(
      "fabric-enqueue",
      `omitting fabric PSK envelope for server ${serverId}: no active daemon key`,
    );
    return null;
  }
  try {
    return await resealSecretForDaemon(
      secrets.secretsConfig,
      secrets.dataEncryptionSecrets,
      { serverId, keyId: key.id },
      sealed,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    compatLogWarn(
      "fabric-enqueue",
      `omitting fabric PSK envelope for server ${serverId}: ${message}`,
    );
    return null;
  }
}

function enqueueFieldsFromPeerLists(
  unreachablePeers: Array<{ serverId: string }>,
  gatewayRoutedPeers: Array<{ serverId: string; viaServerId: string }>,
  extras?: Pick<FabricEnqueueResult, "natCandidates" | "degradedPeers">,
): Pick<
  FabricEnqueueResult,
  "unreachablePeers" | "gatewayRoutedPeers" | "natCandidates" | "degradedPeers"
> {
  const fields: Pick<
    FabricEnqueueResult,
    "unreachablePeers" | "gatewayRoutedPeers" | "natCandidates" | "degradedPeers"
  > = {};
  if (unreachablePeers.length > 0) fields.unreachablePeers = unreachablePeers;
  if (gatewayRoutedPeers.length > 0) {
    fields.gatewayRoutedPeers = gatewayRoutedPeers;
  }
  if (extras?.natCandidates && extras.natCandidates > 0) {
    fields.natCandidates = extras.natCandidates;
  }
  if (extras?.degradedPeers && extras.degradedPeers > 0) {
    fields.degradedPeers = extras.degradedPeers;
  }
  return fields;
}

function rendezvousCountsForServer(
  round: FabricRendezvousRoundResult | null,
  serverId: string,
): Pick<FabricEnqueueResult, "natCandidates" | "degradedPeers"> | undefined {
  if (!round) return undefined;
  const entries = round.summariesByServerId.get(serverId) ?? [];
  let natCandidates = 0;
  let degradedPeers = 0;
  for (const entry of entries) {
    if (entry.selected === "direct_nat") natCandidates += 1;
    if (entry.degraded) degradedPeers += 1;
  }
  if (natCandidates === 0 && degradedPeers === 0) return undefined;
  return {
    ...(natCandidates > 0 ? { natCandidates } : {}),
    ...(degradedPeers > 0 ? { degradedPeers } : {}),
  };
}

async function buildEnabledReconcilePayloadFromSnapshot(params: {
  db: Db;
  snapshot: FabricReconcileSnapshot;
  serverId: string;
  secrets?: FabricSecretDeps;
}): Promise<
  | {
    ok: true;
    payload: FabricReconcileCommandPayload;
    desiredHash: string;
    unreachablePeers: Array<{ serverId: string }>;
    gatewayRoutedPeers: Array<{ serverId: string; viaServerId: string }>;
  }
  | { ok: false; status: "skipped" | "failed"; error?: string }
> {
  try {
    const reseal = params.secrets
      ? (sealed: string) =>
        resealPresharedKeyForTarget(
          params.db,
          params.serverId,
          params.secrets!,
          sealed,
        )
      : undefined;
    const built = await buildFabricReconcilePayloadFromSnapshot(
      params.snapshot,
      {
        serverId: params.serverId,
        ...(reseal ? { resealPresharedKey: reseal } : {}),
      },
    );
    if (!built) return { ok: false, status: "skipped" };
    return {
      ok: true,
      payload: built.payload,
      desiredHash: built.desiredHash,
      unreachablePeers: built.unreachablePeers,
      gatewayRoutedPeers: built.gatewayRoutedPeers,
    };
  } catch (err) {
    if (err instanceof FabricAllocationError) {
      return { ok: false, status: "failed", error: err.kind };
    }
    throw err;
  }
}

function enqueueResultFromBuildFailure(
  serverId: string,
  built: Extract<
    Awaited<ReturnType<typeof buildEnabledReconcilePayloadFromSnapshot>>,
    { ok: false }
  >,
): FabricEnqueueResult {
  const result: FabricEnqueueResult = { serverId, status: built.status };
  if (built.error) result.error = built.error;
  return result;
}

export function isFabricMembershipConverged(params: {
  participatingServerIds: readonly string[];
  relays: readonly RelayRecord[];
  desiredHashByServer: ReadonlyMap<string, string>;
}): boolean {
  const byServer = new Map(params.relays.map((row) => [row.serverId, row]));
  for (const serverId of params.participatingServerIds) {
    const relay = byServer.get(serverId);
    if (!relay?.publicKey) return false;
    const desired = params.desiredHashByServer.get(serverId);
    if (!desired) return false;
    if (relay.metadata.appliedPayloadHash !== desired) return false;
  }
  return params.participatingServerIds.length > 0;
}

function queuedFabricCommands(
  results: readonly FabricEnqueueResult[],
): FabricGateCommand[] {
  const commands: FabricGateCommand[] = [];
  for (const row of results) {
    if (row.status === "queued" && row.commandId) {
      commands.push({ serverId: row.serverId, commandId: row.commandId });
    }
  }
  return commands;
}

function typedEnqueueFailure(
  results: readonly FabricEnqueueResult[],
  serverIds: readonly string[],
  typed: FabricEnqueueTypedError,
): Extract<FabricGateOutcome, { kind: "failed" }> {
  const match = results.find((row) => row.error === typed);
  return {
    kind: "failed",
    serverId: match?.serverId ?? serverIds[0] ?? "",
    commandId: match?.commandId ?? "",
    error: typed,
  };
}

function pendingMembershipOutcome(
  queued: readonly FabricGateCommand[],
  serverIds: readonly string[],
): Extract<FabricGateOutcome, { kind: "pending" }> {
  return {
    kind: "pending",
    pending: queued.length > 0
      ? [...queued]
      : serverIds.map((serverId) => ({ serverId, commandId: "" })),
  };
}

let fabricConvergenceTimeoutMsForTests: number | undefined;
let fabricConvergencePollMsForTests: number | undefined;

/** Test-only: shorten the deploy membership-convergence wait. */
export function setFabricConvergenceTimeoutMsForTests(
  ms: number | undefined,
): void {
  fabricConvergenceTimeoutMsForTests = ms;
}

/** Test-only: shorten the membership-convergence poll interval. */
export function setFabricConvergencePollMsForTests(
  ms: number | undefined,
): void {
  fabricConvergencePollMsForTests = ms;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function awaitQueuedFabricReconcile(params: {
  db: Db;
  queued: readonly FabricGateCommand[];
  remainingMs: number;
  pollIntervalMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}): Promise<FabricGateOutcome | null> {
  if (params.queued.length === 0) return null;
  const outcome = await awaitFabricReconcile(params.db, {
    commands: params.queued,
    timeoutMs: params.remainingMs,
    pollIntervalMs: params.pollIntervalMs,
    sleep: params.sleep,
    now: params.now,
  });
  if (outcome.kind === "ready") return null;
  return outcome;
}

async function desiredHashesForServers(params: {
  db: Db;
  snapshot: FabricReconcileSnapshot;
  serverIds: readonly string[];
  secrets: FabricSecretDeps;
}): Promise<Map<string, string>> {
  const desiredHashByServer = new Map<string, string>();
  for (const serverId of params.serverIds) {
    const built = await buildEnabledReconcilePayloadFromSnapshot({
      db: params.db,
      snapshot: params.snapshot,
      serverId,
      secrets: params.secrets,
    });
    if (built.ok) desiredHashByServer.set(serverId, built.desiredHash);
  }
  return desiredHashByServer;
}

async function participatingConvergenceAttempt(params: {
  db: Db;
  commandQueue: CommandQueue;
  actorType: string;
  actorId: string;
  fabric: FabricRecord;
  serverIds: readonly string[];
  secrets: FabricSecretDeps;
  timeoutMs: number;
  pollIntervalMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  startedAt: number;
}): Promise<FabricGateOutcome | "retry"> {
  const remainingMs = Math.max(
    0,
    params.timeoutMs - (params.now() - params.startedAt),
  );
  const results = await enqueueFabricReconcileForServers({
    db: params.db,
    commandQueue: params.commandQueue,
    actorType: params.actorType,
    actorId: params.actorId,
    fabric: params.fabric,
    serverIds: params.serverIds,
    enabled: true,
    skipConverged: true,
    ...fabricSecretEnqueueFields(params.secrets),
  });
  const typed = fabricEnqueueTypedError(results);
  if (typed) return typedEnqueueFailure(results, params.serverIds, typed);

  const queued = queuedFabricCommands(results);
  const queuedOutcome = await awaitQueuedFabricReconcile({
    db: params.db,
    queued,
    remainingMs,
    pollIntervalMs: params.pollIntervalMs,
    sleep: params.sleep,
    now: params.now,
  });
  if (queuedOutcome) return queuedOutcome;

  const snapshot = await loadFabricReconcileSnapshot(
    params.db,
    params.fabric,
  );
  const desiredHashByServer = await desiredHashesForServers({
    db: params.db,
    snapshot,
    serverIds: params.serverIds,
    secrets: params.secrets,
  });
  if (
    isFabricMembershipConverged({
      participatingServerIds: params.serverIds,
      relays: snapshot.relays,
      desiredHashByServer,
    })
  ) {
    return { kind: "ready" };
  }
  if (params.now() - params.startedAt >= params.timeoutMs) {
    return pendingMembershipOutcome(queued, params.serverIds);
  }
  if (queued.length === 0) {
    await params.sleep(params.pollIntervalMs);
  }
  return "retry";
}

/**
 * Enqueue hash-gated reconcile for participating relays, wait, then re-read
 * and enqueue any follow-up peer payloads after public keys land. Ready only
 * when every participating relay has a public key and its applied hash matches
 * the desired hash that includes peers, prefixes, and networks.
 */
export async function awaitParticipatingFabricConvergence(params: {
  db: Db;
  commandQueue: CommandQueue;
  actorType: string;
  actorId: string;
  fabric: FabricRecord;
  serverIds: readonly string[];
  secretsConfig?: SecretsConfig;
  dataEncryptionSecrets?: DerivedSecretsConfig;
  timeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<FabricGateOutcome> {
  const timeoutMs = params.timeoutMs ??
    fabricConvergenceTimeoutMsForTests ??
    FABRIC_GATE_TIMEOUT_MS;
  const pollIntervalMs = params.pollIntervalMs ??
    fabricConvergencePollMsForTests ??
    FABRIC_GATE_POLL_MS;
  const sleep = params.sleep ?? defaultSleep;
  const now = params.now ?? Date.now;
  const attempt = {
    db: params.db,
    commandQueue: params.commandQueue,
    actorType: params.actorType,
    actorId: params.actorId,
    fabric: params.fabric,
    serverIds: params.serverIds,
    secrets: fabricSecretEnqueueFields(params),
    timeoutMs,
    pollIntervalMs,
    sleep,
    now,
    startedAt: now(),
  };

  while (true) {
    const outcome = await participatingConvergenceAttempt(attempt);
    if (outcome !== "retry") return outcome;
  }
}

async function enqueueOne(params: {
  db: Db;
  commandQueue: CommandQueue;
  actorType: string;
  actorId: string;
  serverId: string;
  payload: FabricReconcileCommandPayload;
  expiresAt: string;
  desiredHash?: string;
  unreachablePeers?: Array<{ serverId: string }>;
  gatewayRoutedPeers?: Array<{ serverId: string; viaServerId: string }>;
}): Promise<FabricEnqueueResult> {
  const reachability = enqueueFieldsFromPeerLists(
    params.unreachablePeers ?? [],
    params.gatewayRoutedPeers ?? [],
  );
  try {
    const record = await createCommandRecord(params.db, {
      serverId: params.serverId,
      actorType: params.actorType,
      actorId: params.actorId,
      type: "server.fabric.reconcile",
      payload: params.payload,
      expiresAt: params.expiresAt,
      ...(params.desiredHash
        ? { metadata: { desiredHash: params.desiredHash } }
        : {}),
    });
    const envelope: CommandEnvelope = {
      commandId: record.id,
      serverId: params.serverId,
      type: "server.fabric.reconcile",
      attempt: 1,
      queuedAt: record.queuedAt ?? record.createdAt,
    };
    try {
      await params.commandQueue.enqueue(envelope);
    } catch {
      await transitionCommand(params.db, record.id, {
        status: "failed",
        error: "Command queue unavailable",
      });
      return {
        serverId: params.serverId,
        commandId: record.id,
        status: "failed",
        error: "Command queue unavailable",
      };
    }
    return {
      serverId: params.serverId,
      commandId: record.id,
      status: "queued",
      ...reachability,
    };
  } catch {
    return {
      serverId: params.serverId,
      status: "failed",
      error: "enqueue_failed",
    };
  }
}

function loadEnabledFabricSnapshot(
  db: Db,
  enabled: boolean,
  fabric: FabricRecord | null,
): Promise<FabricReconcileSnapshot | null> {
  if (!enabled || !fabric) return Promise.resolve(null);
  return loadFabricReconcileSnapshot(db, fabric);
}

function appliedPayloadHashByServer(
  snapshot: FabricReconcileSnapshot | null,
  skipConverged?: boolean,
): Map<string, string | undefined> {
  const applied = new Map<string, string | undefined>();
  if (!skipConverged || !snapshot) return applied;
  for (const row of snapshot.relays) {
    applied.set(row.serverId, row.metadata.appliedPayloadHash);
  }
  return applied;
}

async function enqueueFabricReconcileForServer(params: {
  db: Db;
  commandQueue: CommandQueue;
  actorType: string;
  actorId: string;
  expiresAt: string;
  secrets: FabricSecretDeps;
  enabled: boolean;
  fabric: FabricRecord | null;
  snapshot: FabricReconcileSnapshot | null;
  serverId: string;
  skipConverged: boolean;
  appliedHashByServer: ReadonlyMap<string, string | undefined>;
}): Promise<FabricEnqueueResult> {
  if (!params.enabled) {
    return enqueueOne({
      db: params.db,
      commandQueue: params.commandQueue,
      actorType: params.actorType,
      actorId: params.actorId,
      serverId: params.serverId,
      payload: { enabled: false },
      expiresAt: params.expiresAt,
    });
  }
  if (!params.fabric || !params.snapshot) {
    return { serverId: params.serverId, status: "skipped" };
  }
  const built = await buildEnabledReconcilePayloadFromSnapshot({
    db: params.db,
    snapshot: params.snapshot,
    serverId: params.serverId,
    secrets: params.secrets,
  });
  if (!built.ok) {
    return enqueueResultFromBuildFailure(params.serverId, built);
  }
  if (
    params.skipConverged &&
    !relayNeedsFabricEnqueue(
      params.appliedHashByServer.get(params.serverId),
      built.desiredHash,
    )
  ) {
    return {
      serverId: params.serverId,
      status: "converged",
      ...enqueueFieldsFromPeerLists(
        built.unreachablePeers,
        built.gatewayRoutedPeers,
      ),
    };
  }
  return enqueueOne({
    db: params.db,
    commandQueue: params.commandQueue,
    actorType: params.actorType,
    actorId: params.actorId,
    serverId: params.serverId,
    payload: built.payload,
    expiresAt: params.expiresAt,
    desiredHash: built.desiredHash,
    ...enqueueFieldsFromPeerLists(
      built.unreachablePeers,
      built.gatewayRoutedPeers,
    ),
  });
}

export async function enqueueFabricReconcileForServers(params: {
  db: Db;
  commandQueue: CommandQueue;
  actorType: string;
  actorId: string;
  fabric: FabricRecord | null;
  serverIds: readonly string[];
  enabled: boolean;
  skipConverged?: boolean;
  secretsConfig?: SecretsConfig;
  dataEncryptionSecrets?: DerivedSecretsConfig;
}): Promise<FabricEnqueueResult[]> {
  const expiresAt = new Date(Date.now() + 300_000).toISOString();
  const secrets = fabricSecretEnqueueFields(params);
  const snapshot = await loadEnabledFabricSnapshot(
    params.db,
    params.enabled,
    params.fabric,
  );
  const appliedHashByServer = appliedPayloadHashByServer(
    snapshot,
    params.skipConverged,
  );
  const results: FabricEnqueueResult[] = [];
  for (const serverId of params.serverIds) {
    results.push(
      await enqueueFabricReconcileForServer({
        db: params.db,
        commandQueue: params.commandQueue,
        actorType: params.actorType,
        actorId: params.actorId,
        expiresAt,
        secrets,
        enabled: params.enabled,
        fabric: params.fabric,
        snapshot,
        serverId,
        skipConverged: params.skipConverged === true,
        appliedHashByServer,
      }),
    );
  }
  return results;
}

export async function reconcileFabricMembership(params: {
  db: Db;
  commandQueue: CommandQueue;
  actorType: string;
  actorId: string;
  organizationId: string;
  secretsConfig?: SecretsConfig;
  dataEncryptionSecrets?: DerivedSecretsConfig;
  force?: boolean;
  registry?: DaemonCellRegistry;
}): Promise<FabricEnqueueResult[]> {
  const fabric = await getOrganizationFabric(params.db, params.organizationId);
  if (!fabric) return [];

  await ensureFabricRelays(params.db, {
    fabric,
    organizationId: params.organizationId,
  });
  const snapshot = await loadFabricReconcileSnapshot(params.db, fabric);
  let rendezvousRound: FabricRendezvousRoundResult | null = null;
  if (
    params.registry &&
    fabricNeedsRendezvous(snapshot.relays)
  ) {
    rendezvousRound = await runFabricRendezvousRound({
      db: params.db,
      registry: params.registry,
      fabricId: fabric.id,
      relays: snapshot.relays,
      pathStates: hydrateFabricPathStates(fabric.id, snapshot.relays),
      orgAllowRelay: snapshot.policy.allowRelay,
    });
    if (rendezvousRound) {
      snapshot.caches.natEndpointByPair = rendezvousRound.natEndpointByPair;
      snapshot.caches.failedPathKindsByPair =
        rendezvousRound.failedPathKindsByPair;
    }
  }
  const expiresAt = new Date(Date.now() + 300_000).toISOString();
  const secrets = fabricSecretEnqueueFields(params);
  const results: FabricEnqueueResult[] = [];
  const force = params.force === true;

  for (const row of snapshot.relays) {
    const built = await buildEnabledReconcilePayloadFromSnapshot({
      db: params.db,
      snapshot,
      serverId: row.serverId,
      secrets,
    });
    const counts = rendezvousCountsForServer(rendezvousRound, row.serverId);
    if (!built.ok) {
      results.push({
        ...enqueueResultFromBuildFailure(row.serverId, built),
        ...counts,
      });
      continue;
    }
    if (
      !relayNeedsFabricEnqueue(
        row.metadata.appliedPayloadHash,
        built.desiredHash,
        force,
      )
    ) {
      results.push({
        serverId: row.serverId,
        status: "skipped",
        ...enqueueFieldsFromPeerLists(
          built.unreachablePeers,
          built.gatewayRoutedPeers,
          counts,
        ),
      });
      continue;
    }
    results.push({
      ...(await enqueueOne({
        db: params.db,
        commandQueue: params.commandQueue,
        actorType: params.actorType,
        actorId: params.actorId,
        serverId: row.serverId,
        payload: built.payload,
        expiresAt,
        desiredHash: built.desiredHash,
        ...enqueueFieldsFromPeerLists(
          built.unreachablePeers,
          built.gatewayRoutedPeers,
        ),
      })),
      ...counts,
    });
  }
  return results;
}
