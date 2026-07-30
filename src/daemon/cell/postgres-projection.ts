/**
 * Projection layer — the daemon cell writes meaningful state changes to Postgres here.
 *
 * Vocabulary:
 *   projection  = daemon cell → Postgres write (this module)
 *   server status read model = fleet-presence.ts / server-status.ts
 */
import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../../db.ts";
import {
  buildDefaultDaemonStatus,
  parseServerDaemonState,
  type ServerDaemonProjection,
  type ServerDaemonState,
  type ServerDaemonStatus,
  type UpdateProjection,
} from "../authn/daemon-state.ts";
import {
  getServerDaemonStateByServerId,
  type ServerDaemonStateWithMetadata,
} from "../authn/server-identity-db.ts";
import { server } from "../../lib/db/schema.ts";
import { normalizeMachineKey } from "../../lib/machine-key.ts";
import {
  parseServerTimeSync,
  serverTimeSyncEquals,
  type ServerMetadata,
  type ServerTimeSync,
} from "../../lib/db/server-metadata.ts";
import {
  parseServerAddresses,
  serverAddressesEquals,
  type ServerAddresses,
} from "../../server-addresses.ts";
import {
  geoEquals,
  parseServerGeo,
  type ServerGeo,
} from "../../lib/geo/server-geo.ts";
import type { DaemonCell, DaemonCellSnapshot } from "./contracts.ts";
import type { ServerStatusTransitionReason } from "../metrics/types.ts";
import {
  emitServerStatusEvent,
  type ServerStatusEventSink,
} from "../metrics/status-events.ts";

export type ProjectionIdentity = {
  hostname?: string;
  machineKey?: string;
  remoteAddress?: string;
  keyId?: string;
  geo?: ServerGeo;
  timeSync?: ServerTimeSync;
  addresses?: ServerAddresses;
};

export type ProjectionAgent = {
  commit: string;
  buildId: string;
  builtAt?: string;
  channel?: string;
};

export type ProjectionTrigger =
  | {
    kind: "online";
    identity: ProjectionIdentity;
    connectedAt?: string;
    reason?: ServerStatusTransitionReason;
  }
  | { kind: "offline"; reason?: ServerStatusTransitionReason }
  | { kind: "disconnected"; reason?: ServerStatusTransitionReason }
  | { kind: "heartbeat"; agent?: ProjectionAgent }
  | { kind: "identity"; identity: ProjectionIdentity }
  | {
    kind: "agent";
    agent: {
      commit: string;
      buildId: string;
      builtAt?: string;
      channel?: string;
    };
  }
  | {
    kind: "update-queued";
    requestId: string;
    channel: string;
    queuedAt: string;
  }
  | {
    kind: "update-result";
    requestId: string;
    ok: boolean;
    finishedAt: string;
    error?: string;
  }
  | {
    kind: "update-expired";
    requestId: string;
    finishedAt: string;
    error?: string;
  }
  | { kind: "update-reset" };

/** Status-backed read model for fleet presence — excludes hostname/machineKey (metadata). */
export type ServerDaemonProjectionRead = Omit<
  ServerDaemonProjection,
  "hostname" | "machineKey"
> & {
  update?: UpdateProjection;
  connected: boolean;
  connectedAt?: string | null;
  daemonConnected: boolean;
  daemonConnectedAt?: string | null;
};

/**
 * Cell-side coalesce window for inbound hello/heartbeat projection decisions.
 * Uses the cell's in-memory/Redis inbound marker (`cellLastSeenAt`) — never a
 * Postgres column. Survives independently of the removed Postgres debounce.
 */
export const INBOUND_PROJECTION_COALESCE_MS = 60_000;

function nowTs(): string {
  return new Date().toISOString();
}

function identityChanged(
  current: ServerDaemonProjection | undefined,
  identity: ProjectionIdentity,
): boolean {
  return (identity.hostname !== undefined &&
    identity.hostname !== current?.hostname) ||
    (identity.machineKey !== undefined &&
      identity.machineKey !== current?.machineKey) ||
    (identity.remoteAddress !== undefined &&
      identity.remoteAddress !== current?.remoteAddress) ||
    (identity.keyId !== undefined && identity.keyId !== current?.keyId);
}

