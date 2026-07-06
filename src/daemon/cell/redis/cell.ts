import type {
  ClearUpdateStatusOptions,
  CellDiagnostics,
  DaemonCell,
  DaemonCellLease,
  DaemonCellSnapshot,
  ExpiredUpdateRequest,
  PendingRequestRecord,
  PendingRequestStatus,
} from "../contracts.ts";
import type {
  DaemonInboundEnvelope,
  DaemonOutboundEnvelope,
  OutboxDeliveryId,
} from "../protocol.ts";
import { DAEMON_OFFLINE_SWEEP_MS, DAEMON_STALE_MS } from "../protocol.ts";
import { TERMINAL_UPDATE_RETENTION_MS } from "../../../lib/update/constants.ts";
import { cellTrace, isDaemonDebugEnabled, logDebug, logInfo } from "../../../logger.ts";
import { onDaemonUpdateExpired } from "../control-plane-monitor.ts";
import type { Db } from "../../../db.ts";
import { mergeSnapshotPresence } from "../snapshot-merge.ts";
import type { RedisCellClient, StreamEntry } from "./client.ts";
import {
  cellKeyPattern,
  connKey,
  deliveryLeaseKey,
  HEARTBEAT_COALESCE_MS,
  leaseKey,
  metaKey,
  onlineSetKey,
  OUTBOX_GROUP,
  outboxKey,
  requestKey,
  requestsKey,
  snapshotKey,
} from "./keys.ts";
import {
  COMPARE_AND_DELETE,
  COMPARE_AND_RENEW,
  RECONCILE_STALE_SOCKET_PRESENCE,
} from "./lua.ts";

const TERMINAL_STATUSES = new Set<PendingRequestStatus>([
  "done",
  "failed",
  "expired",
]);

function createInitialCellDiagnostics(): CellDiagnostics {
  return {
    backend: "redis",
    usesHibernationWebSocket: false,
    constructorCalls: 0,
    wsAccepted: 0,
    wsClosed: 0,
    alarmInvocations: 0,
    heartbeatCount: 0,
    commandDispatchCount: 0,
    cleanupCount: 0,
    fetchByRoute: {},
    storageReads: 0,
    storageWrites: 0,
    storageByCallSite: {},
  };
}

const REDIS_READ_METHODS = new Set([
  "get",
  "hgetall",
  "zrangebyscore",
  "xrange",
  "xlen",
  "xreadgroup",
  "xrevrange",
  "smembers",
  "zcard",
  "pttl",
  "scanKeys",
]);

const REDIS_WRITE_METHODS = new Set([
  "set",
  "hset",
  "del",
  "sadd",
  "srem",
  "xadd",
  "xautoclaim",
  "xack",
  "xgroupCreate",
  "expire",
  "eval",
  "setnx",
  "setnxPersistent",
  "xdel",
  "xtrimMaxLen",
  "zadd",
  "zrem",
  "deleteByPattern",
]);

function redisMethodStorageKind(method: string): "read" | "write" | null {
  if (REDIS_READ_METHODS.has(method)) return "read";
  if (REDIS_WRITE_METHODS.has(method)) return "write";
  return null;
}

function wrapRedisCellClientForDiagnostics(
  client: RedisCellClient,
  callSite: string,
  countStorage: (callSite: string, kind: "read" | "write") => void,
): RedisCellClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      const method = String(prop);
      const kind = redisMethodStorageKind(method);
      if (!kind) {
        return value.bind(target);
      }
      return (...args: unknown[]) => {
        countStorage(callSite, kind);
        return Reflect.apply(value, target, args);
      };
    },
  }) as RedisCellClient;
}

function nowIso(now = Date.now()): string {
  return new Date(now).toISOString();
}

function parseSnapshot(
  raw: string | null,
  serverId: string,
): DaemonCellSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DaemonCellSnapshot;
    return { ...parsed, serverId };
  } catch {
    return null;
  }
}

function snapshotFromMeta(
  serverId: string,
  meta: Record<string, string>,
): DaemonCellSnapshot {
  return {
    serverId,
    version: Number(meta.snapshotVersion ?? "0"),
    updatedAt: meta.updatedAt ?? nowIso(),
    remoteAddress: meta.remoteAddress || undefined,
    connected: meta.connected === "1",
    connectedAt: meta.connectedAt || undefined,
    lastInboundAt: meta.lastInboundAt || undefined,
    lastOutboundAt: meta.lastOutboundAt || undefined,
    lastHeartbeatAt: meta.lastHeartbeatAt || undefined,
    lastSeenAt: meta.lastSeenAt || undefined,
    keyLastUsedAt: meta.keyLastUsedAt || undefined,
  };
}

function parseRequestRecord(
  serverId: string,
  requestId: string,
  fields: Record<string, string>,
): PendingRequestRecord {
  const record: PendingRequestRecord = {
    serverId,
    requestId,
    requestKind: fields.requestKind ?? "",
    status: (fields.status ?? "queued") as PendingRequestStatus,
    createdAt: fields.createdAt ?? nowIso(),
    expiresAt: fields.expiresAt ?? nowIso(),
  };
  if (fields.sentAt) record.sentAt = fields.sentAt;
  if (fields.ackAt) record.ackAt = fields.ackAt;
  if (fields.finishedAt) record.finishedAt = fields.finishedAt;
  if (fields.daemonReceivedAt) {
    record.daemonReceivedAt = fields.daemonReceivedAt;
  }
  if (fields.daemonRespondedAt) {
    record.daemonRespondedAt = fields.daemonRespondedAt;
  }
  if (fields.error) record.error = fields.error;
  if (fields.command) record.command = fields.command;
  if (fields.result) {
    try {
      record.result = JSON.parse(fields.result);
    } catch {
      record.result = fields.result;
    }
  }
  return record;
}

