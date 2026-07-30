import type { ServerAddresses } from "../../server-addresses.ts";
import type { ServerMetadata } from "../../lib/db/server-metadata.ts";
import type {
  DaemonInboundEnvelope,
  DaemonOutboundEnvelope,
  OutboxDeliveryId,
} from "./protocol.ts";

export type DaemonCellBackend = "durable-object" | "redis";

/** In-memory cell counters — zero I/O, no storage writes. */
export type CellDiagnostics = {
  backend: DaemonCellBackend;
  usesHibernationWebSocket: boolean;
  constructorCalls: number;
  wsAccepted: number;
  wsClosed: number;
  alarmInvocations: number;
  heartbeatCount: number;
  commandDispatchCount: number;
  cleanupCount: number;
  fetchByRoute: Record<string, number>;
  storageReads: number;
  storageWrites: number;
  storageByCallSite: Record<string, { reads: number; writes: number }>;
};

/**
 * Single-writer lease keyed by connectionId; holder is the connection identity.
 * On Workers (DO) the daemon-socket lease is in-memory only (`getWebSockets()` +
 * hibernation attachments); the delivery lease remains SQLite-backed (`lease`).
 */
export type DaemonCellLease = {
  holder: string;
  expiresAt: string;
};

export type DaemonCellSnapshot = {
  serverId: string;
  version: number;
  updatedAt: string;
  /** Postgres-canonical; no longer populated by cell storage. */
  hostname?: string;
  /** Postgres-canonical; no longer populated by cell storage. */
  machineKey?: string;
  remoteAddress?: string;
  connected: boolean;
  connectedAt?: string;
  lastInboundAt?: string;
  lastOutboundAt?: string;
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
export type PendingRequestKind = DaemonOutboundEnvelope["kind"];

export type PendingRequestRecord = {
  serverId: string;
  requestId: string;
  /** Outbound envelope kind that created this pending request. */
  requestKind: string;
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

/**
 * Read-only liveness probe (see `cell/offline-sweep.ts`). Reads only the
 * runtime-tracked WebSocket auto-response timestamp — the same free value
 * the ping/pong auto-response keeps warm — and never touches SQLite, so a
 * healthy server costs the sweep nothing beyond the request itself.
 */
export type DaemonCellLiveness = {
  connected: boolean;
  /** Epoch ms of the most recent auto-responded ping, or null if none seen yet this wake. */
  lastPingAtMs: number | null;
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
 * Requests vs delivery (both instance→daemon; DO schema v2 merges them):
 *   On Workers, one SQLite `request` row per requestId carries both concerns:
 *     correlation — status queued→sent→acked→done/failed/expired
 *                   (PendingRequestRecord; daemon replies mutate this row)
 *     delivery    — delivery_status queued/inflight/sent/acked/dead, keyed by
 *                   deliveryId (retry_count/retry_at); retain-on-ack, then pruned
 *                   with the correlation row (expires_at / TERMINAL_UPDATE_RETENTION_MS)
 *   Redis still uses a stream + PEL/xautoclaim for delivery and a separate
 *   correlation key until the parity phase mirrors the merged model.
 *   The WS send (#pumpOutboxToDaemonSockets / startDaemonOutboxPump) is ephemeral
 *   in-memory delivery; durability lives in the request row until pruned.
 *
 * The DaemonCell is NOT a status read API. Status reads go through the
 * server status read model (server-status.ts / fleet-presence.ts) backed by Postgres.
 * Any new DaemonCell RPC must justify why it cannot be served from Postgres or the normal API.
 *
 * {@link waitForRequest} and {@link createRequestAndWait} use a non-blocking backend
 * contract: implementations enqueue/persist and return quickly; the caller-side adapter
 * (worker isolate for Durable Objects, Deno process for Redis) performs polling until
 * terminal status or deadline.
 */
export interface DaemonCell {
  attachDaemonSocket(meta: {
    keyId: string;
    remoteAddress?: string;
    connectedAt?: string;
  }): Promise<{ connectionId: string; lease: DaemonCellLease }>;

  detachDaemonSocket(params: {
    connectionId: string;
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
    ttlMs: number,
  ): Promise<DaemonCellLease | null>;
  releaseDeliveryLease(holder: string): Promise<void>;
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

  /** Optional — real backends expose in-memory counters; test mocks may omit. */
  getDiagnostics?(): Promise<CellDiagnostics>;

  /**
   * Optional — Workers-only read-only liveness probe used by the offline
   * sweep cron (`cell/offline-sweep.ts`). Redis/Deno does not need this: it
   * already runs its own timer-driven `sweepStalePresence` (see AGENTS.md
   * Daemon Cell → Presence model).
   */
  checkLiveness?(): Promise<DaemonCellLiveness>;
}

export interface DaemonCellRegistry {
  getCell(serverId: string): DaemonCell;
  listOnlineServerIds(): Promise<string[]>;
  getSnapshots(serverIds: string[]): Promise<Map<string, DaemonCellSnapshot>>;
  purge(serverId: string): Promise<void>;
}