function mergeIdentity(
  current: ServerDaemonProjection | undefined,
  identity: ProjectionIdentity,
): ProjectionIdentity {
  return {
    hostname: identity.hostname ?? current?.hostname,
    machineKey: identity.machineKey ?? current?.machineKey,
    remoteAddress: identity.remoteAddress ?? current?.remoteAddress,
    keyId: identity.keyId ?? current?.keyId,
  };
}

export function agentChanged(
  current: ServerDaemonProjection | undefined,
  agent: ProjectionAgent,
): boolean {
  const existing = current?.agent;
  if (existing?.commit !== agent.commit || existing?.buildId !== agent.buildId) {
    return true;
  }
  if (agent.builtAt !== undefined && agent.builtAt !== existing?.builtAt) {
    return true;
  }
  if (agent.channel !== undefined && agent.channel !== existing?.channel) {
    return true;
  }
  return false;
}

/** Retain the persisted build identity unless an incoming agent payload replaces it. */
export function mergeAgentPreserving(
  current: ServerDaemonProjection | undefined,
  incoming?: ProjectionAgent,
): ServerDaemonProjection["agent"] | undefined {
  if (!incoming) return current?.agent;
  const existing = current?.agent;
  if (
    existing?.commit === incoming.commit &&
    existing?.buildId === incoming.buildId
  ) {
    return {
      commit: incoming.commit,
      buildId: incoming.buildId,
      builtAt: incoming.builtAt ?? existing.builtAt,
      channel: incoming.channel ?? existing.channel,
    };
  }
  return incoming;
}

function remoteAddressChanged(
  current: ServerDaemonProjection | undefined,
  identity: ProjectionIdentity,
): boolean {
  const merged = mergeIdentity(current, identity);
  const incomingRemote = merged.remoteAddress?.trim();
  if (!incomingRemote) return false;

  const currentRemote = current?.remoteAddress?.trim();
  if (!currentRemote) return true;

  return incomingRemote !== currentRemote;
}

/**
 * Geo is refreshed when the connecting IP changes, when stored metadata.geo is
 * missing/invalid, or on first backfill — not on every reconnect or capturedAt churn.
 */
function geoRefreshDue(
  existingMetadata: ServerMetadata | null | undefined,
  currentProjection: ServerDaemonProjection | undefined,
  identity: ProjectionIdentity,
): boolean {
  const incomingGeo = identity.geo;
  if (incomingGeo === undefined) return false;

  const storedGeo = parseServerGeo(existingMetadata?.geo);
  if (storedGeo !== null && geoEquals(storedGeo, incomingGeo)) {
    return false;
  }

  if (remoteAddressChanged(currentProjection, identity)) {
    return true;
  }

  return storedGeo === null;
}

/** jsonb `||` delta — only keys that are actually changing (never stale nested facts). */
function buildMetadataPatch(
  existingMetadata: ServerMetadata | null | undefined,
  incomingGeo?: ServerGeo,
  identity?: ProjectionIdentity,
): Partial<ServerMetadata> | null {
  const delta: Partial<ServerMetadata> = {};

  if (incomingGeo !== undefined) {
    delta.geo = incomingGeo;
  }

  const timeSync = parseServerTimeSync(identity?.timeSync);
  if (timeSync) {
    const merged = { ...existingMetadata?.timeSync, ...timeSync };
    if (!serverTimeSyncEquals(merged, existingMetadata?.timeSync)) {
      delta.timeSync = merged;
    }
  }
  const addresses = identity?.addresses !== undefined
    ? parseServerAddresses(identity.addresses)
    : undefined;
  if (
    addresses !== undefined &&
    !serverAddressesEquals(addresses, existingMetadata?.addresses)
  ) {
    delta.addresses = addresses;
  }

  return Object.keys(delta).length > 0 ? delta : null;
}