function isTerminalStatus(status: PendingRequestStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function isStaleInFlightUpdate(
  fields: Record<string, string>,
  opts?: ClearUpdateStatusOptions,
): boolean {
  if (!opts?.allowStale) return false;
  const status = fields.status as PendingRequestStatus;
  if (isTerminalStatus(status)) return false;

  if (
    opts.targetCommit &&
    opts.currentCommit &&
    opts.currentCommit === opts.targetCommit
  ) {
    return true;
  }

  const queuedAt = opts.queuedAt ?? fields.createdAt;
  if (queuedAt && opts.updateTtlMs) {
    const queuedMs = Date.parse(queuedAt);
    if (!Number.isNaN(queuedMs) && Date.now() - queuedMs >= opts.updateTtlMs) {
      return true;
    }
  }

  return false;
}

function envelopeFromOutboxFields(
  fields: Record<string, string>,
): DaemonOutboundEnvelope | null {
  const payloadRaw = fields.payload;
  if (!payloadRaw) return null;
  try {
    return JSON.parse(payloadRaw) as DaemonOutboundEnvelope;
  } catch {
    return null;
  }
}

function parseDeliveryMap(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

function shouldCoalesceLastSeenAt(
  lastSeenAt: string | undefined,
  atMs: number,
): boolean {
  if (!lastSeenAt) return true;
  const lastSeenMs = Date.parse(lastSeenAt);
  if (Number.isNaN(lastSeenMs) || Number.isNaN(atMs)) return true;
  return atMs - lastSeenMs >= HEARTBEAT_COALESCE_MS;
}

function parseStoredAgent(raw: string | undefined): import("../protocol.ts").DaemonAgentInfo | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as import("../protocol.ts").DaemonAgentInfo;
  } catch {
    return undefined;
  }
}

function agentIdentityEqual(
  a: import("../protocol.ts").DaemonAgentInfo,
  b: import("../protocol.ts").DaemonAgentInfo | undefined,
): boolean {
  if (!b) return false;
  return a.commit === b.commit &&
    a.buildId === b.buildId &&
    (a.builtAt ?? "") === (b.builtAt ?? "") &&
    (a.channel ?? "") === (b.channel ?? "");
}

function isLeaseOpSuccess(result: unknown): boolean {
  return result === "OK" || result === 1;
}

function isInboundStale(
  meta: Record<string, string> | null | undefined,
  now = Date.now(),
): boolean {
  const lastInboundAt =
    meta?.lastInboundAt ?? meta?.lastSeenAt ?? meta?.connectedAt;
  if (!lastInboundAt) return true;
  return now - Date.parse(lastInboundAt) >= DAEMON_STALE_MS;
}

export class RedisDaemonCell implements DaemonCell {
  readonly #rawClient: RedisCellClient;
  readonly #serverId: string;
  readonly #db: Db | undefined;
  readonly #reclaimedByConsumer = new Map<string, StreamEntry[]>();
  readonly #deliveryToStreamId = new Map<string, string>();
  readonly #terminalResults = new Map<string, PendingRequestRecord>();
  readonly #diag: CellDiagnostics = createInitialCellDiagnostics();
  readonly #debugStorage: boolean;
  readonly #wrappedClients = new Map<string, RedisCellClient>();
  #lastInboundMs = 0;
  #connectedHint = false;

  constructor(client: RedisCellClient, serverId: string, db?: Db) {
    this.#rawClient = client;
    this.#serverId = serverId;
    this.#db = db;
    this.#debugStorage = isDaemonDebugEnabled();
    this.#diag.constructorCalls += 1;
    logDebug("daemon-cell", `diagnostics: constructor ${serverId}`);
  }

