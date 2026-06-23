import type { ServerAddresses } from "../../server-addresses.ts";
import type { ServerMetadata } from "../../lib/db/server-metadata.ts";
import type {
  MonitorInstanceSummary,
  MonitorResourceKind,
  MonitorResourceState,
  MonitorResourceStatus,
} from "./monitor-contracts.ts";
import type {
  DaemonInboundEnvelope,
  DaemonOutboundEnvelope,
  OutboxDeliveryId,
} from "./protocol.ts";

export type MonitorInstanceRow = {
  serverId: string;
  sequence: number;
  at: string;
  instance: MonitorInstanceSummary;
  updatedAt: string;
};

export type MonitorResourceRow = {
  resourceKey: string;
  serverId: string;
  kind: MonitorResourceKind;
  status: MonitorResourceStatus;
  state: MonitorResourceState;
  updatedAt: string;
};

export type MonitorEventRow = {
  seq: number;
  serverId: string;
  resourceKey?: string;
  kind?: MonitorResourceKind;
  fromStatus?: MonitorResourceStatus;
  toStatus: MonitorResourceStatus;
  reason?: string;
  at: string;
  createdAt: string;
};

export type MonitorMetricRow = {
  seq: number;
  serverId: string;
  bucketAt: string;
  cpu?: number;
  memory?: number;
  disk?: number;
  load?: number;
  createdAt: string;
};

export type MonitorAlertRow = {
  resourceKey: string;
  serverId: string;
  status: MonitorResourceStatus;
  openedAt: string;
  lastNotifiedAt?: string;
  cooldownUntil?: string;
  resolvedAt?: string;
};

export type DaemonCellBackend = "durable-object" | "redis";

export type DaemonCellLease = {
  holder: string;
  token: string;
  expiresAt: string;
};

export type DaemonCellSnapshot = {
  serverId: string;
  version: number;
  updatedAt: string;
  hostname?: string;
  machineId?: string;
  remoteAddress?: string;
  sessionId?: string;
  keyId?: string;
  connected: boolean;
  connectedAt?: string;
  lastInboundAt?: string;
  lastOutboundAt?: string;
  lastHeartbeatAt?: string;
  addresses?: ServerAddresses;
  metadata?: ServerMetadata;
};

export type PendingRequestStatus =
  | "queued"
  | "sent"
  | "acked"
  | "done"
  | "failed"
  | "expired";

export type PendingRequestRecord = {
  serverId: string;
  requestId: string;
  requestKind: string;
  status: PendingRequestStatus;
  createdAt: string;
  expiresAt: string;
  command?: string;
  ackAt?: string;
  finishedAt?: string;
  error?: string;
  result?: unknown;
};

export interface DaemonCell {
  attachDaemonSocket(meta: {
    keyId: string;
    hostname?: string;
    machineId?: string;
    remoteAddress?: string;
    connectedAt?: string;
  }): Promise<{ connectionId: string; lease: DaemonCellLease }>;

  detachDaemonSocket(params: {
    connectionId: string;
    leaseToken: string;
    reason?: string;
    closedAt?: string;
  }): Promise<void>;

  heartbeat(params: {
    connectionId?: string;
    hostname?: string;
    at?: string;
  }): Promise<void>;

  getSnapshot(): Promise<DaemonCellSnapshot>;
  putSnapshot(patch: Partial<DaemonCellSnapshot>): Promise<DaemonCellSnapshot>;
  appendEvent(
    kind: string,
    payload: Record<string, unknown>,
    ttlSeconds?: number,
  ): Promise<void>;
  listEvents(limit?: number): Promise<
    Array<{
      seq: string;
      kind: string;
      at: string;
      payload: Record<string, unknown>;
    }>
  >;

  enqueue(
    outbound: DaemonOutboundEnvelope,
    opts?: { ttlSeconds?: number },
  ): Promise<PendingRequestRecord>;
  markSent(
    deliveryId: OutboxDeliveryId,
    connectionId: string,
    sentAt?: string,
  ): Promise<void>;
  handleInbound(
    inbound: DaemonInboundEnvelope,
  ): Promise<PendingRequestRecord | null>;
  getRequest(requestId: string): Promise<PendingRequestRecord | null>;
  listRequests(
    limit?: number,
    filter?: { requestKind?: string },
  ): Promise<PendingRequestRecord[]>;
  waitForRequest(
    requestId: string,
    timeoutMs: number,
  ): Promise<PendingRequestRecord | null>;
  createRequestAndWait(
    outbound: DaemonOutboundEnvelope,
    timeoutMs: number,
  ): Promise<PendingRequestRecord>;

  claimDeliveryLease(
    holder: string,
    ttlMs: number,
  ): Promise<DaemonCellLease | null>;
  renewDeliveryLease(
    holder: string,
    token: string,
    ttlMs: number,
  ): Promise<DaemonCellLease | null>;
  releaseDeliveryLease(holder: string, token: string): Promise<void>;
  readOutboxBatch(params: {
    consumer: string;
    count: number;
    blockMs?: number;
  }): Promise<DaemonOutboundEnvelope[]>;
  ackOutbox(deliveryIds: OutboxDeliveryId[], consumer: string): Promise<void>;

  prune(now?: number): Promise<boolean>;

  applyMonitorSync(
    msg: DaemonInboundEnvelope & { kind: "monitor-sync" },
  ): Promise<{ acceptedSequence: number; resyncNeeded: boolean }>;
  applyMonitorHeartbeat(
    msg: DaemonInboundEnvelope & { kind: "monitor-heartbeat" },
  ): Promise<{ acceptedSequence: number; resyncNeeded: boolean }>;
  applyMonitorTransition(
    msg: DaemonInboundEnvelope & { kind: "monitor-transition" },
  ): Promise<{ acceptedSequence: number; resyncNeeded: boolean }>;
  getMonitorInstance(serverId: string): Promise<MonitorInstanceRow | null>;
  listMonitorResources(serverId: string): Promise<MonitorResourceRow[]>;
  listMonitorEvents(
    serverId: string,
    limit?: number,
  ): Promise<MonitorEventRow[]>;
  listMonitorMetrics(
    serverId: string,
    limit?: number,
  ): Promise<MonitorMetricRow[]>;
  drainNotificationCandidates(serverId: string): Promise<MonitorAlertRow[]>;
}

export interface DaemonCellRegistry {
  getCell(serverId: string): DaemonCell;
  listOnlineServerIds(): Promise<string[]>;
  getSnapshots(serverIds: string[]): Promise<Map<string, DaemonCellSnapshot>>;
}
