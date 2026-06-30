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

/** Known outbound request kinds enqueued on the cell outbox. */
export type PendingRequestKind =
  | "command"
  | "command-dispatch"
  | "addresses-request"
  | "dev-sync"
  | "tunnel-token"
  | "public-urls-update"
  | "update"
  | "echo";

export type PendingRequestRecord = {
  serverId: string;
  requestId: string;
  /** Outbound envelope kind that created this pending request. */
  requestKind: PendingRequestKind | string;
  status: PendingRequestStatus;
  createdAt: string;
  expiresAt: string;
  sentAt?: string;
  command?: string;
  ackAt?: string;
  finishedAt?: string;
  /** Daemon-side receive time from `command-ack.daemonReceivedAt`. */
  daemonReceivedAt?: string;
  /** Daemon-side response time from `command-outcome.daemonRespondedAt`. */
  daemonRespondedAt?: string;
  error?: string;
  result?: unknown;
};

/**
 * Inbound correlation for typed command dispatch (`command-dispatch` outbound):
 *
 * - `command-ack` — non-terminal; transitions the pending row to `status: "acked"`,
 *   sets `ackAt`, and persists `daemonReceivedAt`. The request row stays open for
 *   a follow-up outcome.
 * - `command-outcome` — terminal; transitions to `done` or `failed`, sets
 *   `finishedAt`, stores typed `result` / `error` like other ack/result pairs,
 *   and persists optional `daemonReceivedAt` / `daemonRespondedAt` from the wire.
 */

export type ExpiredUpdateRequest = {
  requestId: string;
  finishedAt: string;
};

export type ExpiredUpdateRequest = {
  requestId: string;
  finishedAt: string;
};

export type ClearUpdateStatusOptions = {
  /** When true, expire or clear non-terminal updates that are stale. */
  allowStale?: boolean;
  currentCommit?: string;
  targetCommit?: string;
  queuedAt?: string;
  updateTtlMs?: number;
};

/**
 * DaemonCell — the live daemon connection owner.
 *
 * Vocabulary:
 *   DaemonCell         = live connection owner (one per serverId)
 *   DaemonCellRegistry = factory/registry for DaemonCell instances
 *   Implementations:
 *     Workers → DaemonCellObject (SQLite-backed Durable Object, do.ts)
 *     Deno    → RedisDaemonCell (Redis-backed, redis/cell.ts)
 *
 * The DaemonCell is NOT a status read API. Status reads go through the
 * server status read model (server-status.ts / fleet-presence.ts) backed by Postgres.
 * Any new DaemonCell RPC must justify why it cannot be served from Postgres or the normal API.
 */
/**
 * DaemonCell — the live daemon connection owner.
 *
 * Vocabulary:
 *   DaemonCell         = live connection owner (one per serverId)
 *   DaemonCellRegistry = factory/registry for DaemonCell instances
 *   Implementations:
 *     Workers → DaemonCellObject (SQLite-backed Durable Object, do.ts)
 *     Deno    → RedisDaemonCell (Redis-backed, redis/cell.ts)
 *
 * The DaemonCell is NOT a status read API. Status reads go through the
 * server status read model (server-status.ts / fleet-presence.ts) backed by Postgres.
 * Any new DaemonCell RPC must justify why it cannot be served from Postgres or the normal API.
 */
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

  prune(now?: number): Promise<ExpiredUpdateRequest[]>;
  /** Drop terminal update request rows so org update status can be cleared manually. */
  clearUpdateStatus(opts?: ClearUpdateStatusOptions): Promise<{ cleared: number }>;
  purge(): Promise<void>;
}

export interface DaemonCellRegistry {
  getCell(serverId: string): DaemonCell;
  listOnlineServerIds(): Promise<string[]>;
  getSnapshots(serverIds: string[]): Promise<Map<string, DaemonCellSnapshot>>;
  purge(serverId: string): Promise<void>;
}