  #redis(callSite: string): RedisCellClient {
    if (!this.#debugStorage) {
      return this.#rawClient;
    }
    let wrapped = this.#wrappedClients.get(callSite);
    if (!wrapped) {
      wrapped = wrapRedisCellClientForDiagnostics(
        this.#rawClient,
        callSite,
        (cs, kind) => this.#countStorage(cs, kind),
      );
      this.#wrappedClients.set(callSite, wrapped);
    }
    return wrapped;
  }

  #countStorage(callSite: string, kind: "read" | "write"): void {
    if (kind === "read") {
      this.#diag.storageReads += 1;
    } else {
      this.#diag.storageWrites += 1;
    }
    const bucket = this.#diag.storageByCallSite[callSite] ??
      { reads: 0, writes: 0 };
    if (kind === "read") {
      bucket.reads += 1;
    } else {
      bucket.writes += 1;
    }
    this.#diag.storageByCallSite[callSite] = bucket;
    cellTrace("storage-op", { callSite, kind, serverId: this.#serverId });
  }

  #bumpMethodRoute(method: string): void {
    this.#diag.fetchByRoute[method] = (this.#diag.fetchByRoute[method] ?? 0) + 1;
    logDebug("daemon-cell", `diagnostics: fetchByRoute ${method}`);
  }

  #bumpDiag(
    field:
      | "wsAccepted"
      | "wsClosed"
      | "alarmInvocations"
      | "heartbeatCount"
      | "commandDispatchCount"
      | "cleanupCount",
  ): void {
    this.#diag[field] += 1;
    logDebug("daemon-cell", `diagnostics: ${field}`);
  }

  getDiagnostics(): Promise<CellDiagnostics> {
    return Promise.resolve(this.#diag);
  }

  async #projectUpdateExpired(
    requestId: string,
    finishedAt: string,
  ): Promise<void> {
    if (!this.#db) return;
    await onDaemonUpdateExpired(this.#db, this.#serverId, requestId, finishedAt);
  }

  #rememberOutboxEntries(entries: StreamEntry[]): void {
    for (const entry of entries) {
      const deliveryId = entry.fields.deliveryId;
      if (deliveryId) {
        this.#deliveryToStreamId.set(deliveryId, entry.id);
      }
    }
  }

  #entriesToEnvelopes(entries: StreamEntry[]): DaemonOutboundEnvelope[] {
    this.#rememberOutboxEntries(entries);
    const envelopes: DaemonOutboundEnvelope[] = [];
    for (const entry of entries) {
      const env = envelopeFromOutboxFields(entry.fields);
      if (env) envelopes.push(env);
    }
    return envelopes;
  }

  async #resolveStreamIdForDelivery(
    deliveryId: string,
    callSite: string,
  ): Promise<string | null> {
    const redis = this.#redis(callSite);
    const cached = this.#deliveryToStreamId.get(deliveryId);
    if (cached) return cached;

    const requestIds = await redis.zrangebyscore(
      requestsKey(this.#serverId),
      "-inf",
      "+inf",
    );
    for (const requestId of requestIds) {
      const fields = await redis.hgetall(
        requestKey(this.#serverId, requestId),
      );
      if (!fields) continue;
      const deliveries = parseDeliveryMap(fields.deliveries);
      const streamId = deliveries[deliveryId];
      if (streamId) return streamId;
    }
    return null;
  }

  async reconcileStalePresence(now = Date.now()): Promise<boolean> {
    this.#bumpMethodRoute("reconcileStalePresence");
    const redis = this.#redis("reconcileStalePresence");
    const staleBeforeIso = new Date(now - DAEMON_OFFLINE_SWEEP_MS).toISOString();
    const result = await redis.eval(
      RECONCILE_STALE_SOCKET_PRESENCE,
      3,
      leaseKey(this.#serverId),
      metaKey(this.#serverId),
      onlineSetKey(),
      this.#serverId,
      nowIso(now),
      "lease-expired",
      staleBeforeIso,
    );

    const demoted = Array.isArray(result)
      ? result[0] === 1 || result[0] === "1"
      : result === 1;
    if (demoted) {
      this.#connectedHint = false;
      logInfo("daemon-cell", `stale presence demoted: ${this.#serverId}`);
    }
    return demoted;
  }

  async #cleanupTerminalRequest(
    requestId: string,
    callSite: string,
    fields?: Record<string, string>,
  ): Promise<void> {
    const redis = this.#redis(callSite);
    const reqKey = requestKey(this.#serverId, requestId);
    const recordFields = fields ?? await redis.hgetall(reqKey);
    if (!recordFields) {
      await redis.zrem(requestsKey(this.#serverId), requestId);
      return;
    }

    const retainMs = recordFields.requestKind === "update"
      ? TERMINAL_UPDATE_RETENTION_MS
      : 0;
    if (retainMs > 0) {
      const retainUntil = nowIso(Date.now() + retainMs);
      await redis.hset(reqKey, { expiresAt: retainUntil });
      await redis.expire(reqKey, Math.ceil(retainMs / 1000));
      return;
    }

    await this.#purgeRequestRecord(requestId, callSite, recordFields);
  }

  async attachDaemonSocket(meta: {
    keyId: string;
    remoteAddress?: string;
    connectedAt?: string;
  }): Promise<{ connectionId: string; lease: DaemonCellLease }> {
    this.#bumpMethodRoute("attachDaemonSocket");
    const redis = this.#redis("attachDaemonSocket");
    await this.reconcileStalePresence();

    const connectionId = crypto.randomUUID();
    const connectedAt = meta.connectedAt ?? nowIso();
    const leaseK = leaseKey(this.#serverId);

    const existingHolder = await redis.get(leaseK);
    if (existingHolder) {
      const staleMeta = await redis.hgetall(metaKey(this.#serverId));
      if (!isInboundStale(staleMeta)) {
        throw new Error("daemon socket lease held");
      }
      await redis.del(leaseK);
      if (staleMeta?.connectionId === existingHolder) {
        await redis.hset(metaKey(this.#serverId), { connected: "0" });
        await redis.srem(onlineSetKey(), this.#serverId);
      }
    }

    const acquired = await redis.setnxPersistent(leaseK, connectionId);
    if (!acquired) {
      throw new Error("daemon socket lease acquisition failed");
    }

    const expiresAt = "persistent";
    const keyLastUsedAt = nowIso();

    // connectionId/connected persist in meta HASH because Redis has no
    // per-connection isolate memory (needed by Lua sweep + orphan reclaim).
    await redis.hset(metaKey(this.#serverId), {
      connected: "1",
      connectionId,
      remoteAddress: meta.remoteAddress ?? "",
      connectedAt,
      lastSeenAt: connectedAt,
      lastInboundAt: connectedAt,
      keyLastUsedAt,
    });
    await redis.sadd(onlineSetKey(), this.#serverId);
    await redis.hset(connKey(this.#serverId, connectionId), {
      keyId: meta.keyId,
      connectedAt,
      remoteAddress: meta.remoteAddress ?? "",
    });

    const outbox = outboxKey(this.#serverId);
    await redis.xgroupCreate(outbox, OUTBOX_GROUP, "$", true);

    const consumer = `ws:${connectionId}`;
    const reclaimed = await redis.xautoclaim(
      outbox,
      OUTBOX_GROUP,
      consumer,
      60_000,
      "0-0",
      100,
    );
    if (reclaimed.length > 0) {
      this.#reclaimedByConsumer.set(consumer, reclaimed);
      this.#rememberOutboxEntries(reclaimed);
    }

    await this.putSnapshot({
      remoteAddress: meta.remoteAddress,
      connected: true,
      connectedAt,
    });

    this.#connectedHint = true;
    this.#lastInboundMs = Date.parse(connectedAt);

    logDebug("daemon-cell", `attach: ${this.#serverId} conn=${connectionId}`);
    cellTrace("attach", {
      serverId: this.#serverId,
      conn: connectionId,
      remoteAddress: meta.remoteAddress,
    });

    this.#bumpDiag("wsAccepted");

    return {
      connectionId,
      lease: {
        holder: connectionId,
        expiresAt,
      },
    };
  }

  async reclaimOrphanedSocketLeaseOnStartup(): Promise<void> {
    this.#bumpMethodRoute("reclaimOrphanedSocketLeaseOnStartup");
    const redis = this.#redis("reclaimOrphanedSocketLeaseOnStartup");
    const leaseK = leaseKey(this.#serverId);
    const holder = await redis.get(leaseK);
    if (!holder) return;

    await redis.del(leaseK);
    const meta = await redis.hgetall(metaKey(this.#serverId));
    if (meta?.connectionId === holder && meta?.connected === "1") {
      await redis.hset(metaKey(this.#serverId), { connected: "0" });
      await redis.srem(onlineSetKey(), this.#serverId);
      const closedAt = nowIso();
      await redis.hset(connKey(this.#serverId, holder), {
        closedAt,
        reason: "instance-restart",
      });
      await redis.expire(
        connKey(this.#serverId, holder),
        86_400,
      );
    }
  }

  async detachDaemonSocket(params: {
    connectionId: string;
    reason?: string;
    closedAt?: string;
  }): Promise<void> {
    this.#bumpMethodRoute("detachDaemonSocket");
    const redis = this.#redis("detachDaemonSocket");
    const released = await redis.eval(
      COMPARE_AND_DELETE,
      1,
      leaseKey(this.#serverId),
      params.connectionId,
    );
    if (!isLeaseOpSuccess(released)) return;

    const meta = await redis.hgetall(metaKey(this.#serverId));
    if (meta?.connectionId === params.connectionId) {
      await redis.hset(metaKey(this.#serverId), { connected: "0" });
      await redis.srem(onlineSetKey(), this.#serverId);
    }

    const closedAt = params.closedAt ?? nowIso();
    await redis.hset(connKey(this.#serverId, params.connectionId), {
      closedAt,
      reason: params.reason ?? "",
    });
    await redis.expire(
      connKey(this.#serverId, params.connectionId),
      86_400,
    );

    this.#reclaimedByConsumer.delete(`ws:${params.connectionId}`);

    this.#connectedHint = false;

    logDebug(
      "daemon-cell",
      `detach: ${this.#serverId} conn=${params.connectionId}`,
    );
    cellTrace("detach", {
      serverId: this.#serverId,
      conn: params.connectionId,
      reason: params.reason,
    });

    this.#bumpDiag("wsClosed");
    this.#bumpDiag("cleanupCount");
  }

  // Volatile heartbeat state stays in Redis only. Postgres projection is driven
  // by onDaemonInbound in deno-ws.ts, which short-circuits via
  // steadyStateInboundSkipsDbRead for steady-state heartbeats.
  async recordInbound(params: {
    connectionId?: string;
    hostname?: string;
    at?: string;
    agent?: import("../protocol.ts").DaemonAgentInfo;
  }): Promise<void> {
    this.#bumpMethodRoute("recordInbound");
    const at = params.at ?? nowIso();
    const atMs = Date.parse(at);
    const hasAgent = Boolean(params.agent?.commit && params.agent?.buildId);

    if (
      !hasAgent &&
      this.#connectedHint &&
      !Number.isNaN(atMs) &&
      atMs - this.#lastInboundMs < HEARTBEAT_COALESCE_MS
    ) {
      cellTrace("record-inbound", {
        serverId: this.#serverId,
        conn: params.connectionId,
        coalesced: true,
      });
      return;
    }

    const redis = this.#redis("recordInbound");
    this.#bumpDiag("heartbeatCount");
    const meta = await redis.hgetall(metaKey(this.#serverId));
    const connectionId = params.connectionId ?? meta?.connectionId;
    if (!connectionId) return;

    if (meta?.connected !== "1") {
      await redis.hset(metaKey(this.#serverId), { connected: "1" });
      await this.putSnapshot({ connected: true });
    }

    const bumpInbound = shouldCoalesceLastSeenAt(meta?.lastInboundAt, atMs);

    let agentChanged = false;
    const fields: Record<string, string> = {
      keyLastUsedAt: at,
    };
    if (bumpInbound) {
      fields.lastInboundAt = at;
      fields.lastSeenAt = at;
      logDebug("daemon-cell", `inbound coalesce: ${this.#serverId}`);
    }

    if (params.agent?.commit && params.agent?.buildId) {
      const storedAgent = parseStoredAgent(meta?.agent);
      agentChanged = !agentIdentityEqual(params.agent, storedAgent);
      if (agentChanged) fields.agent = JSON.stringify(params.agent);
      await this.putSnapshot({
        agent: params.agent,
        ...(bumpInbound ? { lastInboundAt: at, lastSeenAt: at } : {}),
      });
    } else if (bumpInbound) {
      await this.putSnapshot({ lastInboundAt: at, lastSeenAt: at });
    }

    await redis.hset(metaKey(this.#serverId), fields);
    await redis.sadd(onlineSetKey(), this.#serverId);

    if (!Number.isNaN(atMs)) {
      this.#lastInboundMs = atMs;
    }
    this.#connectedHint = true;

    cellTrace("record-inbound", {
      serverId: this.#serverId,
      conn: connectionId,
      coalesced: bumpInbound,
      agentChanged,
    });
  }

  async getSnapshot(): Promise<DaemonCellSnapshot> {
    this.#bumpMethodRoute("getSnapshot");
    const redis = this.#redis("getSnapshot");
    const raw = await redis.get(snapshotKey(this.#serverId));
    const fromJson = parseSnapshot(raw, this.#serverId);
    const meta = await redis.hgetall(metaKey(this.#serverId));
    const fromMeta = meta ? snapshotFromMeta(this.#serverId, meta) : null;

    if (fromJson && fromMeta) {
      return mergeSnapshotPresence(fromJson, fromMeta);
    }
    if (fromJson) return fromJson;
    if (fromMeta) return fromMeta;

    return {
      serverId: this.#serverId,
      version: 0,
      updatedAt: nowIso(),
      connected: false,
    };
  }

  async putSnapshot(
    patch: Partial<DaemonCellSnapshot>,
  ): Promise<DaemonCellSnapshot> {
    this.#bumpMethodRoute("putSnapshot");
    const redis = this.#redis("putSnapshot");
    const current = await this.getSnapshot();
    const updated: DaemonCellSnapshot = {
      ...current,
      ...patch,
      serverId: this.#serverId,
      version: current.version + 1,
      updatedAt: nowIso(),
    };
    await redis.set(
      snapshotKey(this.#serverId),
      JSON.stringify(updated),
    );
    const metaFields: Record<string, string> = {
      snapshotVersion: String(updated.version),
      updatedAt: updated.updatedAt,
    };
    if (patch.lastSeenAt !== undefined) {
      metaFields.lastSeenAt = patch.lastSeenAt;
    }
    if (patch.lastInboundAt !== undefined) {
      metaFields.lastInboundAt = patch.lastInboundAt;
    }
    if (patch.keyLastUsedAt !== undefined) {
      metaFields.keyLastUsedAt = patch.keyLastUsedAt;
    }
    await redis.hset(metaKey(this.#serverId), metaFields);
    cellTrace("snapshot-put", {
      serverId: this.#serverId,
      version: updated.version,
      keys: Object.keys(patch).join(","),
    });
    return updated;
  }

  async enqueue(
    outbound: DaemonOutboundEnvelope,
    opts?: { ttlSeconds?: number },
  ): Promise<PendingRequestRecord> {
    this.#bumpMethodRoute("enqueue");
    const redis = this.#redis("enqueue");
    if (outbound.kind === "command" || outbound.kind === "command-dispatch") {
      this.#bumpDiag("commandDispatchCount");
    }
    const now = Date.now();
    const createdAt = outbound.at ?? nowIso(now);
    const ttlSeconds = opts?.ttlSeconds ?? 300;
    const expiresAt = nowIso(now + ttlSeconds * 1000);
    const reqKey = requestKey(this.#serverId, outbound.requestId);
    const indexKey = requestsKey(this.#serverId);

    const existingFields = await redis.hgetall(reqKey);
    if (existingFields) {
      const deliveries = parseDeliveryMap(existingFields.deliveries);
      if (deliveries[outbound.deliveryId]) {
        return parseRequestRecord(
          this.#serverId,
          outbound.requestId,
          existingFields,
        );
      }

      const streamId = await redis.xadd(outboxKey(this.#serverId), "*", {
        deliveryId: outbound.deliveryId,
        requestId: outbound.requestId,
        kind: outbound.kind,
        payload: JSON.stringify(outbound),
        enqueuedAt: createdAt,
      });
      deliveries[outbound.deliveryId] = streamId;
      await redis.hset(reqKey, {
        deliveries: JSON.stringify(deliveries),
      });
      this.#deliveryToStreamId.set(outbound.deliveryId, streamId);

      cellTrace("enqueue", {
        serverId: this.#serverId,
        requestId: outbound.requestId,
        deliveryId: outbound.deliveryId,
        kind: outbound.kind,
      });

      return parseRequestRecord(
        this.#serverId,
        outbound.requestId,
        {
          ...existingFields,
          deliveries: JSON.stringify(deliveries),
        },
      );
    }

    const streamId = await redis.xadd(outboxKey(this.#serverId), "*", {
      deliveryId: outbound.deliveryId,
      requestId: outbound.requestId,
      kind: outbound.kind,
      payload: JSON.stringify(outbound),
      enqueuedAt: createdAt,
    });
    const deliveries = { [outbound.deliveryId]: streamId };
    const recordFields: Record<string, string> = {
      requestId: outbound.requestId,
      requestKind: outbound.kind,
      status: "queued",
      createdAt,
      expiresAt,
      deliveries: JSON.stringify(deliveries),
    };
    if (outbound.kind === "command") {
      recordFields.command = outbound.command;
    }

    await redis.hset(reqKey, recordFields);
    if (outbound.kind !== "update") {
      await redis.expire(reqKey, ttlSeconds);
    }
    await redis.zadd(indexKey, now, outbound.requestId);
    this.#deliveryToStreamId.set(outbound.deliveryId, streamId);

    cellTrace("enqueue", {
      serverId: this.#serverId,
      requestId: outbound.requestId,
      deliveryId: outbound.deliveryId,
      kind: outbound.kind,
    });

    return parseRequestRecord(this.#serverId, outbound.requestId, recordFields);
  }

  async markSent(
    deliveryId: OutboxDeliveryId,
    _connectionId: string,
    sentAt?: string,
  ): Promise<void> {
    this.#bumpMethodRoute("markSent");
    const redis = this.#redis("markSent");
    const requestIds = await redis.zrangebyscore(
      requestsKey(this.#serverId),
      "-inf",
      "+inf",
    );
    for (const requestId of requestIds) {
      const fields = await redis.hgetall(
        requestKey(this.#serverId, requestId),
      );
      if (!fields) continue;
      const deliveries = parseDeliveryMap(fields.deliveries);
      if (!deliveries[deliveryId]) continue;

      await redis.hset(requestKey(this.#serverId, requestId), {
        status: "sent",
        sentAt: sentAt ?? nowIso(),
      });
      cellTrace("mark-sent", {
        serverId: this.#serverId,
        requestId,
        deliveryId,
      });
      return;
    }
  }

  async #applyLateTerminalAck(
    inbound: DaemonInboundEnvelope,
    existing: PendingRequestRecord,
    fields: Record<string, string>,
    reqKey: string,
    callSite: string,
  ): Promise<PendingRequestRecord | null> {
    if (inbound.kind !== "command-ack" || existing.ackAt) return null;
    const redis = this.#redis(callSite);
    const updates: Record<string, string> = {
      ackAt: inbound.at,
      daemonReceivedAt: inbound.daemonReceivedAt,
    };
    await redis.hset(reqKey, updates);
    const patched = parseRequestRecord(this.#serverId, inbound.requestId, {
      ...fields,
      ...updates,
    });
    cellTrace("handle-inbound", {
      serverId: this.#serverId,
      requestId: inbound.requestId,
      kind: inbound.kind,
      statusFrom: existing.status,
      statusTo: "late-ack",
    });
    this.#terminalResults.set(inbound.requestId, patched);
    return patched;
  }

  async #applyCommandAckInbound(
    inbound: Extract<DaemonInboundEnvelope, { kind: "command-ack" }>,
    existing: PendingRequestRecord,
    fields: Record<string, string>,
    reqKey: string,
    callSite: string,
  ): Promise<PendingRequestRecord> {
    if (existing.status === "acked") return existing;
    const redis = this.#redis(callSite);
    const updates: Record<string, string> = {
      status: "acked",
      ackAt: inbound.at,
      daemonReceivedAt: inbound.daemonReceivedAt,
    };
    await redis.hset(reqKey, updates);
    await redis.hset(metaKey(this.#serverId), {
      lastInboundAt: inbound.at,
    });
    cellTrace("handle-inbound", {
      serverId: this.#serverId,
      requestId: inbound.requestId,
      kind: inbound.kind,
      statusFrom: existing.status,
      statusTo: "acked",
    });
    return parseRequestRecord(
      this.#serverId,
      inbound.requestId,
      { ...fields, ...updates },
    );
  }

  #resolveInboundCompletion(
    inbound: DaemonInboundEnvelope,
  ): {
    status: PendingRequestStatus;
    result?: unknown;
    error?: string;
  } | null {
    let status: PendingRequestStatus;
    let result: unknown;
    let error: string | undefined;

    switch (inbound.kind) {
      case "command-result":
        status = "done";
        result = {
          exitCode: inbound.exitCode,
          stdout: inbound.stdout,
          stderr: inbound.stderr,
        };
        break;
      case "addresses-result":
        status = "done";
        result = { addresses: inbound.addresses };
        break;
      case "public-urls-update-result":
      case "dev-sync-result":
      case "tunnel-token-result":
      case "update-result":
      case "command-outcome":
        status = inbound.ok ? "done" : "failed";
        if (inbound.kind === "command-outcome") {
          result = inbound.result === undefined
            ? { ok: inbound.ok, error: inbound.error }
            : inbound.result;
        } else {
          result = { ok: inbound.ok, error: inbound.error };
        }
        if (!inbound.ok) error = inbound.error;
        break;
      default:
        return null;
    }

    return { status, result, error };
  }

  async #applyInboundCompletion(
    inbound: DaemonInboundEnvelope,
    existing: PendingRequestRecord,
    fields: Record<string, string>,
    reqKey: string,
    completion: {
      status: PendingRequestStatus;
      result?: unknown;
      error?: string;
    },
    callSite: string,
  ): Promise<PendingRequestRecord> {
    const redis = this.#redis(callSite);
    const { status, result, error } = completion;
    const updates: Record<string, string> = {
      status,
      finishedAt: inbound.at,
    };
    if (result !== undefined) updates.result = JSON.stringify(result);
    if (error) updates.error = error;
    if (inbound.kind === "command-outcome") {
      if (inbound.daemonReceivedAt) {
        updates.daemonReceivedAt = inbound.daemonReceivedAt;
      }
      if (inbound.daemonRespondedAt) {
        updates.daemonRespondedAt = inbound.daemonRespondedAt;
      }
      if (!fields.ackAt) {
        updates.ackAt = inbound.daemonReceivedAt ?? inbound.at;
      }
    }

    await redis.hset(reqKey, updates);

    if (inbound.kind === "addresses-result") {
      await this.putSnapshot({
        addresses: inbound.addresses,
        lastInboundAt: inbound.at,
      });
    } else {
      await redis.hset(metaKey(this.#serverId), {
        lastInboundAt: inbound.at,
      });
    }

    cellTrace("handle-inbound", {
      serverId: this.#serverId,
      requestId: inbound.requestId,
      kind: inbound.kind,
      statusFrom: existing.status,
      statusTo: status,
    });

    const terminalRecord = parseRequestRecord(
      this.#serverId,
      inbound.requestId,
      { ...fields, ...updates },
    );
    if (isTerminalStatus(terminalRecord.status)) {
      this.#terminalResults.set(inbound.requestId, terminalRecord);
      await this.#cleanupTerminalRequest(inbound.requestId, callSite, {
        ...fields,
        ...updates,
      });
    }

    return terminalRecord;
  }

  async handleInbound(
    inbound: DaemonInboundEnvelope,
  ): Promise<PendingRequestRecord | null> {
    this.#bumpMethodRoute("handleInbound");
    const redis = this.#redis("handleInbound");
    const reqKey = requestKey(this.#serverId, inbound.requestId);
    const fields = await redis.hgetall(reqKey);
    if (!fields) {
      return null;
    }

    const existing = parseRequestRecord(
      this.#serverId,
      inbound.requestId,
      fields,
    );
    if (isTerminalStatus(existing.status)) {
      return (await this.#applyLateTerminalAck(
        inbound,
        existing,
        fields,
        reqKey,
        "handleInbound",
      )) ?? existing;
    }

    if (inbound.kind === "command-ack") {
      return this.#applyCommandAckInbound(
        inbound,
        existing,
        fields,
        reqKey,
        "handleInbound",
      );
    }

    const completion = this.#resolveInboundCompletion(inbound);
    if (!completion) return existing;

    return this.#applyInboundCompletion(
      inbound,
      existing,
      fields,
      reqKey,
      completion,
      "handleInbound",
    );
  }

  async getRequest(requestId: string): Promise<PendingRequestRecord | null> {
    this.#bumpMethodRoute("getRequest");
    const redis = this.#redis("getRequest");
    const cached = this.#terminalResults.get(requestId);
    if (cached) return cached;

    const fields = await redis.hgetall(
      requestKey(this.#serverId, requestId),
    );
    if (!fields) return null;
    return parseRequestRecord(this.#serverId, requestId, fields);
  }

  async listRequests(
    limit = 50,
    filter?: { requestKind?: string },
  ): Promise<PendingRequestRecord[]> {
    this.#bumpMethodRoute("listRequests");
    const redis = this.#redis("listRequests");
    const requestIds = await redis.zrangebyscore(
      requestsKey(this.#serverId),
      "-inf",
      "+inf",
    );
    const records: PendingRequestRecord[] = [];
    for (let i = requestIds.length - 1; i >= 0; i--) {
      const requestId = requestIds[i]!;
      const fields = await redis.hgetall(
        requestKey(this.#serverId, requestId),
      );
      if (!fields) continue;
      const record = parseRequestRecord(this.#serverId, requestId, fields);
      if (filter?.requestKind && record.requestKind !== filter.requestKind) {
        continue;
      }
      records.push(record);
      if (records.length >= limit) break;
    }
    return records;
  }

  // PARITY NOTE: waitForRequest polls with setTimeout in the Deno process.
  // This is cost-safe on self-hosted Deno (no DO billing). The Workers DO
  // equivalent (#waitForRequest in do.ts) is non-blocking — it returns the
  // current record immediately and callers poll from the worker side.
  // Both backends expose the same PendingRequestRecord shape and expired semantics.
  async waitForRequest(
    requestId: string,
    timeoutMs: number,
  ): Promise<PendingRequestRecord | null> {
    this.#bumpMethodRoute("waitForRequest");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const record = await this.getRequest(requestId);
      if (record && isTerminalStatus(record.status)) return record;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return null;
  }

  async createRequestAndWait(
    outbound: DaemonOutboundEnvelope,
    timeoutMs: number,
  ): Promise<PendingRequestRecord> {
    this.#bumpMethodRoute("createRequestAndWait");
    const redis = this.#redis("createRequestAndWait");
    await this.enqueue(outbound);
    const result = await this.waitForRequest(outbound.requestId, timeoutMs);
    if (result) {
      if (isTerminalStatus(result.status)) {
        if (result.requestKind !== "update") {
          await this.#cleanupTerminalRequest(
            outbound.requestId,
            "createRequestAndWait",
          );
        }
        this.#terminalResults.delete(outbound.requestId);
      }
      return result;
    }

    const expiredAt = nowIso();
    const reqKey = requestKey(this.#serverId, outbound.requestId);
    await redis.hset(reqKey, {
      status: "expired",
      finishedAt: expiredAt,
    });
    const expiredRecord = {
      serverId: this.#serverId,
      requestId: outbound.requestId,
      requestKind: outbound.kind,
      status: "expired" as const,
      createdAt: outbound.at,
      expiresAt: expiredAt,
      finishedAt: expiredAt,
    };
    if (outbound.kind === "update") {
      await this.#projectUpdateExpired(outbound.requestId, expiredAt);
    }
    await this.#cleanupTerminalRequest(
      outbound.requestId,
      "createRequestAndWait",
    );
    this.#terminalResults.delete(outbound.requestId);
    return expiredRecord;
  }

  async claimDeliveryLease(
    holder: string,
    ttlMs: number,
  ): Promise<DaemonCellLease | null> {
    this.#bumpMethodRoute("claimDeliveryLease");
    const redis = this.#redis("claimDeliveryLease");
    const key = deliveryLeaseKey(this.#serverId);
    const acquired = await redis.setnx(key, holder, ttlMs);
    cellTrace("lease-claim", {
      serverId: this.#serverId,
      holder,
      ok: acquired,
    });
    if (!acquired) return null;
    return {
      holder,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    };
  }

  async renewDeliveryLease(
    holder: string,
    ttlMs: number,
  ): Promise<DaemonCellLease | null> {
    this.#bumpMethodRoute("renewDeliveryLease");
    const redis = this.#redis("renewDeliveryLease");
    const key = deliveryLeaseKey(this.#serverId);
    const renewed = await redis.eval(
      COMPARE_AND_RENEW,
      1,
      key,
      holder,
      holder,
      ttlMs,
    );
    const ok = renewed === "OK" || renewed === 1;
    cellTrace("lease-renew", {
      serverId: this.#serverId,
      holder,
      ok,
    });
    if (!ok) return null;
    return {
      holder,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    };
  }

  async releaseDeliveryLease(holder: string): Promise<void> {
    this.#bumpMethodRoute("releaseDeliveryLease");
    const redis = this.#redis("releaseDeliveryLease");
    const released = await redis.eval(
      COMPARE_AND_DELETE,
      1,
      deliveryLeaseKey(this.#serverId),
      holder,
    );
    cellTrace("lease-release", {
      serverId: this.#serverId,
      holder,
      ok: isLeaseOpSuccess(released),
    });
  }

  async readOutboxBatch(params: {
    consumer: string;
    count: number;
    blockMs?: number;
  }): Promise<DaemonOutboundEnvelope[]> {
    this.#bumpMethodRoute("readOutboxBatch");
    const redis = this.#redis("readOutboxBatch");
    const envelopes: DaemonOutboundEnvelope[] = [];
    let remaining = params.count;

    const reclaimed = this.#reclaimedByConsumer.get(params.consumer) ?? [];
    if (reclaimed.length > 0 && remaining > 0) {
      const batch = reclaimed.splice(0, remaining);
      this.#reclaimedByConsumer.set(params.consumer, reclaimed);
      envelopes.push(...this.#entriesToEnvelopes(batch));
      remaining = params.count - envelopes.length;
    }

    if (remaining > 0) {
      const pending = await redis.xreadgroup(
        OUTBOX_GROUP,
        params.consumer,
        outboxKey(this.#serverId),
        remaining,
        undefined,
        "0",
      );
      if (pending.length > 0) {
        envelopes.push(...this.#entriesToEnvelopes(pending));
        remaining = params.count - envelopes.length;
      }
    }

    if (remaining > 0) {
      const fresh = await redis.xreadgroup(
        OUTBOX_GROUP,
        params.consumer,
        outboxKey(this.#serverId),
        remaining,
        params.blockMs,
        ">",
      );
      envelopes.push(...this.#entriesToEnvelopes(fresh));
    }

    cellTrace("outbox-read", {
      serverId: this.#serverId,
      consumer: params.consumer,
      count: envelopes.length,
    });

    return envelopes;
  }

  async ackOutbox(
    deliveryIds: OutboxDeliveryId[],
    _consumer: string,
  ): Promise<void> {
    this.#bumpMethodRoute("ackOutbox");
    const redis = this.#redis("ackOutbox");
    const streamIds: string[] = [];
    for (const deliveryId of deliveryIds) {
      const streamId = await this.#resolveStreamIdForDelivery(
        deliveryId,
        "ackOutbox",
      );
      if (streamId) streamIds.push(streamId);
    }
    if (streamIds.length > 0) {
      await redis.xack(
        outboxKey(this.#serverId),
        OUTBOX_GROUP,
        ...streamIds,
      );
      await redis.xdel(outboxKey(this.#serverId), ...streamIds);
      for (const deliveryId of deliveryIds) {
        this.#deliveryToStreamId.delete(deliveryId);
      }
    }
    cellTrace("outbox-ack", {
      serverId: this.#serverId,
      count: streamIds.length,
    });
  }

  async clearUpdateStatus(
    opts?: ClearUpdateStatusOptions,
  ): Promise<{ cleared: number }> {
    this.#bumpMethodRoute("clearUpdateStatus");
    const redis = this.#redis("clearUpdateStatus");
    const indexKey = requestsKey(this.#serverId);
    const requestIds = await redis.zrangebyscore(
      indexKey,
      "-inf",
      "+inf",
    );
    let cleared = 0;
    for (const requestId of requestIds) {
      const reqKey = requestKey(this.#serverId, requestId);
      const fields = await redis.hgetall(reqKey);
      if (fields?.requestKind !== "update") continue;
      const status = fields.status as PendingRequestStatus;
      if (!isTerminalStatus(status)) {
        if (isStaleInFlightUpdate(fields, opts)) {
          const finishedAt = nowIso();
          await redis.hset(reqKey, {
            status: "expired",
            finishedAt,
            error: "Update timed out waiting for daemon acknowledgement",
          });
          await this.#projectUpdateExpired(requestId, finishedAt);
          await this.#cleanupTerminalRequest(requestId, "clearUpdateStatus", {
            ...fields,
            status: "expired",
            finishedAt,
          });
          this.#terminalResults.delete(requestId);
          cleared++;
          continue;
        }
        throw new Error("update in progress");
      }
      await this.#purgeRequestRecord(requestId, "clearUpdateStatus", fields);
      this.#terminalResults.delete(requestId);
      cleared++;
    }
    return { cleared };
  }

  async #purgeRequestRecord(
    requestId: string,
    callSite: string,
    fields?: Record<string, string>,
  ): Promise<void> {
    const redis = this.#redis(callSite);
    const reqKey = requestKey(this.#serverId, requestId);
    const indexKey = requestsKey(this.#serverId);
    const recordFields = fields ?? await redis.hgetall(reqKey);
    if (!recordFields) {
      await redis.zrem(indexKey, requestId);
      return;
    }

    const deliveries = parseDeliveryMap(recordFields.deliveries);
    const streamIds = Object.values(deliveries);
    if (streamIds.length > 0) {
      await redis.xdel(outboxKey(this.#serverId), ...streamIds);
      for (const deliveryId of Object.keys(deliveries)) {
        this.#deliveryToStreamId.delete(deliveryId);
      }
    }

    await redis.del(reqKey);
    await redis.zrem(indexKey, requestId);
  }

  async prune(now = Date.now()): Promise<ExpiredUpdateRequest[]> {
    this.#bumpMethodRoute("prune");
    this.#bumpDiag("alarmInvocations");
    const redis = this.#redis("prune");
    const indexKey = requestsKey(this.#serverId);
    const requestIds = await redis.zrangebyscore(
      indexKey,
      "-inf",
      "+inf",
    );
    const expiredUpdates: ExpiredUpdateRequest[] = [];
    for (const requestId of requestIds) {
      const fields = await redis.hgetall(
        requestKey(this.#serverId, requestId),
      );
      if (!fields) {
        await redis.zrem(indexKey, requestId);
        continue;
      }
      const expiresAtMs = Date.parse(fields.expiresAt ?? "");
      if (!Number.isNaN(expiresAtMs) && expiresAtMs <= now) {
        if (
          fields.requestKind === "update" &&
          !isTerminalStatus(fields.status as PendingRequestStatus)
        ) {
          const finishedAt = nowIso(now);
          expiredUpdates.push({ requestId, finishedAt });
          await this.#projectUpdateExpired(requestId, finishedAt);
        }
        await redis.del(requestKey(this.#serverId, requestId));
        await redis.zrem(indexKey, requestId);
      }
    }
    return expiredUpdates;
  }

  async purge(): Promise<void> {
    this.#bumpMethodRoute("purge");
    const redis = this.#redis("purge");
    await redis.deleteByPattern(cellKeyPattern(this.#serverId));
    await redis.srem(onlineSetKey(), this.#serverId);

    this.#reclaimedByConsumer.clear();
    this.#deliveryToStreamId.clear();
    this.#terminalResults.clear();
  }
}