/** Dedicated identity columns — hostname / machine_key (not metadata jsonb). */
function buildIdentityColumnPatch(
  existing: { hostname: string | null; machineKey: string | null },
  projection: ServerDaemonProjection | undefined,
): { hostname?: string; machineKey?: string } | null {
  const patch: { hostname?: string; machineKey?: string } = {};
  const hostname = projection?.hostname?.trim();
  if (hostname && hostname !== existing.hostname) {
    patch.hostname = hostname;
  }
  const machineKey = normalizeMachineKey(projection?.machineKey);
  if (machineKey && machineKey !== existing.machineKey) {
    patch.machineKey = machineKey;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

function buildIdentityProjection(
  current: ServerDaemonProjection | undefined,
  identity: ProjectionIdentity,
): ServerDaemonProjection {
  return {
    hostname: identity.hostname,
    machineKey: identity.machineKey,
    remoteAddress: identity.remoteAddress,
    keyId: identity.keyId,
    ...(current?.agent ? { agent: current.agent } : {}),
    ...(current?.update ? { update: current.update } : {}),
  };
}

/**
 * True when an inbound hello/heartbeat should open the Postgres projection path.
 *
 * Elapsed time alone never makes a heartbeat due — `last_seen_at` projection was
 * removed, so heartbeat-only traffic after {@link INBOUND_PROJECTION_COALESCE_MS}
 * must not open Hyperdrive. Due only for offline/runtime repair or agent change.
 * `cellLastSeenAt` / `inboundAt` remain for call-site compatibility.
 */
export function inboundHeartbeatProjectionDue(params: {
  runtimeConnected: boolean;
  /** Cell in-memory/Redis inbound marker — not a Postgres column. */
  cellLastSeenAt?: string | null;
  inboundAt: string;
  storedAgent?: ProjectionAgent;
  incomingAgent?: ProjectionAgent;
}): boolean {
  if (!params.runtimeConnected) return true;

  if (
    params.incomingAgent?.commit &&
    params.incomingAgent?.buildId &&
    agentChanged(
      params.storedAgent
        ? ({ agent: params.storedAgent } as ServerDaemonProjection)
        : undefined,
      params.incomingAgent,
    )
  ) {
    return true;
  }

  return false;
}

/** Skip Postgres reads/writes for steady-state heartbeats (cell already coalesced). */
export function steadyStateInboundSkipsDbRead(
  snapshot: DaemonCellSnapshot,
  opts: { at?: string; agent?: ProjectionAgent },
): boolean {
  if (!snapshot.connected || !opts.at) return false;
  return !inboundHeartbeatProjectionDue({
    runtimeConnected: true,
    cellLastSeenAt: snapshot.lastSeenAt ?? null,
    inboundAt: opts.at,
    storedAgent: snapshot.agent,
    incomingAgent: opts.agent,
  });
}

function buildMergedDaemonState(
  existing: ServerDaemonState,
  nextProjection: ServerDaemonProjection | undefined,
): ServerDaemonState {
  return {
    key: existing.key,
    ...(nextProjection ? { projection: nextProjection } : {}),
  };
}

function statusColumnPatch(status: ServerDaemonStatus): {
  connected: boolean;
  statusChangedAt: string | null;
} {
  return {
    connected: status.connected,
    statusChangedAt: status.statusChangedAt,
  };
}

type ProjectionTriggerContext = {
  existing: ServerDaemonStateWithMetadata;
  currentProjection: ServerDaemonProjection | undefined;
  existingStatus: ServerDaemonStatus;
  now: string;
  nowMs: number;
  agentHint?: ProjectionAgent;
};

/** Result of applying a single trigger kind; `null` means "no projection needed". */
type ProjectionOutcome = {
  touchMetadata: boolean;
  nextProjection: ServerDaemonProjection | undefined;
  writeProjection: boolean;
  nextStatus: ServerDaemonStatus;
  writeStatus: boolean;
  incomingGeo?: ServerGeo;
  geoDue: boolean;
} | null;

function applyOnlineTrigger(
  trigger: Extract<ProjectionTrigger, { kind: "online" }>,
  ctx: ProjectionTriggerContext,
): ProjectionOutcome {
  const { currentProjection, existingStatus, now, existing, agentHint } = ctx;
  const identity = mergeIdentity(currentProjection, trigger.identity);
  const isOfflineToOnline = !existingStatus.connected;
  const incomingGeo = trigger.identity.geo;
  const geoDue = geoRefreshDue(existing.metadata, currentProjection, trigger.identity);
  const identityDue = identityChanged(currentProjection, identity);
  const touchMetadata = identityDue || geoDue;

  let nextProjection = currentProjection;
  let writeProjection = false;
  if (identityDue || !currentProjection) {
    nextProjection = buildIdentityProjection(currentProjection, identity);
    if (agentHint) {
      nextProjection = {
        ...nextProjection,
        agent: mergeAgentPreserving(currentProjection, agentHint),
      };
    }
    writeProjection = true;
  } else if (agentHint && agentChanged(currentProjection, agentHint)) {
    nextProjection = {
      ...currentProjection,
      agent: mergeAgentPreserving(currentProjection, agentHint),
    };
    writeProjection = true;
  }

  if (!isOfflineToOnline && !writeProjection && !geoDue) {
    return null;
  }

  let nextStatus: ServerDaemonStatus = { ...existingStatus };
  let writeStatus = false;
  if (isOfflineToOnline) {
    nextStatus = {
      ...nextStatus,
      connected: true,
      statusChangedAt: trigger.connectedAt ?? now,
    };
    writeStatus = true;
  }

  return { touchMetadata, nextProjection, writeProjection, nextStatus, writeStatus, incomingGeo, geoDue };
}

function applyOfflineTrigger(ctx: ProjectionTriggerContext): ProjectionOutcome {
  const { currentProjection, existingStatus, now } = ctx;
  const nextStatus: ServerDaemonStatus = {
    ...existingStatus,
    connected: false,
    statusChangedAt: now,
  };
  return {
    touchMetadata: false,
    nextProjection: currentProjection,
    writeProjection: false,
    nextStatus,
    writeStatus: true,
    geoDue: false,
  };
}

function applyHeartbeatTrigger(
  trigger: Extract<ProjectionTrigger, { kind: "heartbeat" }>,
  ctx: ProjectionTriggerContext,
): ProjectionOutcome {
  const { currentProjection, existingStatus, agentHint } = ctx;
  const agent = trigger.agent ?? agentHint;
  const agentDue = Boolean(
    agent?.commit && agent?.buildId && agentChanged(currentProjection, agent),
  );

  if (!agentDue) {
    return null;
  }

  let nextProjection = currentProjection;
  let writeProjection = false;
  if (agentDue && agent) {
    nextProjection = {
      ...currentProjection,
      agent: mergeAgentPreserving(currentProjection, agent),
    };
    writeProjection = true;
  }

  return {
    touchMetadata: false,
    nextProjection,
    writeProjection,
    nextStatus: { ...existingStatus },
    writeStatus: false,
    geoDue: false,
  };
}

function applyIdentityTrigger(
  trigger: Extract<ProjectionTrigger, { kind: "identity" }>,
  ctx: ProjectionTriggerContext,
): ProjectionOutcome {
  const { currentProjection, existingStatus, existing } = ctx;
  const incomingGeo = trigger.identity.geo;
  const geoDue = geoRefreshDue(existing.metadata, currentProjection, trigger.identity);
  const identityDue = identityChanged(currentProjection, trigger.identity);
  if (!identityDue && !geoDue) {
    return null;
  }

  let nextProjection = currentProjection;
  let writeProjection = false;
  if (identityDue) {
    const identity = mergeIdentity(currentProjection, trigger.identity);
    nextProjection = buildIdentityProjection(currentProjection, identity);
    writeProjection = true;
  }

  return {
    touchMetadata: true,
    nextProjection,
    writeProjection,
    nextStatus: { ...existingStatus },
    writeStatus: false,
    incomingGeo,
    geoDue,
  };
}

function applyAgentTrigger(
  trigger: Extract<ProjectionTrigger, { kind: "agent" }>,
  ctx: ProjectionTriggerContext,
): ProjectionOutcome {
  const { currentProjection, existingStatus } = ctx;
  if (!agentChanged(currentProjection, trigger.agent)) {
    return null;
  }
  return {
    touchMetadata: false,
    nextProjection: {
      ...currentProjection,
      agent: mergeAgentPreserving(currentProjection, trigger.agent),
    },
    writeProjection: true,
    nextStatus: { ...existingStatus },
    writeStatus: false,
    geoDue: false,
  };
}

function applyUpdateQueuedTrigger(
  trigger: Extract<ProjectionTrigger, { kind: "update-queued" }>,
  ctx: ProjectionTriggerContext,
): ProjectionOutcome {
  const { currentProjection, existingStatus } = ctx;
  return {
    touchMetadata: false,
    nextProjection: {
      ...currentProjection,
      update: {
        status: "updating",
        requestId: trigger.requestId,
        channel: trigger.channel,
        queuedAt: trigger.queuedAt,
      },
    },
    writeProjection: true,
    nextStatus: { ...existingStatus },
    writeStatus: false,
    geoDue: false,
  };
}

function applyUpdateResultTrigger(
  trigger: Extract<ProjectionTrigger, { kind: "update-result" }>,
  ctx: ProjectionTriggerContext,
): ProjectionOutcome {
  const { currentProjection, existingStatus } = ctx;
  return {
    touchMetadata: false,
    nextProjection: {
      ...currentProjection,
      update: {
        status: trigger.ok ? "done" : "failed",
        requestId: trigger.requestId,
        finishedAt: trigger.finishedAt,
        ...(trigger.error ? { error: trigger.error } : {}),
      },
    },
    writeProjection: true,
    nextStatus: { ...existingStatus },
    writeStatus: false,
    geoDue: false,
  };
}

function applyUpdateExpiredTrigger(
  trigger: Extract<ProjectionTrigger, { kind: "update-expired" }>,
  ctx: ProjectionTriggerContext,
): ProjectionOutcome {
  const { currentProjection, existingStatus } = ctx;
  const currentUpdate = currentProjection?.update;
  if (currentUpdate?.status !== "updating") {
    return null;
  }
  if (
    currentUpdate.requestId &&
    trigger.requestId &&
    currentUpdate.requestId !== trigger.requestId
  ) {
    return null;
  }

  return {
    touchMetadata: false,
    nextProjection: {
      ...currentProjection,
      update: {
        status: "expired",
        requestId: trigger.requestId ?? currentUpdate.requestId,
        channel: currentUpdate.channel,
        queuedAt: currentUpdate.queuedAt,
        finishedAt: trigger.finishedAt,
        error: trigger.error ??
          "Update timed out waiting for daemon acknowledgement",
      },
    },
    writeProjection: true,
    nextStatus: { ...existingStatus },
    writeStatus: false,
    geoDue: false,
  };
}

function applyUpdateResetTrigger(ctx: ProjectionTriggerContext): ProjectionOutcome {
  const { currentProjection, existingStatus } = ctx;
  return {
    touchMetadata: false,
    nextProjection: {
      ...currentProjection,
      update: { status: "idle" },
    },
    writeProjection: true,
    nextStatus: { ...existingStatus },
    writeStatus: false,
    geoDue: false,
  };
}

function applyProjectionTrigger(
  trigger: ProjectionTrigger,
  ctx: ProjectionTriggerContext,
): ProjectionOutcome {
  switch (trigger.kind) {
    case "online":
      return applyOnlineTrigger(trigger, ctx);
    case "offline":
    case "disconnected":
      return applyOfflineTrigger(ctx);
    case "heartbeat":
      return applyHeartbeatTrigger(trigger, ctx);
    case "identity":
      return applyIdentityTrigger(trigger, ctx);
    case "agent":
      return applyAgentTrigger(trigger, ctx);
    case "update-queued":
      return applyUpdateQueuedTrigger(trigger, ctx);
    case "update-result":
      return applyUpdateResultTrigger(trigger, ctx);
    case "update-expired":
      return applyUpdateExpiredTrigger(trigger, ctx);
    case "update-reset":
      return applyUpdateResetTrigger(ctx);
  }
}

/** `daemon` jsonb + dedicated status columns — the non-metadata half of the projection patch. */
function buildDaemonAndStatusColumnPatch(
  existing: ServerDaemonState,
  nextProjection: ServerDaemonProjection | undefined,
  writeProjection: boolean,
  nextStatus: ServerDaemonStatus,
  writeStatus: boolean,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  if (writeProjection || writeStatus) {
    // Preserve key; rewrite projection when identity/agent/update changes.
    // Status is never stored in jsonb — only dedicated columns.
    patch.daemon = buildMergedDaemonState(
      existing,
      writeProjection ? nextProjection : existing.projection,
    );
  }

  if (writeStatus) {
    Object.assign(patch, statusColumnPatch(nextStatus));
  }

  return patch;
}

/** Dedicated identity columns + metadata jsonb delta — the `touchMetadata` half of the patch. */
function buildIdentityAndMetadataPatch(
  trigger: ProjectionTrigger,
  existing: ServerDaemonStateWithMetadata,
  nextProjection: ServerDaemonProjection | undefined,
  geoDue: boolean,
  incomingGeo: ServerGeo | undefined,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  const projectionIdentity =
    trigger.kind === "online" || trigger.kind === "identity"
      ? trigger.identity
      : undefined;
  const identityColumns = buildIdentityColumnPatch(
    { hostname: existing.hostname, machineKey: existing.machineKey },
    nextProjection,
  );
  if (identityColumns) {
    Object.assign(patch, identityColumns);
  }

  const mergedMetadata = buildMetadataPatch(
    existing.metadata,
    geoDue ? incomingGeo : undefined,
    projectionIdentity,
  );
  if (mergedMetadata) {
    // jsonb || keeps keys that exist only in the live column (e.g. os written
    // by a concurrent hello) so a stale full-object replace cannot wipe them.
    patch.metadata = sql`COALESCE(${server.metadata}, '{}'::jsonb) || ${
      JSON.stringify(mergedMetadata)
    }::jsonb`;
  }

  return patch;
}

/**
 * Sparse projection into `server.daemon` (`key` + `projection`) and dedicated
 * status / identity columns — never clobbers `server.daemon.key`.
 */
export async function projectServerDaemon(
  db: Db,
  serverId: string,
  trigger: ProjectionTrigger,
  context: {
    cell?: DaemonCell;
    agent?: ProjectionAgent;
    /** Explicit override for tests; production uses the per-runtime registry. */
    metrics?: ServerStatusEventSink;
  } = {},
): Promise<boolean> {
  const existing = await getServerDaemonStateByServerId(db, serverId);
  if (!existing) return false;

  const now = nowTs();
  const existingStatus = existing.status ?? buildDefaultDaemonStatus();
  const outcome = applyProjectionTrigger(trigger, {
    existing,
    currentProjection: existing.projection,
    existingStatus,
    now,
    nowMs: Date.parse(now),
    agentHint: context.agent,
  });

  if (!outcome) return false;
  const { touchMetadata, nextProjection, writeProjection, nextStatus, writeStatus, incomingGeo, geoDue } =
    outcome;

  if (!writeStatus && !writeProjection && !geoDue) {
    return false;
  }

  const patch: Record<string, unknown> = {
    updatedAt: now,
    ...buildDaemonAndStatusColumnPatch(
      existing,
      nextProjection,
      writeProjection,
      nextStatus,
      writeStatus,
    ),
  };

  if (touchMetadata) {
    Object.assign(
      patch,
      buildIdentityAndMetadataPatch(trigger, existing, nextProjection, geoDue, incomingGeo),
    );
  }

  await db.update(server).set(patch).where(eq(server.id, serverId));

  // Emit only on a genuine connected flip, after Postgres succeeds.
  // `applyOfflineTrigger` sets writeStatus even for already-offline rows;
  // heartbeat / identity / agent / update triggers never flip connected.
  if (existingStatus.connected !== nextStatus.connected) {
    emitServerStatusEvent(
      {
        serverId,
        connected: nextStatus.connected,
        reason: resolveStatusTransitionReason(trigger, nextStatus.connected),
        at: nextStatus.statusChangedAt ?? now,
      },
      context.metrics,
    );
  }

  return true;
}

function resolveStatusTransitionReason(
  trigger: ProjectionTrigger,
  connected: boolean,
): ServerStatusTransitionReason {
  if (
    trigger.kind === "online" ||
    trigger.kind === "offline" ||
    trigger.kind === "disconnected"
  ) {
    if (trigger.reason) return trigger.reason;
  }
  if (connected) return "connect";
  return "disconnect";
}

export function identityFromSnapshot(
  snapshot: DaemonCellSnapshot,
): ProjectionIdentity {
  return {
    hostname: snapshot.hostname,
    machineKey: snapshot.machineKey,
    remoteAddress: snapshot.remoteAddress,
  };
}

export async function listConnectedServerIdsFromProjection(
  db: Db,
): Promise<string[]> {
  const rows = await db
    .select({ id: server.id })
    .from(server)
    .where(eq(server.connected, true));

  return rows.map((row) => row.id);
}

export type ConnectedServerForSweep = {
  id: string;
  connectedAt: string | null;
};

/**
 * Candidates for the offline sweep cron (`cell/offline-sweep.ts`): every
 * server Postgres currently believes is connected, plus `connectedAt` so a
 * freshly-attached socket (no auto-response ping yet) can be given grace
 * instead of being flagged stale on its very first sweep tick.
 */
export async function listConnectedServersForSweep(
  db: Db,
): Promise<ConnectedServerForSweep[]> {
  const rows = await db
    .select({
      id: server.id,
      connectedAt: server.statusChangedAt,
    })
    .from(server)
    .where(eq(server.connected, true))
    .orderBy(server.id);

  return rows.map((row) => ({
    id: row.id,
    connectedAt: row.connectedAt ?? null,
  }));
}

export type RecentlyOfflineServerForSweep = {
  id: string;
  connectedAt: string | null;
  /**
   * Offline transition timestamp (`status_changed_at`). Used by the AE-direct
   * self-heal path to reject stale pre-disconnect metrics samples.
   */
  offlineAt: string;
};

/** Grace window for sweep self-heal — 2× offline-sweep stale grace (90s). */
export const RECENT_OFFLINE_SWEEP_MS = 180_000;

/**
 * Candidates for offline-sweep self-heal: servers Postgres recently marked
 * offline (bounded by {@link RECENT_OFFLINE_SWEEP_MS}) so a live+warm cell
 * can re-project online via AE-direct `onDaemonConnectedFromEvidence` or
 * probed `onDaemonConnected` after `checkLiveness`.
 */
export async function listRecentlyOfflineServersForSweep(
  db: Db,
  opts: { nowMs?: number } = {},
): Promise<RecentlyOfflineServerForSweep[]> {
  const nowMs = opts.nowMs ?? Date.now();
  const cutoffIso = new Date(nowMs - RECENT_OFFLINE_SWEEP_MS).toISOString();

  const rows = await db
    .select({
      id: server.id,
      statusChangedAt: server.statusChangedAt,
    })
    .from(server)
    .where(sql`(
      ${server.connected} = false
      AND ${server.statusChangedAt} >= ${cutoffIso}
    )`)
    .orderBy(
      sql`${server.statusChangedAt} DESC`,
      server.id,
    );

  const candidates: RecentlyOfflineServerForSweep[] = [];
  for (const row of rows) {
    const offlineAt = row.statusChangedAt;
    if (!offlineAt) continue;

    candidates.push({
      id: row.id,
      connectedAt: offlineAt,
      offlineAt,
    });
  }
  return candidates;
}

/**
 * Deterministic sweep pagination — order by stable `id`, rotate start per cron
 * tick so servers beyond the first budget are checked on later sweeps.
 */
export function rotateSweepBatch<T extends { id: string }>(
  items: readonly T[],
  budget: number,
  tickMs: number,
): T[] {
  if (items.length === 0 || budget <= 0) return [];
  const sorted = [...items].sort((a, b) => a.id.localeCompare(b.id));
  const tick = Math.floor(tickMs / 60_000);
  const start = (tick * budget) % sorted.length;
  const count = Math.min(budget, sorted.length);
  const batch: T[] = [];
  for (let i = 0; i < count; i++) {
    batch.push(sorted[(start + i) % sorted.length]);
  }
  return batch;
}

/** All servers with an enrolled daemon key — used to scope Workers maintenance drains. */
export async function listEnrolledDaemonServerIds(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: server.id, daemon: server.daemon })
    .from(server);

  const enrolled: string[] = [];
  for (const row of rows) {
    const state = parseServerDaemonState(row.daemon);
    if (state?.key) {
      enrolled.push(row.id);
    }
  }
  return enrolled;
}

