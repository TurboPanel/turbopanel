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

export type ProjectionIdentity = {
  hostname?: string;
  machineId?: string;
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
  | { kind: "online"; identity: ProjectionIdentity; connectedAt?: string }
  | { kind: "offline" }
  | { kind: "disconnected" }
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

/** Status-backed read model for fleet presence — excludes hostname/machineId (metadata). */
export type ServerDaemonProjectionRead = Omit<
  ServerDaemonProjection,
  "hostname" | "machineId"
> & {
  update?: UpdateProjection;
  connected: boolean;
  connectedAt?: string | null;
  daemonConnected: boolean;
  daemonConnectedAt?: string | null;
  lastSeenAt?: string | null;
};

export const HEARTBEAT_DEBOUNCE_MS = 60_000;

function nowTs(): string {
  return new Date().toISOString();
}

function identityChanged(
  current: ServerDaemonProjection | undefined,
  identity: ProjectionIdentity,
): boolean {
  return (identity.hostname !== undefined &&
    identity.hostname !== current?.hostname) ||
    (identity.machineId !== undefined &&
      identity.machineId !== current?.machineId) ||
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
    machineId: identity.machineId ?? current?.machineId,
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
  projection: ServerDaemonProjection | undefined,
  incomingGeo?: ServerGeo,
  identity?: ProjectionIdentity,
): Partial<ServerMetadata> | null {
  const delta: Partial<ServerMetadata> = {};

  const hostname = projection?.hostname?.trim();
  if (hostname && hostname !== existingMetadata?.hostname) {
    delta.hostname = hostname;
  }
  const machineId = projection?.machineId?.trim();
  if (machineId && machineId !== existingMetadata?.machineId) {
    delta.machineId = machineId;
  }
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

function buildIdentityProjection(
  current: ServerDaemonProjection | undefined,
  identity: ProjectionIdentity,
): ServerDaemonProjection {
  return {
    hostname: identity.hostname,
    machineId: identity.machineId,
    remoteAddress: identity.remoteAddress,
    keyId: identity.keyId,
    ...(current?.agent ? { agent: current.agent } : {}),
    ...(current?.update ? { update: current.update } : {}),
  };
}

export function heartbeatDebounceElapsed(
  lastSeenAt: string | null,
  nowMs: number = Date.now(),
): boolean {
  if (!lastSeenAt) return true;
  const lastSeenMs = Date.parse(lastSeenAt);
  if (Number.isNaN(lastSeenMs)) return true;
  return nowMs - lastSeenMs >= HEARTBEAT_DEBOUNCE_MS;
}

/** True when an inbound hello/heartbeat should touch Postgres (mirrors cell coalesce). */
export function inboundHeartbeatProjectionDue(params: {
  runtimeConnected: boolean;
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

  if (params.cellLastSeenAt === params.inboundAt) {
    return true;
  }

  const atMs = Date.parse(params.inboundAt);
  const lastSeenMs = params.cellLastSeenAt
    ? Date.parse(params.cellLastSeenAt)
    : Number.NaN;
  if (Number.isNaN(atMs) || Number.isNaN(lastSeenMs)) return true;
  return atMs - lastSeenMs >= HEARTBEAT_DEBOUNCE_MS;
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
  nextStatus: ServerDaemonStatus,
): ServerDaemonState {
  return {
    key: existing.key,
    ...(nextProjection ? { projection: nextProjection } : {}),
    status: nextStatus,
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
  const { currentProjection, existingStatus, now, nowMs, existing, agentHint } = ctx;
  const identity = mergeIdentity(currentProjection, trigger.identity);
  const isOfflineToOnline = !existingStatus.connected;
  const lastSeenDue = isOfflineToOnline ||
    heartbeatDebounceElapsed(existingStatus.lastSeenAt, nowMs);
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

  if (!isOfflineToOnline && !lastSeenDue && !writeProjection && !geoDue) {
    return null;
  }

  let nextStatus: ServerDaemonStatus = { ...existingStatus };
  let writeStatus = false;
  if (isOfflineToOnline) {
    nextStatus = {
      ...nextStatus,
      connected: true,
      daemonStatus: "online",
      connectedAt: trigger.connectedAt ?? now,
      statusChangedAt: now,
    };
    writeStatus = true;
  }

  if (lastSeenDue) {
    nextStatus = { ...nextStatus, lastSeenAt: now };
    writeStatus = true;
  }

  return { touchMetadata, nextProjection, writeProjection, nextStatus, writeStatus, incomingGeo, geoDue };
}

function applyOfflineTrigger(ctx: ProjectionTriggerContext): ProjectionOutcome {
  const { currentProjection, existingStatus, now } = ctx;
  const nextStatus: ServerDaemonStatus = {
    ...existingStatus,
    connected: false,
    daemonStatus: "offline",
    disconnectedAt: now,
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
  const { currentProjection, existingStatus, now, nowMs, agentHint } = ctx;
  const agent = trigger.agent ?? agentHint;
  const lastSeenDue = heartbeatDebounceElapsed(existingStatus.lastSeenAt, nowMs);
  const agentDue = Boolean(
    agent?.commit && agent?.buildId && agentChanged(currentProjection, agent),
  );

  if (!lastSeenDue && !agentDue) {
    return null;
  }

  let nextStatus: ServerDaemonStatus = { ...existingStatus };
  let writeStatus = false;
  if (lastSeenDue) {
    nextStatus = { ...nextStatus, lastSeenAt: now };
    writeStatus = true;
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

  return { touchMetadata: false, nextProjection, writeProjection, nextStatus, writeStatus, geoDue: false };
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

/**
 * Sparse projection into `server.daemon` — never clobbers `server.daemon.key`.
 * Liveness timestamps and connection status live in `server.daemon.status` jsonb.
 */
export async function projectServerDaemon(
  db: Db,
  serverId: string,
  trigger: ProjectionTrigger,
  context: {
    cell?: DaemonCell;
    agent?: ProjectionAgent;
  } = {},
): Promise<boolean> {
  const existing = await getServerDaemonStateByServerId(db, serverId);
  if (!existing) return false;

  const now = nowTs();
  const outcome = applyProjectionTrigger(trigger, {
    existing,
    currentProjection: existing.projection,
    existingStatus: existing.status ?? buildDefaultDaemonStatus(),
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
    daemon: buildMergedDaemonState(existing, nextProjection, nextStatus),
  };

  if (touchMetadata) {
    const projectionIdentity =
      trigger.kind === "online" || trigger.kind === "identity"
        ? trigger.identity
        : undefined;
    const mergedMetadata = buildMetadataPatch(
      existing.metadata,
      nextProjection,
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
  }

  await db.update(server).set(patch).where(eq(server.id, serverId));

  return true;
}

export function identityFromSnapshot(
  snapshot: DaemonCellSnapshot,
): ProjectionIdentity {
  return {
    hostname: snapshot.hostname,
    machineId: snapshot.machineId,
    remoteAddress: snapshot.remoteAddress,
  };
}

export async function listConnectedServerIdsFromProjection(
  db: Db,
): Promise<string[]> {
  const rows = await db
    .select({ id: server.id, daemon: server.daemon })
    .from(server)
    .where(sql`(
      ${server.daemon}->'status'->>'connected' = 'true'
    )`);

  const connected: string[] = [];
  for (const row of rows) {
    const state = parseServerDaemonState(row.daemon);
    if (state?.status?.connected) {
      connected.push(row.id);
    }
  }
  return connected;
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
    .select({ id: server.id, daemon: server.daemon })
    .from(server)
    .where(sql`(
      ${server.daemon}->'status'->>'connected' = 'true'
    )`)
    .orderBy(server.id);

  const candidates: ConnectedServerForSweep[] = [];
  for (const row of rows) {
    const state = parseServerDaemonState(row.daemon);
    if (state?.status?.connected) {
      candidates.push({ id: row.id, connectedAt: state.status.connectedAt });
    }
  }
  return candidates;
}

export type RecentlyOfflineServerForSweep = {
  id: string;
  connectedAt: string | null;
  /**
   * Offline transition timestamp — `disconnectedAt` when set, else
   * `statusChangedAt`. Used by the AE-direct self-heal path to reject stale
   * pre-disconnect metrics samples.
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
    .select({ id: server.id, daemon: server.daemon })
    .from(server)
    .where(sql`(
      ${server.daemon}->'status'->>'connected' = 'false'
      AND COALESCE(
        ${server.daemon}->'status'->>'disconnectedAt',
        ${server.daemon}->'status'->>'statusChangedAt'
      ) >= ${cutoffIso}
    )`)
    .orderBy(
      sql`COALESCE(
        ${server.daemon}->'status'->>'disconnectedAt',
        ${server.daemon}->'status'->>'statusChangedAt'
      ) DESC`,
      server.id,
    );

  const candidates: RecentlyOfflineServerForSweep[] = [];
  for (const row of rows) {
    const state = parseServerDaemonState(row.daemon);
    const status = state?.status;
    if (!status || status.connected) continue;

    const offlineAt = status.disconnectedAt ?? status.statusChangedAt;
    if (!offlineAt) continue;

    candidates.push({
      id: row.id,
      connectedAt: status.connectedAt ?? null,
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
    })
    .from(server)
    .where(inArray(server.id, serverIds));
}

export function buildProjectionsFromDaemonRows(
  rows: Array<{ id: string; daemon: unknown }>,
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

function toProjectionRead(row: {
  id: string;
  daemon: unknown;
}): ServerDaemonProjectionRead | null {
  const state = parseServerDaemonState(row.daemon);
  const status = state?.status ?? buildDefaultDaemonStatus();
  if (!state?.projection && !status.connected && !status.lastSeenAt) {
    return null;
  }

  const projection = state?.projection ?? {};
  const {
    hostname: _hostname,
    machineId: _machineId,
    ...presenceProjection
  } = projection;
  return {
    ...presenceProjection,
    connected: status.connected,
    connectedAt: status.connectedAt,
    daemonConnected: status.connected,
    daemonConnectedAt: status.connectedAt,
    lastSeenAt: status.lastSeenAt,
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
