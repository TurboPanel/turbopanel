import type { ServerAddresses } from "../../server-addresses.ts";
import type { ServerMetadata } from "../../lib/db/server-metadata.ts";
import type {
  DaemonInboundEnvelope,
  DaemonOutboundEnvelope,
  OutboxDeliveryId,
} from "./protocol.ts";

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
  lastSeenAt?: string;
  keyLastUsedAt?: string;
  addresses?: ServerAddresses;
  metadata?: ServerMetadata;
  agent?: import("./protocol.ts").DaemonAgentInfo;
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
  sentAt?: string;
  command?: string;
  ackAt?: string;
  finishedAt?: string;
  error?: string;
  result?: unknown;
};

export interface DaemonCell {
  attachDaemonSocket(meta: {
    keyId: string;
    sessionId?: string;
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

  recordInbound(params: {
    connectionId?: string;
    hostname?: string;
    at?: string;
    agent?: import("./protocol.ts").DaemonAgentInfo;
  }): Promise<void>;

  getSnapshot(): Promise<DaemonCellSnapshot>;
  putSnapshot(patch: Partial<DaemonCellSnapshot>): Promise<DaemonCellSnapshot>;

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
  purge(): Promise<void>;
}

export interface DaemonCellRegistry {
  getCell(serverId: string): DaemonCell;
  listOnlineServerIds(): Promise<string[]>;
  getSnapshots(serverIds: string[]): Promise<Map<string, DaemonCellSnapshot>>;
  purge(serverId: string): Promise<void>;
}
