import type {
  DaemonCell,
  DaemonCellLease,
  DaemonCellSnapshot,
  MonitorAlertRow,
  MonitorEventRow,
  MonitorInstanceRow,
  MonitorMetricRow,
  MonitorResourceRow,
  PendingRequestRecord,
  PendingRequestStatus,
} from "../contracts.ts";
import type {
  MonitorEvent,
  MonitorInstanceSummary,
  MonitorResourceKind,
  MonitorResourceState,
  MonitorResourceStatus,
} from "../monitor-contracts.ts";
import {
  evaluateFullSyncSequence,
  evaluateMonitorSequence,
  MONITOR_ALERT_COOLDOWN_MS,
  MONITOR_OFFLINE_GRACE_MS,
  normalizeMonitorMetricBucket,
} from "../monitor-contracts.ts";
import type {
  DaemonInboundEnvelope,
  DaemonOutboundEnvelope,
  OutboxDeliveryId,
} from "../protocol.ts";
import { mergeSnapshotPresence } from "../snapshot-merge.ts";
import type { RedisCellClient, StreamEntry } from "./client.ts";
import {
  connKey,
  eventsKey,
  LEASE_TTL_MS,
  leaseKey,
  metaKey,
  monitorAlertKey,
  monitorAlertsIndexKey,
  monitorDeadlinesKey,
  monitorEventsKey,
  monitorInstanceKey,
  monitorMaintenanceSetKey,
  monitorMetricsKey,
  monitorResourceKey,
  monitorResourcesIndexKey,
  monitorSequenceKey,
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

const MONITOR_EVENT_RETAIN = 500;
const MONITOR_METRIC_RETAIN = 72 * 60;
const MONITOR_ALERT_RESOLVED_RETAIN_SECONDS = 7 * 24 * 60 * 60;

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
    hostname: meta.hostname || undefined,
    machineId: meta.machineId || undefined,
    remoteAddress: meta.remoteAddress || undefined,
    sessionId: meta.sessionId || undefined,
    keyId: meta.keyId || undefined,
    connected: meta.connected === "1",
    connectedAt: meta.connectedAt || undefined,
    lastInboundAt: meta.lastInboundAt || undefined,
    lastOutboundAt: meta.lastOutboundAt || undefined,
    lastHeartbeatAt: meta.lastHeartbeatAt || undefined,
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

function isLeaseOpSuccess(result: unknown): boolean {
  return result === "OK" || result === 1;
}

function metricValuesFromInstance(instance: MonitorInstanceSummary): {
  cpu?: number;
  memory?: number;
  disk?: number;
  load?: number;
} {
  return {
    cpu: instance.cpu?.usagePercent,
    memory: instance.memory?.usagePercent,
    disk: instance.disk?.usagePercent,
    load: instance.load?.one,
  };
}

function monitorEventStreamFields(event: MonitorEvent): Record<string, string> {
  const fields: Record<string, string> = {
    toStatus: event.toStatus,
    at: event.at,
  };
  if (event.resourceKey) fields.resourceKey = event.resourceKey;
  if (event.kind) fields.kind = event.kind;
  if (event.fromStatus) fields.fromStatus = event.fromStatus;
  if (event.reason) fields.reason = event.reason;
  if (event.sequence != null) fields.sequence = String(event.sequence);
  return fields;
}

function parseMonitorEventRow(
  serverId: string,
  seq: string,
  fields: Record<string, string>,
): MonitorEventRow {
  return {
    seq: Number(seq.split("-")[0] ?? seq),
    serverId,
    resourceKey: fields.resourceKey || undefined,
    kind: fields.kind as MonitorEventRow["kind"] | undefined,
    fromStatus: fields.fromStatus as MonitorEventRow["fromStatus"] | undefined,
    toStatus: fields.toStatus as MonitorEventRow["toStatus"],
    reason: fields.reason || undefined,
    at: fields.at ?? "",
    createdAt: fields.at ?? "",
  };
}

export class RedisDaemonCell implements DaemonCell {
  readonly #client: RedisCellClient;
  readonly #serverId: string;
  readonly #reclaimedByConsumer = new Map<string, StreamEntry[]>();
  readonly #deliveryToStreamId = new Map<string, string>();

  constructor(client: RedisCellClient, serverId: string) {
    this.#client = client;
    this.#serverId = serverId;
  }

  async #renewDaemonSocketLease(
    connectionId: string,
  ): Promise<boolean> {
    const renewed = await this.#client.eval(
      COMPARE_AND_RENEW,
      1,
      leaseKey(this.#serverId),
      connectionId,
      connectionId,
      LEASE_TTL_MS,
    );
    return isLeaseOpSuccess(renewed);
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
  ): Promise<string | null> {
    const cached = this.#deliveryToStreamId.get(deliveryId);
    if (cached) return cached;

    const requestIds = await this.#client.zrangebyscore(
      requestsKey(this.#serverId),
      "-inf",
      "+inf",
    );
    for (const requestId of requestIds) {
      const fields = await this.#client.hgetall(
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
    const result = await this.#client.eval(
      RECONCILE_STALE_SOCKET_PRESENCE,
      3,
      leaseKey(this.#serverId),
      metaKey(this.#serverId),
      onlineSetKey(),
      this.#serverId,
      nowIso(now),
      "lease-expired",
    );

    const demoted = Array.isArray(result)
      ? result[0] === 1 || result[0] === "1"
      : result === 1;
    if (!demoted) return false;

    const staleConnectionId = Array.isArray(result) && result[1]
      ? String(result[1])
      : undefined;
    if (staleConnectionId) {
      await this.appendEvent("disconnected", {
        connectionId: staleConnectionId,
        reason: "lease-expired",
      });
    }
    return true;
  }

  async attachDaemonSocket(meta: {
    keyId: string;
    hostname?: string;
    machineId?: string;
    remoteAddress?: string;
    connectedAt?: string;
  }): Promise<{ connectionId: string; lease: DaemonCellLease }> {
    await this.reconcileStalePresence();

    const connectionId = crypto.randomUUID();
    const connectedAt = meta.connectedAt ?? nowIso();
    const leaseK = leaseKey(this.#serverId);

    let acquired = await this.#client.setnx(leaseK, connectionId, LEASE_TTL_MS);
    if (!acquired) {
      const existing = await this.#client.get(leaseK);
      if (existing) {
        throw new Error(
          `daemon socket lease held by another connection (${existing})`,
        );
      }
      acquired = await this.#client.setnx(leaseK, connectionId, LEASE_TTL_MS);
      if (!acquired) {
        throw new Error("daemon socket lease acquisition failed");
      }
    }

    const expiresAt = new Date(Date.now() + LEASE_TTL_MS).toISOString();

    await this.#client.hset(metaKey(this.#serverId), {
      connected: "1",
      connectionId,
      keyId: meta.keyId,
      hostname: meta.hostname ?? "",
      machineId: meta.machineId ?? "",
      remoteAddress: meta.remoteAddress ?? "",
      connectedAt,
    });
    await this.#client.sadd(onlineSetKey(), this.#serverId);
    await this.#client.hset(connKey(this.#serverId, connectionId), {
      keyId: meta.keyId,
      connectedAt,
      remoteAddress: meta.remoteAddress ?? "",
    });

    const outbox = outboxKey(this.#serverId);
    await this.#client.xgroupCreate(outbox, OUTBOX_GROUP, "$", true);

    const consumer = `ws:${connectionId}`;
    const reclaimed = await this.#client.xautoclaim(
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

    await this.appendEvent("connected", { connectionId });

    return {
      connectionId,
      lease: {
        holder: connectionId,
        token: connectionId,
        expiresAt,
      },
    };
  }

  async detachDaemonSocket(params: {
    connectionId: string;
    leaseToken: string;
    reason?: string;
    closedAt?: string;
  }): Promise<void> {
    const released = await this.#client.eval(
      COMPARE_AND_DELETE,
      1,
      leaseKey(this.#serverId),
      params.leaseToken,
    );
    if (!isLeaseOpSuccess(released)) return;

    const meta = await this.#client.hgetall(metaKey(this.#serverId));
    if (meta?.connectionId === params.connectionId) {
      await this.#client.hset(metaKey(this.#serverId), { connected: "0" });
      await this.#client.srem(onlineSetKey(), this.#serverId);
    }

    const closedAt = params.closedAt ?? nowIso();
    await this.#client.hset(connKey(this.#serverId, params.connectionId), {
      closedAt,
      reason: params.reason ?? "",
    });
    await this.#client.expire(
      connKey(this.#serverId, params.connectionId),
      86_400,
    );

    this.#reclaimedByConsumer.delete(`ws:${params.connectionId}`);

    await this.appendEvent("disconnected", {
      connectionId: params.connectionId,
      reason: params.reason ?? "",
    });
  }

  async heartbeat(params: {
    connectionId?: string;
    hostname?: string;
    at?: string;
  }): Promise<void> {
    const meta = await this.#client.hgetall(metaKey(this.#serverId));
    const connectionId = params.connectionId ?? meta?.connectionId;
    if (!connectionId) return;

    const renewed = await this.#renewDaemonSocketLease(connectionId);
    if (!renewed) return;

    const fields: Record<string, string> = {
      lastHeartbeatAt: params.at ?? nowIso(),
    };
    if (params.hostname) fields.hostname = params.hostname;
    await this.#client.hset(metaKey(this.#serverId), fields);
    await this.#client.sadd(onlineSetKey(), this.#serverId);
  }

  async getSnapshot(): Promise<DaemonCellSnapshot> {
    const raw = await this.#client.get(snapshotKey(this.#serverId));
    const fromJson = parseSnapshot(raw, this.#serverId);
    const meta = await this.#client.hgetall(metaKey(this.#serverId));
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
    const current = await this.getSnapshot();
    const updated: DaemonCellSnapshot = {
      ...current,
      ...patch,
      serverId: this.#serverId,
      version: current.version + 1,
      updatedAt: nowIso(),
    };
    await this.#client.set(
      snapshotKey(this.#serverId),
      JSON.stringify(updated),
    );
    await this.#client.hset(metaKey(this.#serverId), {
      snapshotVersion: String(updated.version),
      updatedAt: updated.updatedAt,
    });
    return updated;
  }

  async appendEvent(
    kind: string,
    payload: Record<string, unknown>,
    ttlSeconds?: number,
  ): Promise<void> {
    const at = nowIso();
    const key = eventsKey(this.#serverId);
    await this.#client.xadd(key, "*", {
      kind,
      at,
      payload: JSON.stringify(payload),
    }, 500);
    if (ttlSeconds != null) {
      await this.#client.expire(key, ttlSeconds, "GT");
    }
  }

  async listEvents(limit = 50): Promise<
    Array<{
      seq: string;
      kind: string;
      at: string;
      payload: Record<string, unknown>;
    }>
  > {
    const entries = await this.#client.xrange(
      eventsKey(this.#serverId),
      "-",
      "+",
      limit,
    );
    return entries.map((entry) => {
      let payload: Record<string, unknown> = {};
      if (entry.fields.payload) {
        try {
          payload = JSON.parse(entry.fields.payload) as Record<string, unknown>;
        } catch {
          payload = {};
        }
      }
      return {
        seq: entry.id,
        kind: entry.fields.kind ?? "",
        at: entry.fields.at ?? "",
        payload,
      };
    });
  }

  async enqueue(
    outbound: DaemonOutboundEnvelope,
    opts?: { ttlSeconds?: number },
  ): Promise<PendingRequestRecord> {
    const now = Date.now();
    const createdAt = outbound.at ?? nowIso(now);
    const ttlSeconds = opts?.ttlSeconds ?? 300;
    const expiresAt = nowIso(now + ttlSeconds * 1000);
    const reqKey = requestKey(this.#serverId, outbound.requestId);
    const indexKey = requestsKey(this.#serverId);

    const existingFields = await this.#client.hgetall(reqKey);
    if (existingFields) {
      const deliveries = parseDeliveryMap(existingFields.deliveries);
      if (deliveries[outbound.deliveryId]) {
        return parseRequestRecord(
          this.#serverId,
          outbound.requestId,
          existingFields,
        );
      }

      const streamId = await this.#client.xadd(outboxKey(this.#serverId), "*", {
        deliveryId: outbound.deliveryId,
        requestId: outbound.requestId,
        kind: outbound.kind,
        payload: JSON.stringify(outbound),
        enqueuedAt: createdAt,
      });
      deliveries[outbound.deliveryId] = streamId;
      await this.#client.hset(reqKey, {
        deliveries: JSON.stringify(deliveries),
      });
      this.#deliveryToStreamId.set(outbound.deliveryId, streamId);

      return parseRequestRecord(
        this.#serverId,
        outbound.requestId,
        {
          ...existingFields,
          deliveries: JSON.stringify(deliveries),
        },
      );
    }

    const streamId = await this.#client.xadd(outboxKey(this.#serverId), "*", {
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

    await this.#client.hset(reqKey, recordFields);
    await this.#client.expire(reqKey, ttlSeconds);
    await this.#client.zadd(indexKey, now, outbound.requestId);
    this.#deliveryToStreamId.set(outbound.deliveryId, streamId);

    return parseRequestRecord(this.#serverId, outbound.requestId, recordFields);
  }

  async markSent(
    deliveryId: OutboxDeliveryId,
    _connectionId: string,
    sentAt?: string,
  ): Promise<void> {
    const requestIds = await this.#client.zrangebyscore(
      requestsKey(this.#serverId),
      "-inf",
      "+inf",
    );
    for (const requestId of requestIds) {
      const fields = await this.#client.hgetall(
        requestKey(this.#serverId, requestId),
      );
      if (!fields) continue;
      const deliveries = parseDeliveryMap(fields.deliveries);
      if (!deliveries[deliveryId]) continue;

      await this.#client.hset(requestKey(this.#serverId, requestId), {
        status: "sent",
        sentAt: sentAt ?? nowIso(),
      });
      return;
    }
  }

  async handleInbound(
    inbound: DaemonInboundEnvelope,
  ): Promise<PendingRequestRecord | null> {
    const reqKey = requestKey(this.#serverId, inbound.requestId);
    const fields = await this.#client.hgetall(reqKey);
    if (!fields) return null;

    const existing = parseRequestRecord(
      this.#serverId,
      inbound.requestId,
      fields,
    );
    if (isTerminalStatus(existing.status)) return existing;

    let status: PendingRequestStatus;
    let result: unknown;
    let error: string | undefined;

    switch (inbound.kind) {
      case "pong":
        status = "acked";
        break;
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
        await this.putSnapshot({
          addresses: inbound.addresses,
          lastInboundAt: inbound.at,
        });
        break;
      case "public-urls-update-result":
      case "dev-sync-result":
      case "tunnel-token-result":
      case "update-result":
        status = inbound.ok ? "done" : "failed";
        result = { ok: inbound.ok, error: inbound.error };
        if (!inbound.ok) error = inbound.error;
        break;
      default:
        return existing;
    }

    const updates: Record<string, string> = {
      status,
      finishedAt: inbound.at,
    };
    if (result !== undefined) updates.result = JSON.stringify(result);
    if (error) updates.error = error;

    await this.#client.hset(reqKey, updates);
    await this.appendEvent("inbound", {
      kind: inbound.kind,
      requestId: inbound.requestId,
    });

    if (inbound.kind !== "addresses-result") {
      await this.#client.hset(metaKey(this.#serverId), {
        lastInboundAt: inbound.at,
      });
    }

    return parseRequestRecord(
      this.#serverId,
      inbound.requestId,
      { ...fields, ...updates },
    );
  }

  async getRequest(requestId: string): Promise<PendingRequestRecord | null> {
    const fields = await this.#client.hgetall(
      requestKey(this.#serverId, requestId),
    );
    if (!fields) return null;
    return parseRequestRecord(this.#serverId, requestId, fields);
  }

  async listRequests(
    limit = 50,
    filter?: { requestKind?: string },
  ): Promise<PendingRequestRecord[]> {
    const requestIds = await this.#client.zrangebyscore(
      requestsKey(this.#serverId),
      "-inf",
      "+inf",
    );
    const records: PendingRequestRecord[] = [];
    for (let i = requestIds.length - 1; i >= 0; i--) {
      const requestId = requestIds[i]!;
      const fields = await this.#client.hgetall(
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

  async waitForRequest(
    requestId: string,
    timeoutMs: number,
  ): Promise<PendingRequestRecord | null> {
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
    await this.enqueue(outbound);
    const result = await this.waitForRequest(outbound.requestId, timeoutMs);
    if (result) return result;

    const expiredAt = nowIso();
    const reqKey = requestKey(this.#serverId, outbound.requestId);
    await this.#client.hset(reqKey, {
      status: "expired",
      finishedAt: expiredAt,
    });
    return {
      serverId: this.#serverId,
      requestId: outbound.requestId,
      requestKind: outbound.kind,
      status: "expired",
      createdAt: outbound.at,
      expiresAt: expiredAt,
      finishedAt: expiredAt,
    };
  }

  async claimDeliveryLease(
    holder: string,
    ttlMs: number,
  ): Promise<DaemonCellLease | null> {
    const key = leaseKey(this.#serverId);
    const acquired = await this.#client.setnx(key, holder, ttlMs);
    if (!acquired) return null;
    return {
      holder,
      token: holder,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    };
  }

  async renewDeliveryLease(
    holder: string,
    token: string,
    ttlMs: number,
  ): Promise<DaemonCellLease | null> {
    const key = leaseKey(this.#serverId);
    const renewed = await this.#client.eval(
      COMPARE_AND_RENEW,
      1,
      key,
      token,
      holder,
      ttlMs,
    );
    if (renewed !== "OK" && renewed !== 1) return null;
    return {
      holder,
      token: holder,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    };
  }

  async releaseDeliveryLease(holder: string, token: string): Promise<void> {
    await this.#client.eval(
      COMPARE_AND_DELETE,
      1,
      leaseKey(this.#serverId),
      token,
    );
  }

  async readOutboxBatch(params: {
    consumer: string;
    count: number;
    blockMs?: number;
  }): Promise<DaemonOutboundEnvelope[]> {
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
      const pending = await this.#client.xreadgroup(
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
      const fresh = await this.#client.xreadgroup(
        OUTBOX_GROUP,
        params.consumer,
        outboxKey(this.#serverId),
        remaining,
        params.blockMs,
        ">",
      );
      envelopes.push(...this.#entriesToEnvelopes(fresh));
    }

    return envelopes;
  }

  async ackOutbox(
    deliveryIds: OutboxDeliveryId[],
    _consumer: string,
  ): Promise<void> {
    const streamIds: string[] = [];
    for (const deliveryId of deliveryIds) {
      const streamId = await this.#resolveStreamIdForDelivery(deliveryId);
      if (streamId) streamIds.push(streamId);
    }
    if (streamIds.length > 0) {
      await this.#client.xack(
        outboxKey(this.#serverId),
        OUTBOX_GROUP,
        ...streamIds,
      );
      for (const deliveryId of deliveryIds) {
        this.#deliveryToStreamId.delete(deliveryId);
      }
    }
  }

  async prune(now = Date.now()): Promise<boolean> {
    await this.reconcileStalePresence(now);
    const offlineApplied = await this.#processDueMonitorDeadlines(now);
    await this.#client.xtrimMaxLen(eventsKey(this.#serverId), 500);
    await this.#client.xtrimMaxLen(outboxKey(this.#serverId), 1000);
    await this.#client.xtrimMaxLen(
      monitorEventsKey(this.#serverId),
      MONITOR_EVENT_RETAIN,
    );
    await this.#client.xtrimMaxLen(
      monitorMetricsKey(this.#serverId),
      MONITOR_METRIC_RETAIN,
    );
    await this.#pruneResolvedMonitorAlerts(now);

    const indexKey = requestsKey(this.#serverId);
    const requestIds = await this.#client.zrangebyscore(
      indexKey,
      "-inf",
      "+inf",
    );
    for (const requestId of requestIds) {
      const fields = await this.#client.hgetall(
        requestKey(this.#serverId, requestId),
      );
      if (!fields) {
        await this.#client.zrem(indexKey, requestId);
        continue;
      }
      const expiresAtMs = Date.parse(fields.expiresAt ?? "");
      if (!Number.isNaN(expiresAtMs) && expiresAtMs <= now) {
        await this.#client.del(requestKey(this.#serverId, requestId));
        await this.#client.zrem(indexKey, requestId);
      }
    }
    return offlineApplied;
  }

  async #scheduleOfflineDeadline(now = Date.now()): Promise<void> {
    await this.#client.zadd(
      monitorDeadlinesKey(this.#serverId),
      now + MONITOR_OFFLINE_GRACE_MS,
      "offline",
    );
    await this.#ensureMonitorMaintenanceRegistered();
  }

  async #cancelOfflineDeadline(): Promise<void> {
    await this.#client.zrem(monitorDeadlinesKey(this.#serverId), "offline");
    await this.#maybeClearMonitorMaintenanceRegistration();
  }

  async #ensureMonitorMaintenanceRegistered(): Promise<void> {
    await this.#client.sadd(monitorMaintenanceSetKey(), this.#serverId);
  }

  async #maybeClearMonitorMaintenanceRegistration(): Promise<void> {
    const pending = await this.#client.zcard(
      monitorDeadlinesKey(this.#serverId),
    );
    if (pending === 0) {
      await this.#client.srem(monitorMaintenanceSetKey(), this.#serverId);
    }
  }

  async #readMonitorResourceStatus(
    resourceKey: string,
  ): Promise<MonitorResourceStatus | null> {
    const fields = await this.#client.hgetall(
      monitorResourceKey(this.#serverId, resourceKey),
    );
    return fields?.status ? fields.status as MonitorResourceStatus : null;
  }

  async #emitMonitorTransition(
    event: MonitorEvent,
    now = Date.now(),
  ): Promise<void> {
    await this.#client.xadd(
      monitorEventsKey(this.#serverId),
      "*",
      monitorEventStreamFields(event),
      MONITOR_EVENT_RETAIN,
    );
    await this.#handleMonitorTransitionAlerts(event, now);
  }

  async #deriveAndEmitResourceTransitions(
    resources: MonitorResourceState[],
    at: string,
    now: number,
  ): Promise<void> {
    for (const resource of resources) {
      const previousStatus = await this.#readMonitorResourceStatus(
        resource.resourceKey,
      );
      if (previousStatus === resource.status) continue;
      await this.#emitMonitorTransition(
        {
          resourceKey: resource.resourceKey,
          kind: resource.kind,
          fromStatus: previousStatus ?? undefined,
          toStatus: resource.status,
          at,
          reason: previousStatus == null ? "sync-initial" : "sync-changed",
        },
        now,
      );
    }
  }

  async #resolveServerOfflineAlert(now: number): Promise<void> {
    await this.#resolveAlert(this.#serverId, now);
  }

  async #openOrUpdateAlert(
    resourceKey: string,
    toStatus: MonitorResourceStatus,
    now: number,
  ): Promise<void> {
    const alertKey = monitorAlertKey(this.#serverId, resourceKey);
    const fields = await this.#client.hgetall(alertKey);
    const nowStr = nowIso(now);

    if (!fields || fields.resolvedAt) {
      await this.#client.hset(alertKey, {
        serverId: this.#serverId,
        status: toStatus,
        openedAt: nowStr,
        lastNotifiedAt: nowStr,
        lastDeliveredAt: "",
        cooldownUntil: "",
        resolvedAt: "",
      });
      await this.#client.sadd(
        monitorAlertsIndexKey(this.#serverId),
        resourceKey,
      );
      return;
    }

    const cooldownUntil = fields.cooldownUntil ?? "";
    if (cooldownUntil && Date.parse(cooldownUntil) > now) return;

    const newCooldownUntil = nowIso(now + MONITOR_ALERT_COOLDOWN_MS);
    await this.#client.hset(alertKey, {
      status: toStatus,
      lastNotifiedAt: nowStr,
      cooldownUntil: newCooldownUntil,
    });
    await this.#client.zadd(
      monitorDeadlinesKey(this.#serverId),
      Date.parse(newCooldownUntil),
      `cooldown:${resourceKey}`,
    );
    await this.#ensureMonitorMaintenanceRegistered();
  }

  async #resolveAlert(resourceKey: string, now: number): Promise<void> {
    const alertKey = monitorAlertKey(this.#serverId, resourceKey);
    await this.#client.hset(alertKey, {
      resolvedAt: nowIso(now),
      cooldownUntil: "",
    });
    await this.#client.zrem(
      monitorDeadlinesKey(this.#serverId),
      `cooldown:${resourceKey}`,
    );
    await this.#client.srem(monitorAlertsIndexKey(this.#serverId), resourceKey);
    await this.#client.expire(alertKey, MONITOR_ALERT_RESOLVED_RETAIN_SECONDS);
    await this.#maybeClearMonitorMaintenanceRegistration();
  }

  async #handleMonitorTransitionAlerts(
    event: MonitorEvent,
    now: number,
  ): Promise<void> {
    const resourceKey = event.resourceKey ?? this.#serverId;
    if (
      event.toStatus === "degraded" ||
      event.toStatus === "unhealthy" ||
      event.toStatus === "failed"
    ) {
      await this.#openOrUpdateAlert(resourceKey, event.toStatus, now);
      return;
    }
    if (
      (event.toStatus === "healthy" || event.toStatus === "stopped") &&
      event.resourceKey
    ) {
      await this.#resolveAlert(event.resourceKey, now);
    }
  }

  async #processDueMonitorDeadlines(now: number): Promise<boolean> {
    const dueNames = await this.#client.zrangebyscore(
      monitorDeadlinesKey(this.#serverId),
      "-inf",
      now,
    );

    let offlineApplied = false;
    for (const deadlineName of dueNames) {
      if (deadlineName === "offline") {
        offlineApplied = await this.#processOfflineDeadline(now) ||
          offlineApplied;
      } else if (deadlineName.startsWith("cooldown:")) {
        const resourceKey = deadlineName.slice("cooldown:".length);
        await this.#client.hset(
          monitorAlertKey(this.#serverId, resourceKey),
          { cooldownUntil: "" },
        );
      }
      await this.#client.zrem(
        monitorDeadlinesKey(this.#serverId),
        deadlineName,
      );
    }
    await this.#maybeClearMonitorMaintenanceRegistration();
    return offlineApplied;
  }

  async #processOfflineDeadline(now: number): Promise<boolean> {
    const fields = await this.#client.hgetall(
      monitorInstanceKey(this.#serverId),
    );
    if (!fields?.at) return false;

    const lastHeartbeatMs = Date.parse(fields.at);
    if (
      Number.isNaN(lastHeartbeatMs) ||
      now - lastHeartbeatMs < MONITOR_OFFLINE_GRACE_MS
    ) {
      return false;
    }

    const at = nowIso(now);
    const resourceKeys = await this.#client.smembers(
      monitorResourcesIndexKey(this.#serverId),
    );
    for (const resourceKey of resourceKeys) {
      const resourceFields = await this.#client.hgetall(
        monitorResourceKey(this.#serverId, resourceKey),
      );
      if (!resourceFields) continue;

      const currentStatus = resourceFields.status as MonitorResourceStatus;
      if (
        currentStatus === "offline" ||
        currentStatus === "stopped" ||
        currentStatus === "failed"
      ) {
        continue;
      }

      const kind = resourceFields.kind as MonitorResourceKind;
      await this.#client.xadd(
        monitorEventsKey(this.#serverId),
        "*",
        monitorEventStreamFields({
          resourceKey,
          kind,
          fromStatus: currentStatus,
          toStatus: "offline",
          at,
          reason: "heartbeat-timeout",
        }),
        MONITOR_EVENT_RETAIN,
      );

      let state: MonitorResourceState;
      try {
        state = JSON.parse(resourceFields.stateJson) as MonitorResourceState;
      } catch {
        state = { resourceKey, kind, status: currentStatus };
      }
      state.status = "offline";
      state.updatedAt = at;
      await this.#client.hset(
        monitorResourceKey(this.#serverId, resourceKey),
        {
          status: "offline",
          stateJson: JSON.stringify(state),
          updatedAt: at,
        },
      );
    }

    await this.#openOrUpdateAlert(this.#serverId, "offline", now);
    return true;
  }

  async #pruneResolvedMonitorAlerts(now: number): Promise<void> {
    const alertKeys = await this.#client.smembers(
      monitorAlertsIndexKey(this.#serverId),
    );
    const cutoffMs = now - MONITOR_ALERT_RESOLVED_RETAIN_SECONDS * 1000;
    for (const resourceKey of alertKeys) {
      const fields = await this.#client.hgetall(
        monitorAlertKey(this.#serverId, resourceKey),
      );
      if (!fields?.resolvedAt) continue;
      const resolvedMs = Date.parse(fields.resolvedAt);
      if (!Number.isNaN(resolvedMs) && resolvedMs < cutoffMs) {
        await this.#client.del(monitorAlertKey(this.#serverId, resourceKey));
        await this.#client.srem(
          monitorAlertsIndexKey(this.#serverId),
          resourceKey,
        );
      }
    }
  }

  async #upsertMonitorResourceFields(
    resource: MonitorResourceState,
  ): Promise<void> {
    await this.#client.hset(
      monitorResourceKey(this.#serverId, resource.resourceKey),
      {
        kind: resource.kind,
        status: resource.status,
        stateJson: JSON.stringify(resource),
        updatedAt: nowIso(),
      },
    );
    await this.#client.sadd(
      monitorResourcesIndexKey(this.#serverId),
      resource.resourceKey,
    );
  }

  async #patchMonitorResourceFromTransition(
    event: MonitorEvent,
    at: string,
  ): Promise<void> {
    if (!event.resourceKey) return;

    const resourceKey = event.resourceKey;
    const fields = await this.#client.hgetall(
      monitorResourceKey(this.#serverId, resourceKey),
    );

    let state: MonitorResourceState;
    if (fields?.stateJson) {
      try {
        state = JSON.parse(fields.stateJson) as MonitorResourceState;
      } catch {
        state = {
          resourceKey,
          kind: (event.kind ?? fields.kind) as MonitorResourceKind,
          status: event.toStatus,
        };
      }
    } else {
      state = {
        resourceKey,
        kind: (event.kind ?? "service") as MonitorResourceKind,
        status: event.toStatus,
      };
    }

    state.status = event.toStatus;
    state.updatedAt = at;
    if (event.kind) state.kind = event.kind;

    await this.#upsertMonitorResourceFields(state);
  }

  async #readMonitorSequence(): Promise<number> {
    const currentRaw = await this.#client.get(
      monitorSequenceKey(this.#serverId),
    );
    return currentRaw ? Number(currentRaw) : 0;
  }

  async #persistMonitorSequence(sequence: number): Promise<void> {
    await this.#client.set(
      monitorSequenceKey(this.#serverId),
      String(sequence),
    );
  }

  async #insertMonitorMetric(
    at: string,
    instance: MonitorInstanceSummary,
  ): Promise<void> {
    const bucketAt = normalizeMonitorMetricBucket(at);
    const metrics = metricValuesFromInstance(instance);
    const fields: Record<string, string> = { bucketAt };
    if (metrics.cpu != null) fields.cpu = String(metrics.cpu);
    if (metrics.memory != null) fields.memory = String(metrics.memory);
    if (metrics.disk != null) fields.disk = String(metrics.disk);
    if (metrics.load != null) fields.load = String(metrics.load);
    await this.#client.xadd(
      monitorMetricsKey(this.#serverId),
      "*",
      fields,
    );
  }

  async applyMonitorSync(
    msg: DaemonInboundEnvelope & { kind: "monitor-sync" },
  ): Promise<{ acceptedSequence: number; resyncNeeded: boolean }> {
    const currentSequence = await this.#readMonitorSequence();
    const decision = evaluateFullSyncSequence(currentSequence, msg.sequence);
    if (decision.action !== "accept") {
      return {
        acceptedSequence: decision.acceptedSequence,
        resyncNeeded: decision.resyncNeeded,
      };
    }

    const now = Date.now();
    const at = nowIso(now);

    await this.#client.hset(monitorInstanceKey(this.#serverId), {
      sequence: String(msg.sequence),
      at: msg.at,
      instanceJson: JSON.stringify(msg.instance),
      updatedAt: nowIso(),
    });

    await this.#resolveServerOfflineAlert(now);
    await this.#deriveAndEmitResourceTransitions(msg.resources, msg.at, now);

    const incomingKeys = new Set<string>();
    for (const resource of msg.resources) {
      incomingKeys.add(resource.resourceKey);
      await this.#upsertMonitorResourceFields(resource);
    }

    const indexKey = monitorResourcesIndexKey(this.#serverId);
    const existingKeys = await this.#client.smembers(indexKey);
    for (const resourceKey of existingKeys) {
      if (incomingKeys.has(resourceKey)) continue;

      const resourceFields = await this.#client.hgetall(
        monitorResourceKey(this.#serverId, resourceKey),
      );
      if (resourceFields) {
        const currentStatus = resourceFields.status as MonitorResourceStatus;
        if (
          currentStatus !== "offline" &&
          currentStatus !== "stopped" &&
          currentStatus !== "failed"
        ) {
          await this.#client.xadd(
            monitorEventsKey(this.#serverId),
            "*",
            monitorEventStreamFields({
              resourceKey,
              kind: resourceFields.kind as MonitorResourceKind,
              fromStatus: currentStatus,
              toStatus: "offline",
              at,
              reason: "reconcile-removed",
            }),
            MONITOR_EVENT_RETAIN,
          );
        }
      }

      await this.#client.del(monitorResourceKey(this.#serverId, resourceKey));
      await this.#client.srem(indexKey, resourceKey);
    }

    await this.#insertMonitorMetric(msg.at, msg.instance);
    await this.#persistMonitorSequence(msg.sequence);
    await this.#scheduleOfflineDeadline(now);

    return {
      acceptedSequence: decision.acceptedSequence,
      resyncNeeded: decision.resyncNeeded,
    };
  }

  async applyMonitorHeartbeat(
    msg: DaemonInboundEnvelope & { kind: "monitor-heartbeat" },
  ): Promise<{ acceptedSequence: number; resyncNeeded: boolean }> {
    const currentSequence = await this.#readMonitorSequence();
    const decision = evaluateMonitorSequence(currentSequence, msg.sequence);
    if (decision.action !== "accept") {
      return {
        acceptedSequence: decision.acceptedSequence,
        resyncNeeded: decision.resyncNeeded,
      };
    }

    const now = Date.now();

    await this.#client.hset(monitorInstanceKey(this.#serverId), {
      sequence: String(msg.sequence),
      at: msg.at,
      instanceJson: JSON.stringify(msg.instance),
      updatedAt: nowIso(),
    });

    await this.#resolveServerOfflineAlert(now);

    if (msg.resources) {
      await this.#deriveAndEmitResourceTransitions(msg.resources, msg.at, now);
      for (const resource of msg.resources) {
        await this.#upsertMonitorResourceFields(resource);
      }
    }

    await this.#insertMonitorMetric(msg.at, msg.instance);
    await this.#persistMonitorSequence(msg.sequence);
    await this.#scheduleOfflineDeadline(now);

    return {
      acceptedSequence: decision.acceptedSequence,
      resyncNeeded: decision.resyncNeeded,
    };
  }

  async applyMonitorTransition(
    msg: DaemonInboundEnvelope & { kind: "monitor-transition" },
  ): Promise<{ acceptedSequence: number; resyncNeeded: boolean }> {
    const currentSequence = await this.#readMonitorSequence();
    const decision = evaluateMonitorSequence(currentSequence, msg.sequence);
    if (decision.action !== "accept") {
      return {
        acceptedSequence: decision.acceptedSequence,
        resyncNeeded: decision.resyncNeeded,
      };
    }

    const now = Date.now();

    for (const event of msg.events) {
      const previousStatus = event.resourceKey
        ? await this.#readMonitorResourceStatus(event.resourceKey)
        : null;
      if (!event.resourceKey || previousStatus !== event.toStatus) {
        await this.#emitMonitorTransition(
          {
            ...event,
            fromStatus: event.fromStatus ?? previousStatus ?? undefined,
          },
          now,
        );
      }
      await this.#patchMonitorResourceFromTransition(event, msg.at);
    }

    if (msg.resources) {
      for (const resource of msg.resources) {
        await this.#upsertMonitorResourceFields(resource);
      }
    }
    await this.#persistMonitorSequence(msg.sequence);
    await this.#scheduleOfflineDeadline(now);

    return {
      acceptedSequence: decision.acceptedSequence,
      resyncNeeded: decision.resyncNeeded,
    };
  }

  async drainNotificationCandidates(
    _serverId: string,
  ): Promise<MonitorAlertRow[]> {
    const resourceKeys = await this.#client.smembers(
      monitorAlertsIndexKey(this.#serverId),
    );
    const rows: MonitorAlertRow[] = [];
    const drained: Array<{ resourceKey: string; lastNotifiedAt: string }> = [];
    for (const resourceKey of resourceKeys) {
      const fields = await this.#client.hgetall(
        monitorAlertKey(this.#serverId, resourceKey),
      );
      if (!fields || fields.resolvedAt) continue;
      const lastNotifiedAt = fields.lastNotifiedAt ?? "";
      if (!lastNotifiedAt) continue;
      const lastDeliveredAt = fields.lastDeliveredAt ?? "";
      if (lastDeliveredAt && lastDeliveredAt >= lastNotifiedAt) continue;
      rows.push({
        resourceKey,
        serverId: this.#serverId,
        status: fields.status as MonitorResourceStatus,
        openedAt: fields.openedAt ?? "",
        lastNotifiedAt,
        cooldownUntil: fields.cooldownUntil || undefined,
      });
      drained.push({ resourceKey, lastNotifiedAt });
    }
    for (const { resourceKey, lastNotifiedAt } of drained) {
      await this.#client.hset(monitorAlertKey(this.#serverId, resourceKey), {
        lastDeliveredAt: lastNotifiedAt,
      });
    }
    return rows;
  }

  async getMonitorInstance(
    _serverId: string,
  ): Promise<MonitorInstanceRow | null> {
    const fields = await this.#client.hgetall(
      monitorInstanceKey(this.#serverId),
    );
    if (!fields) return null;

    let instance: MonitorInstanceSummary = {};
    if (fields.instanceJson) {
      try {
        instance = JSON.parse(fields.instanceJson) as MonitorInstanceSummary;
      } catch {
        instance = {};
      }
    }

    return {
      serverId: this.#serverId,
      sequence: Number(fields.sequence ?? 0),
      at: fields.at ?? "",
      instance,
      updatedAt: fields.updatedAt ?? "",
    };
  }

  async listMonitorResources(_serverId: string): Promise<MonitorResourceRow[]> {
    const resourceKeys = await this.#client.smembers(
      monitorResourcesIndexKey(this.#serverId),
    );
    const rows: MonitorResourceRow[] = [];
    for (const resourceKey of resourceKeys) {
      const fields = await this.#client.hgetall(
        monitorResourceKey(this.#serverId, resourceKey),
      );
      if (!fields) continue;

      let state: MonitorResourceState;
      try {
        state = JSON.parse(fields.stateJson) as MonitorResourceState;
      } catch {
        state = {
          resourceKey,
          kind: fields.kind as MonitorResourceState["kind"],
          status: fields.status as MonitorResourceState["status"],
        };
      }

      rows.push({
        resourceKey,
        serverId: this.#serverId,
        kind: state.kind,
        status: state.status,
        state,
        updatedAt: fields.updatedAt ?? "",
      });
    }
    rows.sort((a, b) => a.resourceKey.localeCompare(b.resourceKey));
    return rows;
  }

  async listMonitorEvents(
    _serverId: string,
    limit = 50,
  ): Promise<MonitorEventRow[]> {
    const entries = await this.#client.xrevrange(
      monitorEventsKey(this.#serverId),
      "+",
      "-",
      limit,
    );
    return entries.map((entry) =>
      parseMonitorEventRow(this.#serverId, entry.id, entry.fields)
    );
  }

  async listMonitorMetrics(
    _serverId: string,
    limit = 50,
  ): Promise<MonitorMetricRow[]> {
    const entries = await this.#client.xrevrange(
      monitorMetricsKey(this.#serverId),
      "+",
      "-",
    );
    const byBucket = new Map<string, MonitorMetricRow>();
    for (const entry of entries) {
      const bucketAt = entry.fields.bucketAt ?? "";
      if (!bucketAt || byBucket.has(bucketAt)) continue;
      const metric: MonitorMetricRow = {
        seq: Number(entry.id.split("-")[0] ?? entry.id),
        serverId: this.#serverId,
        bucketAt,
        createdAt: bucketAt,
      };
      if (entry.fields.cpu != null) metric.cpu = Number(entry.fields.cpu);
      if (entry.fields.memory != null) {
        metric.memory = Number(entry.fields.memory);
      }
      if (entry.fields.disk != null) metric.disk = Number(entry.fields.disk);
      if (entry.fields.load != null) metric.load = Number(entry.fields.load);
      byBucket.set(bucketAt, metric);
      if (byBucket.size >= limit) break;
    }
    return [...byBucket.values()];
  }
}