export type ServerFleetPresenceRow = {
  id: string;
  daemon: unknown;
  metadata: unknown;
  hostname: string | null;
  machineKey: string | null;
  connected: boolean;
  statusChangedAt: string | null;
};

/** Single SELECT for fleet presence + colocated enrichment on a fixed server id set. */
export async function loadServerRowsForFleetPresence(
  db: Db,
  serverIds: string[],
): Promise<ServerFleetPresenceRow[]> {
  if (serverIds.length === 0) return [];

  return db
    .select({
      id: server.id,
      daemon: server.daemon,
      metadata: server.metadata,
      hostname: server.hostname,
      machineKey: server.machineKey,
      connected: server.connected,
      statusChangedAt: server.statusChangedAt,
    })
    .from(server)
    .where(inArray(server.id, serverIds));
}

export type ProjectionDaemonRow = {
  id: string;
  daemon: unknown;
  connected: boolean;
  statusChangedAt: string | null;
};

export function buildProjectionsFromDaemonRows(
  rows: ProjectionDaemonRow[],
): Map<string, ServerDaemonProjectionRead> {
  const result = new Map<string, ServerDaemonProjectionRead>();
  for (const row of rows) {
    const read = toProjectionRead(row);
    if (read) {
      result.set(row.id, read);
    }
  }
  return result;
}

function toProjectionRead(row: ProjectionDaemonRow): ServerDaemonProjectionRead | null {
  const state = parseServerDaemonState(row.daemon);
  const connected = row.connected === true;
  const statusChangedAt = row.statusChangedAt ?? null;
  if (!state?.projection && !connected && !statusChangedAt) {
    return null;
  }

  const connectedAt = connected ? statusChangedAt : null;
  const projection = state?.projection ?? {};
  const {
    hostname: _hostname,
    machineKey: _machineKey,
    ...presenceProjection
  } = projection;
  return {
    ...presenceProjection,
    connected,
    connectedAt,
    daemonConnected: connected,
    daemonConnectedAt: connectedAt,
  };
}

export async function readProjectionsForServers(
  db: Db,
  serverIds: string[],
): Promise<Map<string, ServerDaemonProjectionRead>> {
  if (serverIds.length === 0) return new Map();

  const rows = await db
    .select({
      id: server.id,
      daemon: server.daemon,
      connected: server.connected,
      statusChangedAt: server.statusChangedAt,
    })
    .from(server)
    .where(inArray(server.id, serverIds));

  return buildProjectionsFromDaemonRows(rows);
}

export async function listServerIdsWithUpdatingProjection(
  db: Db,
): Promise<string[]> {
  const rows = await db
    .select({ id: server.id })
    .from(server)
    .where(
      sql`${server.daemon}->'projection'->'update'->>'status' = 'updating'`,
    );

  return rows.map((row) => row.id);
}
