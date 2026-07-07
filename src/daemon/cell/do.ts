/// <reference types="@cloudflare/workers-types" />
import type { DaemonJwtKeyring } from "../authn/daemon-jwt-keyring.ts";
import { deriveDaemonJwtKeyring } from "../authn/daemon-jwt-keyring.ts";
import { parseSecretsEnv } from "../../client/authn/secrets.ts";
import { createWorkersDb, endDbConnection, type Db } from "../../db.ts";
import type { ServerGeo } from "../../lib/geo/server-geo.ts";
import { parseServerGeo } from "../../lib/geo/server-geo.ts";
import { TERMINAL_UPDATE_RETENTION_MS } from "../../lib/update/constants.ts";
import { verifyDaemonJwt } from "../authn/daemon-jwt.ts";
import { inboundHeartbeatProjectionDue } from "./postgres-projection.ts";
import {
  onDaemonConnected,
  onDaemonDisconnected,
  onDaemonInbound,
  onDaemonUpdateExpired,
  onDaemonUpdateResult,
} from "./control-plane-monitor.ts";
import type {
  ClearUpdateStatusOptions,
  CellDiagnostics,
  DaemonCell,
  DaemonCellLease,
  DaemonCellLiveness,
  DaemonCellSnapshot,
  PendingRequestRecord,
  PendingRequestStatus,
} from "./contracts.ts";
import type {
  DaemonAgentInfo,
  DaemonInboundEnvelope,
  DaemonOutboundEnvelope,
  OutboxDeliveryId,
} from "./protocol.ts";
import {
  DAEMON_CELL_PING,
  DAEMON_CELL_PONG,
  DAEMON_OFFLINE_SWEEP_MS,
  outboundEnvelopeToWireMessage,
  parseDaemonMessage,
  wireMessageToInboundEnvelope,
} from "./protocol.ts";

function createInitialCellDiagnostics(): CellDiagnostics {
  return {
    backend: "durable-object",
    usesHibernationWebSocket: true,
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

const TERMINAL_STATUSES = new Set<PendingRequestStatus>([
  "done",
  "failed",
  "expired",
]);

const DAEMON_SOCKET_LEASE_MS = 180_000;
const OUTBOX_INFLIGHT_LEASE_MS = 30_000;
const DELIVERY_LEASE_NAME = "delivery";
const DAEMON_SOCKET_LEASE_NAME = "daemon-socket";
const OUTBOX_PUMP_ALARM_MS = 2_000;
const OUTBOX_MAX_RETRIES = 10;
const OUTBOX_RETRY_MAX_MS = 300_000;
const HEARTBEAT_COALESCE_MS = 60_000;
const CELL_GEO_HEADER = "X-Turbopanel-Cell-Geo";

type ProjectionDbFactory = () => Db | null;

let projectionDbFactoryForTests: ProjectionDbFactory | null = null;

/** Test-only seam: override Postgres client used by DO→Postgres projection writes. */
export function setDaemonCellProjectionDbFactoryForTests(
  factory: ProjectionDbFactory | null,
): void {
  projectionDbFactoryForTests = factory;
}

function nowIso(now = Date.now()): string {
  return new Date(now).toISOString();
}

function safeParseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function readFirstSqlRow<T extends Record<string, SqlStorageValue>>(
  cursor: Iterable<T>,
): T | null {
  const iterator = cursor[Symbol.iterator]();
  const first = iterator.next();
  return first.done ? null : first.value;
}

function sqlCursorHasRow(cursor: Iterable<unknown>): boolean {
  const iterator = cursor[Symbol.iterator]();
  return !iterator.next().done;
}

function readSqlChanges(
  cursor: Iterable<Record<string, SqlStorageValue>>,
): number {
  const row = readFirstSqlRow(cursor);
  return row ? Number(row.c ?? 0) : 0;
}

function outboxRetryDelayMs(retryCount: number): number {
  const exponent = Math.max(0, retryCount - 1);
  return Math.min(
    OUTBOX_PUMP_ALARM_MS * (2 ** exponent),
    OUTBOX_RETRY_MAX_MS,
  );
}

function isTerminalStatus(status: PendingRequestStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function parseAgentJson(raw: string | null): DaemonAgentInfo | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as DaemonAgentInfo;
  } catch {
    return undefined;
  }
}

function agentIdentityEqual(
  a: DaemonAgentInfo | undefined,
  b: DaemonAgentInfo | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.commit === b.commit &&
    a.buildId === b.buildId &&
    a.builtAt === b.builtAt &&
    a.channel === b.channel;
}

function snapshotFromMetaRow(
  serverId: string,
  row: Record<string, SqlStorageValue>,
  connected: boolean,
): DaemonCellSnapshot {
  return {
    serverId,
    version: 0,
    updatedAt: String(row.updated_at ?? nowIso()),
    remoteAddress: row.remote_address ? String(row.remote_address) : undefined,
    connected,
    connectedAt: row.connected_at ? String(row.connected_at) : undefined,
    lastInboundAt: row.last_seen_at ? String(row.last_seen_at) : undefined,
    lastSeenAt: row.last_seen_at ? String(row.last_seen_at) : undefined,
    keyLastUsedAt: row.key_last_used_at ? String(row.key_last_used_at) : undefined,
    agent: parseAgentJson(row.agent_json ? String(row.agent_json) : null),
  };
}

function parseRequestRow(
  serverId: string,
  row: Record<string, SqlStorageValue>,
): PendingRequestRecord {
  const record: PendingRequestRecord = {
    serverId,
    requestId: String(row.request_id),
    requestKind: String(row.request_kind ?? ""),
    status: String(row.status ?? "queued") as PendingRequestStatus,
    createdAt: String(row.created_at ?? nowIso()),
    expiresAt: String(row.expires_at ?? nowIso()),
  };
  if (row.sent_at) record.sentAt = String(row.sent_at);
  if (row.ack_at) record.ackAt = String(row.ack_at);
  if (row.finished_at) record.finishedAt = String(row.finished_at);
  if (row.daemon_received_at) {
    record.daemonReceivedAt = String(row.daemon_received_at);
  }
  if (row.daemon_responded_at) {
    record.daemonRespondedAt = String(row.daemon_responded_at);
  }
  if (row.error) record.error = String(row.error);
  if (row.command_text) record.command = String(row.command_text);
  if (row.result_json) {
    try {
      record.result = JSON.parse(String(row.result_json));
    } catch {
      record.result = String(row.result_json);
    }
  }
  return record;
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  CLOUDFLARE DURABLE OBJECT — HIBERNATION COST RULES             ║
 * ║  Violating these rules causes continuous GB-sec billing.        ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║  1. NO setInterval / setTimeout — use ctx.storage.setAlarm()   ║
 * ║  2. NO standard server.accept() — use ctx.acceptWebSocket()    ║
 * ║  3. NO polling loops inside handlers                            ║
 * ║  4. NO long-running awaits / pending promises in memory         ║
 * ║  5. Finish every handler quickly and return                     ║
 * ║  6. Close every outbound DB connection in a finally block       ║
 * ║  7. One stable DO id per server (getByName(serverId))           ║
 * ║  8. Workers (DO) and self-hosted (Redis) must stay in parity    ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */
export class DaemonCellObject {
  readonly #ctx: DurableObjectState;
  readonly #env: CloudflareBindings;
  #schemaReady = false;
  #daemonJwtKeyring: DaemonJwtKeyring | null = null;
  #daemonJwtKeyringPromise: Promise<DaemonJwtKeyring> | null = null;
  readonly #diag: CellDiagnostics = createInitialCellDiagnostics();
  readonly #debugStorage: boolean;
  #serverId: string | null = null;
  readonly #sweptOffline = new Set<string>();
  #runtimeConnected = false;
  #scheduledAlarmMs: number | null = null;
  #scheduledAlarmMsLoaded = false;
  readonly #sql: (
    callSite: string,
    query: string,
    ...args: unknown[]
  ) => Iterable<Record<string, SqlStorageValue>>;

  constructor(ctx: DurableObjectState, env: CloudflareBindings) {
    this.#ctx = ctx;
    this.#env = env;
    this.#debugStorage = this.#isDaemonDebug();
    const exec = ctx.storage.sql.exec.bind(ctx.storage.sql);
    if (this.#debugStorage) {
      this.#sql = (callSite, query, ...args) => {
        this.#countStorage(callSite, query);
        return exec(query, ...args);
      };
    } else {
      this.#sql = (_callSite, query, ...args) => exec(query, ...args);
    }
    this.#diag.constructorCalls += 1;
    if (this.#isDaemonDebug()) {
      console.debug("daemon cell diagnostics: constructor");
    }
    this.#ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(DAEMON_CELL_PING, DAEMON_CELL_PONG),
    );
    this.#initializeFromStorage();
  }

  /** Sync constructor bootstrap — schema, cached server id, live-socket presence. */
  #initializeFromStorage(): void {
    this.#ensureSchema();
    const row = readFirstSqlRow(this.#sql(
      "constructor",
      "SELECT server_id, remote_address, agent_json FROM cell LIMIT 1",
    ));
    if (row) {
      this.#serverId = String(row.server_id ?? "");
    }
    if (this.#serverId && this.#hasLiveSocket(this.#serverId)) {
      this.#runtimeConnected = true;
    }
  }

  async #loadScheduledAlarmMsIfNeeded(): Promise<void> {
    if (this.#scheduledAlarmMsLoaded) return;
    this.#scheduledAlarmMs = await this.#ctx.storage.getAlarm();
    this.#scheduledAlarmMsLoaded = true;
  }

  #hasLiveSocket(serverId: string): boolean {
    return this.#ctx.getWebSockets().some((ws) => {
      const attachment = ws.deserializeAttachment() as {
        serverId?: string;
      } | null;
      return attachment?.serverId === serverId;
    });
  }

  /**
   * Read-only liveness probe for the offline sweep cron (`cell/offline-sweep.ts`).
   * Only inspects in-memory WebSocket state — no SQLite reads or writes — so
   * a healthy server costs the sweep nothing beyond this one request.
   */
  #getLivenessSnapshot(serverId: string): DaemonCellLiveness {
    let connected = false;
    let lastPingAtMs: number | null = null;
    const allSockets = this.#ctx.getWebSockets();
    // #region agent log — debug session 2e6859, hypothesis H6/H9 (sticky
    // false-offline: attachment mismatch or auto-response timestamp not
    // surviving hibernation). Remove after verification.
    console.info(
      `[debug:2e6859:H6] getLivenessSnapshot serverId=${serverId} totalSockets=${
        allSockets.length
      } sockets=${
        JSON.stringify(
          allSockets.map((ws) => {
            const attachment = ws.deserializeAttachment() as {
              serverId?: string;
            } | null;
            const autoTs = this.#ctx.getWebSocketAutoResponseTimestamp(ws);
            return {
              attachedServerId: attachment?.serverId ?? null,
              matches: attachment?.serverId === serverId,
              autoResponseTs: autoTs ? autoTs.getTime() : null,
              autoResponseAgeMs: autoTs ? Date.now() - autoTs.getTime() : null,
              readyState: ws.readyState,
            };
          }),
        )
      }`,
    );
    // #endregion
    for (const ws of allSockets) {
      const attachment = ws.deserializeAttachment() as {
        serverId?: string;
      } | null;
      if (attachment?.serverId !== serverId) continue;
      connected = true;
      const autoTs = this.#ctx.getWebSocketAutoResponseTimestamp(ws);
      if (autoTs) {
        lastPingAtMs = Math.max(lastPingAtMs ?? 0, autoTs.getTime());
      }
    }
    return { connected, lastPingAtMs };
  }

  #bumpFetchRoute(route: string): void {
    this.#diag.fetchByRoute[route] = (this.#diag.fetchByRoute[route] ?? 0) + 1;
    if (this.#isDaemonDebug()) {
      console.debug(`daemon cell diagnostics: fetchByRoute ${route}`);
    }
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
    if (this.#isDaemonDebug()) {
      console.debug(`daemon cell diagnostics: ${field}`);
    }
  }

  #isDaemonDebug(): boolean {
    return this.#env.TURBOPANEL_DAEMON_DEBUG === "1" ||
      this.#env.TURBOPANEL_DAEMON_DEBUG === "true";
  }

  #trace(
    event: string,
    detail: Record<string, unknown>,
    level: "debug" | "info" = "debug",
  ): void {
    if (!this.#isDaemonDebug()) return;
    const parts: string[] = [`daemon-cell event=${event}`];
    for (const key of Object.keys(detail).sort((a, b) => a.localeCompare(b))) {
      const value = detail[key];
      if (value === undefined || value === null) continue;
      const serialized = typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
      parts.push(`${key}=${serialized}`);
    }
    const line = parts.join(" ");
    if (level === "info") {
      console.info(line);
    } else {
      console.debug(line);
    }
  }

  #bumpStorageCount(callSite: string, kind: "read" | "write"): void {
    if (!this.#isDaemonDebug()) return;
    if (kind === "read") {
      this.#diag.storageReads += 1;
    } else {
      this.#diag.storageWrites += 1;
    }
    const bucket = this.#diag.storageByCallSite[callSite] ?? { reads: 0, writes: 0 };
    if (kind === "read") {
      bucket.reads += 1;
    } else {
      bucket.writes += 1;
    }
    this.#diag.storageByCallSite[callSite] = bucket;
    this.#trace("storage-op", { callSite, kind });
  }

  #countStorage(callSite: string, query: string): void {
    if (!this.#isDaemonDebug()) return;
    const trimmed = query.trimStart().toUpperCase();
    if (
      trimmed.startsWith("SELECT") ||
      trimmed.startsWith("PRAGMA") ||
      trimmed.startsWith("EXPLAIN")
    ) {
      this.#bumpStorageCount(callSite, "read");
      return;
    }
    if (
      trimmed.startsWith("INSERT") ||
      trimmed.startsWith("UPDATE") ||
      trimmed.startsWith("DELETE") ||
      trimmed.startsWith("REPLACE") ||
      trimmed.startsWith("CREATE") ||
      trimmed.startsWith("ALTER") ||
      trimmed.startsWith("DROP")
    ) {
      this.#bumpStorageCount(callSite, "write");
    }
  }

  async #setAlarm(callSite: string, timeMs: number): Promise<void> {
    if (this.#debugStorage) this.#bumpStorageCount(callSite, "write");
    await this.#ctx.storage.setAlarm(timeMs);
  }

  async #deleteAlarm(callSite: string): Promise<void> {
    if (this.#debugStorage) this.#bumpStorageCount(callSite, "write");
    await this.#ctx.storage.deleteAlarm();
  }

  async #deleteAll(callSite: string): Promise<void> {
    if (this.#debugStorage) this.#bumpStorageCount(callSite, "write");
    await this.#ctx.storage.deleteAll();
  }

  async #getDaemonJwtKeyring(): Promise<DaemonJwtKeyring> {
    if (this.#daemonJwtKeyring) return this.#daemonJwtKeyring;
    if (!this.#daemonJwtKeyringPromise) {
      this.#daemonJwtKeyringPromise = (async () => {
        const secretsConfig = parseSecretsEnv(
          this.#env.TURBOPANEL_SECRET,
          this.#env.TURBOPANEL_SECRETS,
          "workers",
        );
        const keyring = await deriveDaemonJwtKeyring(secretsConfig);
        this.#daemonJwtKeyring = keyring;
        return keyring;
      })();
    }
    return await this.#daemonJwtKeyringPromise;
  }

  #ensureSchema(): void {
    if (this.#schemaReady) return;
    this.#sql("ensure-schema", `
      CREATE TABLE IF NOT EXISTS cell (
        server_id TEXT PRIMARY KEY,
        remote_address TEXT,
        connected_at TEXT,
        last_seen_at TEXT,
        key_last_used_at TEXT,
        agent_json TEXT,
        updated_at TEXT
      )
    `);
    this.#sql("ensure-schema", `
      CREATE TABLE IF NOT EXISTS leases (
        lease_name TEXT PRIMARY KEY,
        holder TEXT,
        expires_at TEXT
      )
    `);
    this.#sql("ensure-schema", `
      CREATE TABLE IF NOT EXISTS outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT,
        delivery_id TEXT UNIQUE,
        kind TEXT,
        payload_json TEXT,
        status TEXT DEFAULT 'queued',
        created_at TEXT,
        expires_at TEXT,
        sent_at TEXT,
        acked_at TEXT,
        retry_count INTEGER DEFAULT 0,
        retry_at TEXT
      )
    `);
    this.#sql("ensure-schema", `
      CREATE TABLE IF NOT EXISTS requests (
        request_id TEXT PRIMARY KEY,
        request_kind TEXT,
        command_text TEXT,
        status TEXT,
        result_json TEXT,
        error TEXT,
        created_at TEXT,
        updated_at TEXT,
        expires_at TEXT,
        ack_at TEXT,
        finished_at TEXT,
        sent_at TEXT,
        daemon_received_at TEXT,
        daemon_responded_at TEXT
      )
    `);
    this.#schemaReady = true;
  }

  #resolveServerId(request: Request): string | null {
    if (this.#serverId) return this.#serverId;
    const header = request.headers.get("X-Turbopanel-Cell-Server-Id")?.trim();
    if (header) return header;
    const cursor = this.#sql("resolve-server-id",
      "SELECT server_id FROM cell LIMIT 1",
    );
    for (const row of cursor) {
      const id = row.server_id;
      if (id) return String(id);
    }
    return null;
  }

  #ensureServerId(serverId: string): void {
    this.#sql("ensure-server-id",
      `INSERT INTO cell (server_id, updated_at)
       VALUES (?, ?)
       ON CONFLICT(server_id) DO NOTHING`,
      serverId,
      nowIso(),
    );
  }

  /**
   * Build a Postgres client for the sparse presence projection. The native
   * Workers WebSocket path terminates inside the Durable Object (hibernation),
   * so connect/disconnect/agent transitions must be projected from here rather
   * than from the main worker. Returns `null` when no database binding is
   * configured (e.g. unit tests), making projection a no-op.
   */
  #newProjectionDb(): Db | null {
    if (projectionDbFactoryForTests) {
      return projectionDbFactoryForTests();
    }
    if (this.#env.HYPERDRIVE) {
      return createWorkersDb(this.#env.HYPERDRIVE);
    }
    const url = this.#env.TURBOPANEL_DATABASE_URL?.trim();
    if (url) {
      return createWorkersDb({ connectionString: url });
    }
    return null;
  }

  // COST RULE: Every Hyperdrive/postgres.js client opened here MUST be closed
  // in the finally block. An open outbound connection prevents DO hibernation.
  async #withProjectionDb(
    label: string,
    serverId: string,
    fn: (db: Db) => Promise<void>,
  ): Promise<void> {
    const db = this.#newProjectionDb();
    if (!db) return;
    try {
      await fn(db);
    } catch (err) {
      console.error(
        `daemon cell ${label} projection failed (${serverId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      await endDbConnection(db);
    }
  }

  #readCellRow(serverId: string): Record<string, SqlStorageValue> | null {
    return readFirstSqlRow(this.#sql("presence-should-project",
      "SELECT last_seen_at, agent_json FROM cell WHERE server_id = ?",
      serverId,
    ));
  }

  /** Gate Postgres work using SQLite state before opening Hyperdrive. */
  #shouldProjectInbound(
    serverId: string,
    at: string,
    agent?: DaemonAgentInfo,
    cellRow?: Record<string, SqlStorageValue> | null,
    effectiveLastSeenAt?: string | null,
  ): boolean {
    const meta = cellRow ?? this.#readCellRow(serverId);
    const runtimeConnected = this.#runtimeConnected;
    const cellLastSeenAt = effectiveLastSeenAt ??
      (meta?.last_seen_at ? String(meta.last_seen_at) : null);
    const storedAgent = parseAgentJson(
      meta?.agent_json ? String(meta.agent_json) : null,
    );

    return inboundHeartbeatProjectionDue({
      runtimeConnected,
      cellLastSeenAt,
      inboundAt: at,
      storedAgent,
      incomingAgent: agent,
    });
  }

  /**
   * Minimal in-process `DaemonCell` facade backed by this cell's own storage so
   * the shared `control-plane-monitor` projection helpers can read/patch the
   * snapshot without an extra RPC round-trip.
   */
  #projectionCell(serverId: string): DaemonCell {
    return {
      getSnapshot: () => this.#getSnapshot(serverId),
      putSnapshot: (patch: Partial<DaemonCellSnapshot>) =>
        this.#putSnapshot(serverId, patch),
    } as unknown as DaemonCell;
  }

  async #projectConnected(
    serverId: string,
    connectedAt: string,
    geo?: ServerGeo,
    keyId?: string,
  ): Promise<void> {
    await this.#withProjectionDb("connect", serverId, async (db) => {
      await onDaemonConnected(
        db,
        serverId,
        this.#projectionCell(serverId),
        connectedAt,
        undefined,
        geo,
        keyId,
      );
      if (this.#isDaemonDebug()) {
        console.debug(`daemon cell projection: connected (${serverId})`);
      }
    });
  }

  async #projectDisconnected(serverId: string): Promise<void> {
    await this.#withProjectionDb("disconnect", serverId, async (db) => {
      await onDaemonDisconnected(db, serverId, this.#projectionCell(serverId));
      if (this.#isDaemonDebug()) {
        console.debug(`daemon cell projection: disconnected (${serverId})`);
      }
    });
  }

  async #projectUpdateResult(
    serverId: string,
    requestId: string,
    ok: boolean,
    finishedAt: string,
    error?: string,
  ): Promise<void> {
    await this.#withProjectionDb("update-result", serverId, async (db) => {
      await onDaemonUpdateResult(
        db,
        serverId,
        requestId,
        ok,
        finishedAt,
        error,
      );
      if (this.#isDaemonDebug()) {
        console.debug(`daemon cell projection: update-result (${serverId})`);
      }
    });
  }

  async #projectUpdateExpired(
    serverId: string,
    requestId: string,
    finishedAt: string,
    error?: string,
  ): Promise<void> {
    await this.#withProjectionDb("update-expired", serverId, async (db) => {
      await onDaemonUpdateExpired(
        db,
        serverId,
        requestId,
        finishedAt,
        error,
      );
      if (this.#isDaemonDebug()) {
        console.debug(`daemon cell projection: update-expired (${serverId})`);
      }
    });
  }

  // COST RULE: #projectInbound is only called when #shouldProjectInbound returns
  // true (i.e., the HEARTBEAT_COALESCE_MS window has elapsed or agent changed).
  // Idle heartbeats update only SQLite cell via #recordInbound and never
  // open a Hyperdrive connection. Every #withProjectionDb call closes the
  // connection in its finally block — no outbound socket lingers.
  async #projectInbound(
    serverId: string,
    at?: string,
    agent?: DaemonAgentInfo,
  ): Promise<void> {
    await this.#withProjectionDb("inbound", serverId, async (db) => {
      await onDaemonInbound(
        db,
        serverId,
        this.#projectionCell(serverId),
        { at, agent },
      );
    });
  }

  async fetch(request: Request): Promise<Response> {
    this.#ensureSchema();

    if (request.headers.get("Upgrade") === "websocket") {
      this.#bumpFetchRoute("ws-upgrade");
      return await this.#handleWebSocketUpgrade(request);
    }

    const url = new URL(request.url);
    if (!url.pathname.startsWith("/rpc/")) {
      return errorResponse("not found", 404);
    }

    try {
      return await this.#handleRpc(request, url);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResponse(message, 500);
    }
  }

  #existingDaemonSocketHolder(): string | null {
    const cursor = this.#sql("attach", 
      "SELECT holder FROM leases WHERE lease_name = ?",
      DAEMON_SOCKET_LEASE_NAME,
    );
    for (const row of cursor) {
      const holder = String(row.holder ?? "");
      if (holder) return holder;
    }
    return null;
  }

  #forceDetachDaemonSocket(serverId: string, connectionId: string): void {
    const closedAt = nowIso();
    this.#ctx.storage.transactionSync(() => {
      this.#sql("attach",
        `DELETE FROM leases
         WHERE lease_name = ? AND holder = ?`,
        DAEMON_SOCKET_LEASE_NAME,
        connectionId,
      );
      this.#sql("attach",
        `UPDATE cell SET last_seen_at = ?, updated_at = ?
         WHERE server_id = ?`,
        closedAt,
        closedAt,
        serverId,
      );
    });
  }

  #applyDaemonSocketAttach(
    serverId: string,
    connectionId: string,
    meta: {
      keyId: string;
      remoteAddress?: string;
      connectedAt?: string;
    },
  ): DaemonCellLease {
    const connectedAt = meta.connectedAt ?? nowIso();
    const keyLastUsedAt = nowIso();
    const leaseExpiresAt = new Date(Date.now() + DAEMON_SOCKET_LEASE_MS)
      .toISOString();

    this.#serverId = serverId;
    this.#sweptOffline.delete(serverId);
    this.#runtimeConnected = true;

    this.#ctx.storage.transactionSync(() => {
      this.#ensureServerId(serverId);
      this.#sql("attach",
        `INSERT INTO cell (
          server_id, remote_address, connected_at,
          last_seen_at, key_last_used_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(server_id) DO UPDATE SET
          remote_address = excluded.remote_address,
          connected_at = excluded.connected_at,
          last_seen_at = excluded.last_seen_at,
          key_last_used_at = excluded.key_last_used_at,
          updated_at = excluded.updated_at`,
        serverId,
        meta.remoteAddress ?? "",
        connectedAt,
        connectedAt,
        keyLastUsedAt,
        connectedAt,
      );
      this.#sql("attach",
        `INSERT INTO leases (lease_name, holder, expires_at)
         VALUES (?, ?, ?)
         ON CONFLICT(lease_name) DO UPDATE SET
           holder = excluded.holder,
           expires_at = excluded.expires_at`,
        DAEMON_SOCKET_LEASE_NAME,
        connectionId,
        leaseExpiresAt,
      );
    });

    return {
      holder: connectionId,
      expiresAt: leaseExpiresAt,
    };
  }

  async #scheduleNearestAlarm(): Promise<void> {
    await this.#loadScheduledAlarmMsIfNeeded();
    const nowMs = Date.now();
    const candidates = this.#collectAlarmCandidates(nowMs);
    const target = candidates.length === 0 ? null : Math.min(...candidates);

    if (target === this.#scheduledAlarmMs) {
      return;
    }

    if (target === null) {
      await this.#deleteAlarm("schedule-alarm");
    } else {
      await this.#setAlarm("schedule-alarm", target);
    }
    this.#scheduledAlarmMs = target;
  }

  #collectAlarmCandidates(nowMs: number): number[] {
    const candidates: number[] = [];
    const hasSocket = this.#ctx.getWebSockets().length > 0;
    const now = nowIso(nowMs);

    const bumpPump = (candidateMs: number) => {
      if (candidateMs <= nowMs) {
        candidates.push(nowMs);
        return;
      }
      candidates.push(candidateMs);
    };

    const bumpCleanup = (candidateMs: number) => {
      if (candidateMs <= nowMs) return;
      candidates.push(candidateMs);
    };

    const hasDeliverableOutbox = this.#collectOutboxAlarmTimes(
      now,
      hasSocket,
      bumpPump,
      bumpCleanup,
    );

    if (hasSocket && hasDeliverableOutbox) {
      bumpPump(nowMs);
    }

    this.#collectRequestAlarmTimes(nowMs, bumpCleanup);

    return candidates;
  }

  #collectOutboxAlarmTimes(
    now: string,
    hasSocket: boolean,
    bumpPump: (ms: number) => void,
    bumpCleanup: (ms: number) => void,
  ): boolean {
    let hasDeliverableOutbox = false;
    const outboxCursor = this.#sql("schedule-alarm",
      "SELECT status, retry_at, sent_at, expires_at FROM outbox",
    );
    for (const row of outboxCursor) {
      if (this.#applyOutboxRowToAlarmSchedule(
        row,
        now,
        hasSocket,
        bumpPump,
        bumpCleanup,
      )) {
        hasDeliverableOutbox = true;
      }
    }
    return hasDeliverableOutbox;
  }

  #applyOutboxRowToAlarmSchedule(
    row: Record<string, SqlStorageValue>,
    now: string,
    hasSocket: boolean,
    bumpPump: (ms: number) => void,
    bumpCleanup: (ms: number) => void,
  ): boolean {
    const status = String(row.status ?? "");
    const retryAt = row.retry_at ? String(row.retry_at) : null;
    const sentAt = row.sent_at ? String(row.sent_at) : null;
    const expiresAt = row.expires_at ? String(row.expires_at) : null;

    let deliverable = false;
    if (status === "queued" && (!retryAt || retryAt <= now)) {
      deliverable = true;
    }
    const retryMs = safeParseMs(retryAt);
    if (status === "queued" && retryMs !== null && retryAt && retryAt > now && hasSocket) {
      bumpPump(retryMs);
    }
    const sentMs = safeParseMs(sentAt);
    if (status === "inflight" && sentMs !== null && hasSocket) {
      bumpPump(sentMs + OUTBOX_INFLIGHT_LEASE_MS);
    }
    const expiresMs = safeParseMs(expiresAt);
    if (expiresMs !== null) {
      bumpCleanup(expiresMs);
    }
    return deliverable;
  }

  #collectRequestAlarmTimes(
    nowMs: number,
    bumpCleanup: (ms: number) => void,
  ): void {
    const requestsCursor = this.#sql("schedule-alarm",
      "SELECT status, expires_at, finished_at FROM requests",
    );
    for (const row of requestsCursor) {
      const status = String(row.status ?? "");
      const expiresAt = row.expires_at ? String(row.expires_at) : null;
      const finishedAt = row.finished_at ? String(row.finished_at) : null;

      const expiresMs = safeParseMs(expiresAt);
      if (expiresMs !== null) {
        bumpCleanup(expiresMs);
      }
      const finishedMs = safeParseMs(finishedAt);
      if (
        finishedMs !== null &&
        (status === "acked" || status === "done" || status === "failed" ||
          status === "expired")
      ) {
        bumpCleanup(finishedMs + TERMINAL_UPDATE_RETENTION_MS);
      }
    }
  }

  #hasDeliverableOutbox(nowMs = Date.now()): boolean {
    const now = nowIso(nowMs);
    return sqlCursorHasRow(this.#sql("schedule-alarm", 
      `SELECT seq FROM outbox
       WHERE status = 'queued' AND (retry_at IS NULL OR retry_at <= ?)
       LIMIT 1`,
      now,
    ));
  }

  #refreshLivenessFromAutoResponseTimestamps(): void {
    for (const ws of this.#ctx.getWebSockets()) {
      const autoTs = this.#ctx.getWebSocketAutoResponseTimestamp(ws);
      if (!autoTs) continue;

      const attachment = ws.deserializeAttachment() as {
        serverId: string;
      } | null;
      if (!attachment?.serverId) continue;

      const autoAt = autoTs.toISOString();
      this.#sql("alarm",
        `UPDATE cell SET last_seen_at = ?, updated_at = ?
         WHERE server_id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)`,
        autoAt,
        nowIso(),
        attachment.serverId,
        autoAt,
      );
    }
  }

  #requeueExpiredInflightOutbox(nowMs = Date.now()): void {
    const cutoff = nowIso(nowMs - OUTBOX_INFLIGHT_LEASE_MS);
    this.#sql("outbox-requeue", 
      `UPDATE outbox SET status = 'queued', sent_at = NULL
       WHERE status = 'inflight' AND sent_at IS NOT NULL AND sent_at <= ?`,
      cutoff,
    );
  }

  #requeueOutbox(deliveryId: string): void {
    const nowMs = Date.now();
    const cursor = this.#sql("outbox-requeue", 
      "SELECT retry_count FROM outbox WHERE delivery_id = ?",
      deliveryId,
    );
    let retryCount = 0;
    for (const row of cursor) {
      retryCount = Number(row.retry_count ?? 0);
    }

    const nextRetryCount = retryCount + 1;
    if (nextRetryCount >= OUTBOX_MAX_RETRIES) {
      this.#sql("outbox-requeue", 
        `UPDATE outbox
         SET status = 'dead', retry_count = ?, retry_at = NULL, sent_at = NULL
         WHERE delivery_id = ?`,
        nextRetryCount,
        deliveryId,
      );
      return;
    }

    const retryAt = nowIso(nowMs + outboxRetryDelayMs(nextRetryCount));
    this.#sql("outbox-requeue", 
      `UPDATE outbox
       SET status = 'queued', retry_count = ?, retry_at = ?, sent_at = NULL
       WHERE delivery_id = ?`,
      nextRetryCount,
      retryAt,
      deliveryId,
    );
  }

  async #scheduleOutboxRetryIfNeeded(): Promise<void> {
    if (!this.#hasDeliverableOutbox()) return;
    await this.#scheduleNearestAlarm();
  }

  async #pumpOutboxToDaemonSockets(serverId: string): Promise<void> {
    const sockets = this.#ctx.getWebSockets();
    if (sockets.length === 0) return;

    this.#requeueExpiredInflightOutbox();

    const batch = await this.#readOutboxBatch(serverId, {
      consumer: "do-ws",
      count: 50,
    });
    if (batch.length === 0) return;

    for (const ws of sockets) {
      const attachment = ws.deserializeAttachment() as {
        connectionId: string;
        serverId: string;
      } | null;
      if (attachment?.serverId !== serverId) continue;

      for (const envelope of batch) {
        try {
          const wireMsg = outboundEnvelopeToWireMessage(envelope);
          this.#trace("outbox-send", {
            serverId,
            conn: attachment.connectionId,
            deliveryId: envelope.deliveryId,
            requestId: envelope.requestId,
            kind: envelope.kind,
          });
          ws.send(JSON.stringify(wireMsg));
          await this.#markSent(
            serverId,
            envelope.deliveryId,
            attachment.connectionId,
          );
          await this.#ackOutbox(serverId, [envelope.deliveryId]);
        } catch {
          this.#requeueOutbox(envelope.deliveryId);
        }
      }
    }

    if (this.#hasDeliverableOutbox()) {
      await this.#scheduleOutboxRetryIfNeeded();
    } else {
      await this.#scheduleNearestAlarm();
    }
  }

  async #handleWebSocketUpgrade(request: Request): Promise<Response> {
    const authHeader = request.headers.get("Authorization") ?? "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : "";
    if (!token) return new Response("Unauthorized", { status: 401 });

    const keyring = await this.#getDaemonJwtKeyring();
    const payload = await verifyDaemonJwt(token, keyring);
    if (!payload) return new Response("Unauthorized", { status: 401 });

    const serverId = payload.sub;
    const keyId = payload.kid;

    const connectionId = crypto.randomUUID();
    const connectedAt = nowIso();
    const remoteAddress = request.headers.get("X-Real-IP") ?? "";
    const geo = this.#parseConnectGeoHeader(request);

    const existingHolder = this.#existingDaemonSocketHolder();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.#ctx.acceptWebSocket(server);
    this.#bumpDiag("wsAccepted");

    if (existingHolder && existingHolder !== connectionId) {
      this.#forceDetachDaemonSocket(serverId, existingHolder);
      for (const ws of this.#ctx.getWebSockets()) {
        if (ws !== server) {
          ws.close(4000, "replaced by new connection");
        }
      }
    }

    server.serializeAttachment({ connectionId, serverId });

    this.#applyDaemonSocketAttach(serverId, connectionId, {
      keyId,
      remoteAddress,
      connectedAt,
    });

    this.#trace("attach", {
      serverId,
      conn: connectionId,
      remoteAddress,
    });

    console.info(
      `daemon-cell event=attach serverId=${serverId} conn=${connectionId} remoteAddress=${remoteAddress}`,
    );

    this.#ctx.waitUntil(
      this.#projectConnected(serverId, connectedAt, geo ?? undefined, keyId),
    );
    void this.#pumpOutboxToDaemonSockets(serverId);
    await this.#scheduleNearestAlarm();

    return new Response(null, { status: 101, webSocket: client });
  }

  #parseConnectGeoHeader(request: Request): ServerGeo | null {
    const raw = request.headers.get(CELL_GEO_HEADER)?.trim();
    if (!raw) return null;
    try {
      return parseServerGeo(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  #shouldCoalesceLastSeenAt(
    serverId: string,
    atMs: number,
    lastSeenAt?: string | null,
  ): boolean {
    if (lastSeenAt !== undefined) {
      if (!lastSeenAt) return true;
      const lastSeenMs = Date.parse(lastSeenAt);
      if (Number.isNaN(lastSeenMs)) return true;
      return atMs - lastSeenMs >= HEARTBEAT_COALESCE_MS;
    }
    const row = readFirstSqlRow(this.#sql("record-inbound",
      "SELECT last_seen_at FROM cell WHERE server_id = ?",
      serverId,
    ));
    if (!row) return true;
    const stored = row.last_seen_at ? String(row.last_seen_at) : null;
    if (!stored) return true;
    const lastSeenMs = Date.parse(stored);
    if (Number.isNaN(lastSeenMs)) return true;
    return atMs - lastSeenMs >= HEARTBEAT_COALESCE_MS;
  }

  #readStoredAgent(
    serverId: string,
    cellRow?: Record<string, SqlStorageValue> | null,
  ): DaemonAgentInfo | undefined {
    if (cellRow) {
      return parseAgentJson(
        cellRow.agent_json ? String(cellRow.agent_json) : null,
      );
    }
    const row = readFirstSqlRow(this.#sql("record-inbound",
      "SELECT agent_json FROM cell WHERE server_id = ?",
      serverId,
    ));
    if (!row) return undefined;
    return parseAgentJson(
      row.agent_json ? String(row.agent_json) : null,
    );
  }

  #recordInbound(
    serverId: string,
    at: string,
    agent?: DaemonAgentInfo,
    connectionId?: string,
    cellRow?: Record<string, SqlStorageValue> | null,
    effectiveLastSeen?: string | null,
  ): void {
    this.#sweptOffline.delete(serverId);
    if (this.#hasLiveSocket(serverId)) {
      this.#runtimeConnected = true;
    }

    const atMs = Date.parse(at);
    const lastSeenForCoalesce = effectiveLastSeen ??
      (cellRow?.last_seen_at ? String(cellRow.last_seen_at) : undefined);
    const coalesce = Number.isNaN(atMs) ||
      this.#shouldCoalesceLastSeenAt(serverId, atMs, lastSeenForCoalesce);
    const now = nowIso();

    let agentChanged = false;
    if (agent) {
      agentChanged = !agentIdentityEqual(
        agent,
        this.#readStoredAgent(serverId, cellRow),
      );
    }

    if (coalesce && this.#isDaemonDebug()) {
      console.debug(`daemon cell inbound (${serverId}) last_seen_at bumped`);
    }

    if (agent) {
      if (coalesce) {
        this.#sql("record-inbound",
          `UPDATE cell SET last_seen_at = ?, key_last_used_at = ?, agent_json = ?, updated_at = ?
           WHERE server_id = ?`,
          at,
          at,
          JSON.stringify(agent),
          now,
          serverId,
        );
      } else if (agentChanged) {
        this.#sql("record-inbound",
          `UPDATE cell SET key_last_used_at = ?, agent_json = ?, updated_at = ? WHERE server_id = ?`,
          at,
          JSON.stringify(agent),
          now,
          serverId,
        );
      } else {
        this.#sql("record-inbound",
          "UPDATE cell SET key_last_used_at = ?, updated_at = ? WHERE server_id = ?",
          at,
          now,
          serverId,
        );
      }
      if (connectionId) {
        this.#trace("record-inbound", {
          serverId,
          conn: connectionId,
          coalesced: coalesce,
          agentChanged,
        });
      }
      return;
    }

    if (coalesce) {
      this.#sql("record-inbound",
        `UPDATE cell SET last_seen_at = ?, key_last_used_at = ?, updated_at = ?
         WHERE server_id = ?`,
        at,
        at,
        now,
        serverId,
      );
    } else {
      this.#sql("record-inbound",
        "UPDATE cell SET key_last_used_at = ?, updated_at = ? WHERE server_id = ?",
        at,
        now,
        serverId,
      );
    }

    if (connectionId) {
      this.#trace("record-inbound", {
        serverId,
        conn: connectionId,
        coalesced: coalesce,
        agentChanged,
      });
    }
  }

  #applyWebSocketAutoResponseLiveness(
    ws: WebSocket,
    serverId: string,
    connectionId: string,
    cellRow: Record<string, SqlStorageValue> | null,
    autoTs: Date | null,
  ): void {
    if (!autoTs) return;

    const autoAt = autoTs.toISOString();
    const lastSeen = cellRow?.last_seen_at ? String(cellRow.last_seen_at) : null;
    const shouldTracePong = !lastSeen || lastSeen < autoAt;

    this.#sql("ws-message-liveness",
      `UPDATE cell SET last_seen_at = ?, updated_at = ?
       WHERE server_id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)`,
      autoAt,
      nowIso(),
      serverId,
      autoAt,
    );
    if (shouldTracePong) {
      this.#trace("pong", { serverId, conn: connectionId });
    }
  }

  async #handlePresenceMessage(
    attachment: {
      connectionId: string;
      serverId: string;
    },
    parsed: {
      type: "hello" | "heartbeat";
      at?: string;
      agent?: DaemonAgentInfo;
    },
    cellRow: Record<string, SqlStorageValue> | null,
    effectiveLastSeen: string | null,
  ): Promise<void> {
    this.#bumpDiag("heartbeatCount");
    const at = parsed.at ?? nowIso();
    const shouldProject = this.#shouldProjectInbound(
      attachment.serverId,
      at,
      parsed.agent,
      cellRow,
      effectiveLastSeen,
    );
    this.#recordInbound(
      attachment.serverId,
      at,
      parsed.agent,
      attachment.connectionId,
      cellRow,
      effectiveLastSeen,
    );
    const shouldProjectInbound = parsed.type === "hello"
      ? shouldProject ||
        Boolean(parsed.agent?.commit && parsed.agent?.buildId)
      : shouldProject;
    if (shouldProjectInbound) {
      await this.#projectInbound(attachment.serverId, at, parsed.agent);
    }
  }

  #effectiveLastSeenFromRow(
    cellRow: Record<string, SqlStorageValue> | null,
    autoTs: Date | null,
  ): string | null {
    const storedLastSeen = cellRow?.last_seen_at
      ? String(cellRow.last_seen_at)
      : null;
    const storedMs = storedLastSeen ? Date.parse(storedLastSeen) : 0;
    const autoMs = autoTs ? autoTs.getTime() : 0;
    const effectiveMs = Math.max(
      Number.isNaN(storedMs) ? 0 : storedMs,
      Number.isNaN(autoMs) ? 0 : autoMs,
    );
    if (effectiveMs <= 0) return storedLastSeen;
    return new Date(effectiveMs).toISOString();
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    this.#ensureSchema();
    const attachment = ws.deserializeAttachment() as {
      connectionId: string;
      serverId: string;
    } | null;
    if (!attachment) return;

    const cellRow = readFirstSqlRow(this.#sql("ws-message",
      "SELECT last_seen_at, agent_json FROM cell WHERE server_id = ?",
      attachment.serverId,
    ));
    const autoTs = this.#ctx.getWebSocketAutoResponseTimestamp(ws);
    const effectiveLastSeen = this.#effectiveLastSeenFromRow(cellRow, autoTs);

    this.#applyWebSocketAutoResponseLiveness(
      ws,
      attachment.serverId,
      attachment.connectionId,
      cellRow,
      autoTs,
    );

    const raw = typeof message === "string"
      ? message
      : new TextDecoder().decode(message);

    const parsed = parseDaemonMessage(raw);
    if (!parsed) return;

    this.#trace("inbound", {
      serverId: attachment.serverId,
      conn: attachment.connectionId,
      type: parsed.type,
    });

    if (parsed.type === "hello" || parsed.type === "heartbeat") {
      await this.#handlePresenceMessage(
        attachment,
        parsed,
        cellRow,
        effectiveLastSeen,
      );
      return;
    }

    this.#recordInbound(
      attachment.serverId,
      parsed.at,
      undefined,
      attachment.connectionId,
      cellRow,
      effectiveLastSeen,
    );
    await this.#handleInboundMessage(attachment.serverId, parsed);
    await this.#scheduleNearestAlarm();
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
  ): Promise<void> {
    this.#ensureSchema();
    await this.#cleanupWebSocket(ws, code, reason);
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.#ensureSchema();
    await this.#cleanupWebSocket(ws, 1011, "error");
  }

  async #cleanupWebSocket(
    ws: WebSocket,
    code: number,
    reason: string,
  ): Promise<void> {
    this.#bumpDiag("wsClosed");
    this.#bumpDiag("cleanupCount");
    const attachment = ws.deserializeAttachment() as {
      connectionId: string;
      serverId: string;
    } | null;
    if (!attachment) return;

    const closedAt = nowIso();

    let isCurrentConnection = false;
    this.#ctx.storage.transactionSync(() => {
      this.#sql("cleanup",
        `DELETE FROM leases
         WHERE lease_name = ? AND holder = ?`,
        DAEMON_SOCKET_LEASE_NAME,
        attachment.connectionId,
      );
      isCurrentConnection = readSqlChanges(
        this.#sql("cleanup", "SELECT changes() AS c"),
      ) > 0;

      if (isCurrentConnection) {
        this.#sql("cleanup",
          `UPDATE cell SET last_seen_at = ?, updated_at = ?
           WHERE server_id = ?`,
          closedAt,
          closedAt,
          attachment.serverId,
        );
      }
    });

    if (isCurrentConnection) {
      this.#runtimeConnected = false;
      this.#trace("detach", {
        serverId: attachment.serverId,
        conn: attachment.connectionId,
        reason,
        code,
      });
      await this.#projectDisconnected(attachment.serverId);
      console.info(
        `daemon-cell event=detach serverId=${attachment.serverId} conn=${attachment.connectionId} code=${code} reason=${reason}`,
      );
      await this.#scheduleNearestAlarm();
    }
  }

  #runAlarmCleanup(nowMs: number, now: string): Array<{ requestId: string }> {
    const expiringUpdates: Array<{ requestId: string }> = [];
    const expiringCursor = this.#sql("alarm",
      `SELECT request_id, request_kind, status FROM requests
       WHERE expires_at <= ?
       AND request_kind = 'update'
       AND status NOT IN ('done', 'failed', 'expired', 'acked')`,
      now,
    );
    for (const row of expiringCursor) {
      expiringUpdates.push({ requestId: String(row.request_id ?? "") });
    }

    this.#sql("alarm",
      "DELETE FROM requests WHERE expires_at <= ?",
      now,
    );
    this.#sql("alarm",
      `DELETE FROM requests
       WHERE status IN ('acked', 'done', 'failed', 'expired')
       AND finished_at IS NOT NULL
       AND finished_at <= ?`,
      nowIso(nowMs - TERMINAL_UPDATE_RETENTION_MS),
    );
    this.#sql("alarm",
      "DELETE FROM outbox WHERE expires_at <= ?",
      now,
    );
    this.#sql("alarm",
      "DELETE FROM outbox WHERE status = 'dead'",
    );
    return expiringUpdates;
  }

  /**
   * Opportunistic half-open backstop — runs only when `alarm()` fires for
   * genuine work (outbox retry, request/outbox expiry, terminal retention).
   *
   * **Disconnect-first trade-off (Workers):** connected-cell offline detection
   * is driven by `webSocketClose` / `webSocketError` → `#cleanupWebSocket`.
   * The periodic stale-sweep alarm is intentionally absent so idle cells stay
   * hibernating with zero storage writes. A truly silent half-open socket with
   * no pending work self-heals on the next reconnect (lease force-detach) or
   * command dispatch (outbox send failure → requeue → consumer timeout).
   * Redis (Deno) keeps a timer-driven sweep via `maintain()` instead.
   */
  #collectStaleDemotions(nowMs: number): string[] {
    const staleCutoff = nowIso(nowMs - DAEMON_OFFLINE_SWEEP_MS);
    const staleDemotions: string[] = [];
    const liveSockets = this.#ctx.getWebSockets();
    if (liveSockets.length === 0) return staleDemotions;

    const cellRow = readFirstSqlRow(this.#sql("alarm",
      "SELECT server_id, last_seen_at FROM cell LIMIT 1",
    ));
    if (!cellRow?.last_seen_at) return staleDemotions;

    const lastSeenAt = String(cellRow.last_seen_at);
    if (lastSeenAt > staleCutoff) return staleDemotions;

    for (const ws of liveSockets) {
      const attachment = ws.deserializeAttachment() as {
        serverId?: string;
      } | null;
      const staleServerId = attachment?.serverId ??
        (cellRow.server_id ? String(cellRow.server_id) : null);
      if (!staleServerId || this.#sweptOffline.has(staleServerId)) {
        continue;
      }
      this.#sweptOffline.add(staleServerId);
      this.#runtimeConnected = false;
      staleDemotions.push(staleServerId);
      console.info(
        `daemon-cell event=alarm-stale serverId=${staleServerId}`,
      );
    }
    return staleDemotions;
  }

  async alarm(): Promise<void> {
    this.#scheduledAlarmMs = null;
    this.#bumpDiag("alarmInvocations");
    this.#ensureSchema();
    const nowMs = Date.now();
    const now = nowIso(nowMs);
    const serverId = this.#resolveServerId(new Request("https://do.internal/"));

    this.#refreshLivenessFromAutoResponseTimestamps();

    const expiringUpdates = this.#runAlarmCleanup(nowMs, now);
    const staleDemotions = this.#collectStaleDemotions(nowMs);

    if (serverId && expiringUpdates.length > 0) {
      await this.#withProjectionDb("alarm-update-expired", serverId, async (db) => {
        for (const { requestId } of expiringUpdates) {
          await onDaemonUpdateExpired(db, serverId, requestId, now);
        }
      });
    }

    for (const staleServerId of staleDemotions) {
      await this.#projectDisconnected(staleServerId);
    }

    if (serverId) {
      this.#requeueExpiredInflightOutbox(nowMs);
      await this.#pumpOutboxToDaemonSockets(serverId);
    }

    await this.#scheduleNearestAlarm();
  }

  async purge(): Promise<void> {
    for (const ws of this.#ctx.getWebSockets()) {
      try {
        ws.close(1000, "cell purged");
      } catch {
        // Socket may already be closed.
      }
    }

    const serverId = this.#resolveServerId(new Request("https://do.internal/"));
    if (serverId) {
      this.#ctx.storage.transactionSync(() => {
        this.#sql("purge", "DELETE FROM leases");
      });
    }

    await this.#deleteAlarm("purge");
    await this.#deleteAll("purge");
    this.#scheduledAlarmMs = null;
    this.#scheduledAlarmMsLoaded = false;
    this.#schemaReady = false;
    this.#runtimeConnected = false;
  }

  /** Read-only GET routes that don't need the shared body-parsing/switch below. */
  async #handleReadOnlyRpc(
    path: string,
    method: string,
    request: Request,
  ): Promise<Response | null> {
    if (method !== "GET") return null;

    if (path === "/rpc/diagnostics") {
      return jsonResponse(this.#diag);
    }

    if (path === "/rpc/snapshot") {
      const serverId = this.#resolveServerId(request);
      if (!serverId) return errorResponse("server id unknown", 404);
      return jsonResponse(await this.#getSnapshot(serverId));
    }

    if (path === "/rpc/liveness") {
      const serverId = this.#resolveServerId(request);
      if (!serverId) return errorResponse("server id unknown", 404);
      return jsonResponse(this.#getLivenessSnapshot(serverId));
    }

    return null;
  }

  async #handleRpc(request: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    const method = request.method;
    this.#bumpFetchRoute(path);

    const readOnly = await this.#handleReadOnlyRpc(path, method, request);
    if (readOnly) return readOnly;

    const body = method === "GET"
      ? null
      : await request.json() as Record<string, unknown>;

    switch (path) {
      case "/rpc/snapshot":
        if (method !== "PATCH") return errorResponse("method not allowed", 405);
        return jsonResponse(
          await this.#putSnapshot(
            this.#requireServerId(request, body),
            (body?.patch ?? body) as Partial<DaemonCellSnapshot>,
          ),
        );

      case "/rpc/enqueue":
        return jsonResponse(
          await this.#enqueue(
            this.#requireServerId(request, body),
            body?.outbound as DaemonOutboundEnvelope,
            body?.opts as { ttlSeconds?: number } | undefined,
          ),
        );

      case "/rpc/mark-sent":
        await this.#markSent(
          this.#requireServerId(request, body),
          String(body?.deliveryId ?? ""),
          String(body?.connectionId ?? ""),
          body?.sentAt as string | undefined,
        );
        return jsonResponse({ ok: true });

      case "/rpc/inbound":
        return jsonResponse({
          record: await this.#handleInbound(
            this.#requireServerId(request, body),
            body?.inbound as DaemonInboundEnvelope,
          ),
        });

      case "/rpc/request":
        if (method !== "GET") return errorResponse("method not allowed", 405);
        return jsonResponse({
          record: await this.#getRequest(
            this.#resolveServerId(request),
            String(url.searchParams.get("requestId") ?? body?.requestId ?? ""),
          ),
        });

      case "/rpc/requests":
        if (method !== "GET") return errorResponse("method not allowed", 405);
        return jsonResponse({
          records: await this.#listRequests(
            this.#resolveServerId(request),
            Number(url.searchParams.get("limit") ?? 50),
            url.searchParams.get("requestKind") ?? undefined,
          ),
        });

      case "/rpc/wait-request":
        return jsonResponse({
          record: await this.#waitForRequest(
            this.#requireServerId(request, body),
            String(body?.requestId ?? ""),
            Number(body?.timeoutMs ?? 0),
          ),
        });

      case "/rpc/expire-request":
        return jsonResponse({
          record: await this.#expireRequest(
            this.#requireServerId(request, body),
            String(body?.requestId ?? ""),
          ),
        });

      case "/rpc/create-and-wait":
        return jsonResponse({
          record: await this.#createRequestAndWait(
            this.#requireServerId(request, body),
            body?.outbound as DaemonOutboundEnvelope,
            Number(body?.timeoutMs ?? 0),
          ),
        });

      case "/rpc/attach":
        return jsonResponse(
          await this.#attachDaemonSocket(
            this.#requireServerId(request, body),
            body?.meta as {
              keyId: string;
              remoteAddress?: string;
              connectedAt?: string;
            },
          ),
        );

      case "/rpc/detach":
        await this.#detachDaemonSocket(
          this.#requireServerId(request, body),
          body?.params as {
            connectionId: string;
            reason?: string;
            closedAt?: string;
          },
        );
        return jsonResponse({ ok: true });

      case "/rpc/record-inbound":
        this.#recordInbound(
          this.#requireServerId(request, body),
          String((body?.params as { at?: string })?.at ?? nowIso()),
          (body?.params as { agent?: DaemonAgentInfo })?.agent,
          (body?.params as { connectionId?: string })?.connectionId,
        );
        return jsonResponse({ ok: true });

      case "/rpc/lease/claim":
        return jsonResponse({
          lease: await this.#claimDeliveryLease(
            this.#requireServerId(request, body),
            String(body?.holder ?? ""),
            Number(body?.ttlMs ?? 0),
          ),
        });

      case "/rpc/lease/renew":
        return jsonResponse({
          lease: await this.#renewDeliveryLease(
            this.#requireServerId(request, body),
            String(body?.holder ?? ""),
            Number(body?.ttlMs ?? 0),
          ),
        });

      case "/rpc/lease/release":
        await this.#releaseDeliveryLease(
          this.#requireServerId(request, body),
          String(body?.holder ?? ""),
        );
        return jsonResponse({ ok: true });

      case "/rpc/outbox/read":
        return jsonResponse({
          envelopes: await this.#readOutboxBatch(
            this.#requireServerId(request, body),
            body?.params as {
              consumer: string;
              count: number;
              blockMs?: number;
            },
          ),
        });

      case "/rpc/outbox/ack":
        await this.#ackOutbox(
          this.#requireServerId(request, body),
          (body?.deliveryIds ?? []) as OutboxDeliveryId[],
        );
        return jsonResponse({ ok: true });

      case "/rpc/clear-update-status":
        return jsonResponse(
          await this.#clearUpdateStatus(
            this.#requireServerId(request, body),
            body as ClearUpdateStatusOptions | null,
          ),
        );

      case "/rpc/purge-cell":
        await this.purge();
        return jsonResponse({ ok: true });

      default:
        return errorResponse("not found", 404);
    }
  }

  #requireServerId(
    request: Request,
    body: Record<string, unknown> | null,
  ): string {
    const fromBody = typeof body?.serverId === "string"
      ? body.serverId.trim()
      : "";
    const serverId = fromBody || this.#resolveServerId(request);
    if (!serverId) throw new Error("server id unknown");
    this.#ensureServerId(serverId);
    return serverId;
  }

  async #getSnapshot(serverId: string | null): Promise<DaemonCellSnapshot> {
    if (!serverId) {
      return {
        serverId: "",
        version: 0,
        updatedAt: nowIso(),
        connected: false,
      };
    }

    // Read-only: never insert `cell` here. Reading a missing or purged
    // snapshot returns a synthetic disconnected snapshot without recreating the
    // row. Row creation belongs only on mutation paths (attach, patch, enqueue,
    // and other writes that go through `#ensureServerId`).
    const row = readFirstSqlRow(this.#sql("snapshot",
      "SELECT * FROM cell WHERE server_id = ?",
      serverId,
    ));
    if (row) {
      return snapshotFromMetaRow(
        serverId,
        row,
        this.#runtimeConnected,
      );
    }

    return {
      serverId,
      version: 0,
      updatedAt: nowIso(),
      connected: false,
    };
  }

  async #putSnapshot(
    serverId: string,
    patch: Partial<DaemonCellSnapshot>,
  ): Promise<DaemonCellSnapshot> {
    const updatedAt = nowIso();
    const fields: Array<string | null> = [updatedAt];
    let sql = "UPDATE cell SET updated_at = ?";

    if (patch.lastSeenAt !== undefined) {
      sql += ", last_seen_at = ?";
      fields.push(patch.lastSeenAt);
    }
    if (patch.keyLastUsedAt !== undefined) {
      sql += ", key_last_used_at = ?";
      fields.push(patch.keyLastUsedAt);
    }

    sql += " WHERE server_id = ?";
    fields.push(serverId);
    this.#sql("snapshot", sql, ...fields);
    this.#trace("snapshot-put", {
      serverId,
      keys: Object.keys(patch).join(","),
    });
    return await this.#getSnapshot(serverId);
  }

  async #enqueue(
    serverId: string,
    outbound: DaemonOutboundEnvelope,
    opts?: { ttlSeconds?: number },
  ): Promise<PendingRequestRecord> {
    if (outbound.kind === "command" || outbound.kind === "command-dispatch") {
      this.#bumpDiag("commandDispatchCount");
    }
    const now = Date.now();
    const createdAt = outbound.at ?? nowIso(now);
    const ttlSeconds = opts?.ttlSeconds ?? 300;
    const expiresAt = nowIso(now + ttlSeconds * 1000);

    const existingRow = readFirstSqlRow(this.#sql("enqueue", 
      "SELECT * FROM requests WHERE request_id = ?",
      outbound.requestId,
    ));
    if (existingRow) {
      const exists = sqlCursorHasRow(this.#sql("enqueue", 
        "SELECT seq FROM outbox WHERE delivery_id = ?",
        outbound.deliveryId,
      ));
      if (exists) {
        return parseRequestRow(serverId, existingRow);
      }

      this.#ctx.storage.transactionSync(() => {
        this.#sql("enqueue", 
          `INSERT INTO outbox (
            request_id, delivery_id, kind, payload_json, status, created_at, expires_at
          ) VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
          outbound.requestId,
          outbound.deliveryId,
          outbound.kind,
          JSON.stringify(outbound),
          createdAt,
          expiresAt,
        );
        this.#sql("enqueue", 
          "UPDATE requests SET updated_at = ? WHERE request_id = ?",
          nowIso(),
          outbound.requestId,
        );
      });
      void this.#pumpOutboxToDaemonSockets(serverId);
      void this.#scheduleOutboxRetryIfNeeded();
      this.#trace("enqueue", {
        serverId,
        requestId: outbound.requestId,
        deliveryId: outbound.deliveryId,
        kind: outbound.kind,
      });
      return parseRequestRow(serverId, existingRow);
    }

    this.#ctx.storage.transactionSync(() => {
      this.#sql("enqueue", 
        `INSERT INTO requests (
          request_id, request_kind, command_text, status, created_at, updated_at, expires_at
        ) VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
        outbound.requestId,
        outbound.kind,
        outbound.kind === "command" ? outbound.command : null,
        createdAt,
        createdAt,
        expiresAt,
      );
      this.#sql("enqueue", 
        `INSERT INTO outbox (
          request_id, delivery_id, kind, payload_json, status, created_at, expires_at
        ) VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
        outbound.requestId,
        outbound.deliveryId,
        outbound.kind,
        JSON.stringify(outbound),
        createdAt,
        expiresAt,
      );
    });

    const insertedRow = readFirstSqlRow(this.#sql("enqueue", 
      "SELECT * FROM requests WHERE request_id = ?",
      outbound.requestId,
    ));
    if (insertedRow) {
      void this.#pumpOutboxToDaemonSockets(serverId);
      void this.#scheduleOutboxRetryIfNeeded();
      this.#trace("enqueue", {
        serverId,
        requestId: outbound.requestId,
        deliveryId: outbound.deliveryId,
        kind: outbound.kind,
      });
      return parseRequestRow(serverId, insertedRow);
    }

    void this.#pumpOutboxToDaemonSockets(serverId);
    void this.#scheduleOutboxRetryIfNeeded();
    this.#trace("enqueue", {
      serverId,
      requestId: outbound.requestId,
      deliveryId: outbound.deliveryId,
      kind: outbound.kind,
    });
    return {
      serverId,
      requestId: outbound.requestId,
      requestKind: outbound.kind,
      status: "queued",
      createdAt,
      expiresAt,
    };
  }

  async #markSent(
    serverId: string,
    deliveryId: string,
    _connectionId: string,
    sentAt?: string,
  ): Promise<void> {
    const at = sentAt ?? nowIso();
    let requestId: string | undefined;
    this.#ctx.storage.transactionSync(() => {
      this.#sql("mark-sent", 
        `UPDATE outbox SET status = 'sent', sent_at = ? WHERE delivery_id = ?`,
        at,
        deliveryId,
      );
      const row = readFirstSqlRow(this.#sql("mark-sent", 
        "SELECT request_id FROM outbox WHERE delivery_id = ?",
        deliveryId,
      ));
      if (row) {
        requestId = String(row.request_id);
        this.#sql("mark-sent", 
          `UPDATE requests SET status = 'sent', sent_at = ?, updated_at = ?
           WHERE request_id = ?`,
          at,
          at,
          requestId,
        );
      }
    });
    this.#trace("mark-sent", { serverId, requestId, deliveryId });
  }

  async #handleInboundMessage(
    serverId: string,
    msg: ReturnType<typeof parseDaemonMessage>,
  ): Promise<void> {
    if (!msg) return;
    const inbound = wireMessageToInboundEnvelope(msg);
    if (!inbound) return;
    await this.#handleInbound(serverId, inbound);
  }

  #readRequestRow(
    serverId: string,
    requestId: string,
  ): PendingRequestRecord | null {
    const row = readFirstSqlRow(this.#sql("request-read", 
      "SELECT * FROM requests WHERE request_id = ?",
      requestId,
    ));
    return row ? parseRequestRow(serverId, row) : null;
  }

  #applyLateTerminalAck(
    serverId: string,
    inbound: DaemonInboundEnvelope,
    existing: PendingRequestRecord,
  ): PendingRequestRecord | null {
    if (inbound.kind !== "command-ack" || existing.ackAt) return null;
    const ackAt = inbound.at;
    this.#sql("handle-inbound", 
      `UPDATE requests SET ack_at = ?, daemon_received_at = COALESCE(?, daemon_received_at),
       updated_at = ? WHERE request_id = ?`,
      ackAt,
      inbound.daemonReceivedAt,
      nowIso(),
      inbound.requestId,
    );
    this.#trace("handle-inbound", {
      serverId,
      requestId: inbound.requestId,
      kind: inbound.kind,
      statusFrom: existing.status,
      statusTo: "late-ack",
    });
    return this.#readRequestRow(serverId, inbound.requestId);
  }

  async #applyCommandAckInbound(
    serverId: string,
    inbound: Extract<DaemonInboundEnvelope, { kind: "command-ack" }>,
    existing: PendingRequestRecord,
  ): Promise<PendingRequestRecord> {
    if (existing.status === "acked") return existing;
    const ackAt = inbound.at;
    this.#sql("handle-inbound", 
      `UPDATE requests SET status = 'acked', ack_at = ?, daemon_received_at = ?,
       updated_at = ? WHERE request_id = ?`,
      ackAt,
      inbound.daemonReceivedAt,
      nowIso(),
      inbound.requestId,
    );
    this.#sql("handle-inbound",
      `UPDATE cell SET last_seen_at = ?, updated_at = ? WHERE server_id = ?`,
      ackAt,
      nowIso(),
      serverId,
    );
    this.#trace("handle-inbound", {
      serverId,
      requestId: inbound.requestId,
      kind: inbound.kind,
      statusFrom: existing.status,
      statusTo: "acked",
    });
    return this.#readRequestRow(serverId, inbound.requestId) ?? existing;
  }

  #resolveInboundCompletion(
    inbound: DaemonInboundEnvelope,
    row: Record<string, SqlStorageValue>,
  ): {
    status: PendingRequestStatus;
    result?: unknown;
    error?: string;
    finishedAt: string;
    daemonReceivedAt: string | null;
    daemonRespondedAt: string | null;
    ackAt: string | null;
  } | null {
    let status: PendingRequestStatus;
    let result: unknown;
    let error: string | undefined;

    switch (inbound.kind) {
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

    const finishedAt = inbound.at;
    const daemonReceivedAt = inbound.kind === "command-outcome"
      ? inbound.daemonReceivedAt ?? null
      : null;
    const daemonRespondedAt = inbound.kind === "command-outcome"
      ? inbound.daemonRespondedAt ?? null
      : null;
    const ackAt = inbound.kind === "command-outcome" && !row.ack_at
      ? (inbound.daemonReceivedAt ?? inbound.at)
      : null;

    return {
      status,
      result,
      error,
      finishedAt,
      daemonReceivedAt,
      daemonRespondedAt,
      ackAt,
    };
  }

  async #applyInboundCompletion(
    serverId: string,
    inbound: DaemonInboundEnvelope,
    existing: PendingRequestRecord,
    completion: {
      status: PendingRequestStatus;
      result?: unknown;
      error?: string;
      finishedAt: string;
      daemonReceivedAt: string | null;
      daemonRespondedAt: string | null;
      ackAt: string | null;
    },
  ): Promise<PendingRequestRecord> {
    const { status, result, error, finishedAt, daemonReceivedAt, daemonRespondedAt, ackAt } =
      completion;
    this.#sql("handle-inbound", 
      `UPDATE requests SET status = ?, result_json = ?, error = ?,
       finished_at = ?, daemon_received_at = COALESCE(?, daemon_received_at),
       daemon_responded_at = ?, ack_at = COALESCE(ack_at, ?), updated_at = ? WHERE request_id = ?`,
      status,
      result === undefined ? null : JSON.stringify(result),
      error ?? null,
      finishedAt,
      daemonReceivedAt,
      daemonRespondedAt,
      ackAt,
      nowIso(),
      inbound.requestId,
    );

    this.#trace("handle-inbound", {
      serverId,
      requestId: inbound.requestId,
      kind: inbound.kind,
      statusFrom: existing.status,
      statusTo: status,
    });

    const record = this.#readRequestRow(serverId, inbound.requestId) ?? existing;
    if (isTerminalStatus(record.status)) {
      this.#reclaimTerminalOutbox(inbound.requestId);
      await this.#scheduleNearestAlarm();
    }
    if (inbound.kind === "update-result") {
      await this.#projectUpdateResult(
        serverId,
        inbound.requestId,
        inbound.ok,
        inbound.at,
        inbound.error,
      );
    }
    return record;
  }

  async #handleInbound(
    serverId: string,
    inbound: DaemonInboundEnvelope,
  ): Promise<PendingRequestRecord | null> {
    const row = readFirstSqlRow(this.#sql("handle-inbound", 
      "SELECT * FROM requests WHERE request_id = ?",
      inbound.requestId,
    ));
    if (!row) return null;

    const existing = parseRequestRow(serverId, row);
    if (isTerminalStatus(existing.status)) {
      return this.#applyLateTerminalAck(serverId, inbound, existing) ?? existing;
    }

    if (inbound.kind === "command-ack") {
      return this.#applyCommandAckInbound(serverId, inbound, existing);
    }

    const completion = this.#resolveInboundCompletion(inbound, row);
    if (!completion) return existing;

    return this.#applyInboundCompletion(serverId, inbound, existing, completion);
  }

  #reclaimTerminalOutbox(requestId: string): void {
    this.#sql("outbox-ack", 
      "DELETE FROM outbox WHERE request_id = ?",
      requestId,
    );
  }

  async #getRequest(
    serverId: string | null,
    requestId: string,
  ): Promise<PendingRequestRecord | null> {
    if (!serverId || !requestId) return null;
    return this.#readRequestRow(serverId, requestId);
  }

  async #listRequests(
    serverId: string | null,
    limit: number,
    requestKind?: string,
  ): Promise<PendingRequestRecord[]> {
    if (!serverId) return [];
    const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 50;
    const cursor = requestKind
      ? this.#sql("request-read", 
        `SELECT * FROM requests
         WHERE request_kind = ?
         ORDER BY created_at DESC LIMIT ?`,
        requestKind,
        safeLimit,
      )
      : this.#sql("request-read", 
        `SELECT * FROM requests ORDER BY created_at DESC LIMIT ?`,
        safeLimit,
      );
    const records: PendingRequestRecord[] = [];
    for (const row of cursor) {
      records.push(parseRequestRow(serverId, row));
    }
    return records;
  }

  async #waitForRequest(
    serverId: string,
    requestId: string,
    _timeoutMs: number,
  ): Promise<PendingRequestRecord | null> {
    return await this.#getRequest(serverId, requestId);
  }

  /**
   * Fast, non-blocking expiry for caller-side wait timeouts. Marks the request
   * expired, reclaims matching outbox rows, and mirrors Redis parity (update
   * rows are retained for the terminal retention window; others are purged).
   */
  async #expireRequest(
    serverId: string,
    requestId: string,
  ): Promise<PendingRequestRecord> {
    const finishedAt = nowIso();
    const existing = await this.#getRequest(serverId, requestId);

    if (existing && isTerminalStatus(existing.status)) {
      return existing;
    }

    if (!existing) {
      return {
        serverId,
        requestId,
        requestKind: "",
        status: "expired",
        createdAt: finishedAt,
        expiresAt: finishedAt,
        finishedAt,
      };
    }

    const requestKind = existing.requestKind;
    this.#ctx.storage.transactionSync(() => {
      this.#sql("expire-request", 
        `UPDATE requests SET status = 'expired', finished_at = ?, updated_at = ?
         WHERE request_id = ?`,
        finishedAt,
        finishedAt,
        requestId,
      );
      this.#reclaimTerminalOutbox(requestId);
    });

    const expiredRecord: PendingRequestRecord = {
      ...existing,
      status: "expired",
      finishedAt,
      expiresAt: finishedAt,
    };

    if (requestKind === "update") {
      await this.#projectUpdateExpired(serverId, requestId, finishedAt);
      await this.#scheduleNearestAlarm();
      return expiredRecord;
    }

    this.#sql("expire-request", 
      "DELETE FROM requests WHERE request_id = ?",
      requestId,
    );
    await this.#scheduleNearestAlarm();
    return expiredRecord;
  }

  async #clearUpdateStatus(
    serverId: string,
    opts?: ClearUpdateStatusOptions | null,
  ): Promise<{ cleared: number }> {
    const inFlightCursor = this.#sql("clear-update-status", 
      `SELECT request_id, status, created_at FROM requests
       WHERE request_kind = 'update'
       AND status NOT IN ('acked', 'done', 'failed', 'expired')`,
    );
    let cleared = 0;
    const staleRequestIds: string[] = [];
    for (const row of inFlightCursor) {
      const requestId = String(row.request_id ?? "");
      const createdAt = String(row.created_at ?? "");
      const stale = opts?.allowStale && this.#isStaleInFlightUpdate(
        createdAt,
        opts,
      );
      if (stale) {
        staleRequestIds.push(requestId);
        continue;
      }
      throw new Error("update in progress");
    }

    const finishedAt = nowIso();
    for (const requestId of staleRequestIds) {
      this.#sql("clear-update-status", 
        `UPDATE requests SET status = 'expired', finished_at = ?, updated_at = ?
         WHERE request_id = ?`,
        finishedAt,
        finishedAt,
        requestId,
      );
      this.#reclaimTerminalOutbox(requestId);
      await this.#projectUpdateExpired(serverId, requestId, finishedAt);
      cleared++;
    }

    const terminalCursor = this.#sql("clear-update-status", 
      `SELECT request_id FROM requests
       WHERE request_kind = 'update'
       AND status IN ('acked', 'done', 'failed', 'expired')`,
    );
    const requestIds: string[] = [];
    for (const row of terminalCursor) {
      requestIds.push(String(row.request_id ?? ""));
    }

    this.#ctx.storage.transactionSync(() => {
      for (const requestId of requestIds) {
        this.#reclaimTerminalOutbox(requestId);
        this.#sql("clear-update-status", 
          "DELETE FROM requests WHERE request_id = ?",
          requestId,
        );
      }
    });

    await this.#scheduleNearestAlarm();
    return { cleared: cleared + requestIds.length };
  }

  #isStaleInFlightUpdate(
    createdAt: string,
    opts: ClearUpdateStatusOptions,
  ): boolean {
    if (
      opts.targetCommit &&
      opts.currentCommit &&
      opts.currentCommit === opts.targetCommit
    ) {
      return true;
    }

    const queuedAt = opts.queuedAt ?? createdAt;
    if (queuedAt && opts.updateTtlMs) {
      const queuedMs = Date.parse(queuedAt);
      if (!Number.isNaN(queuedMs) && Date.now() - queuedMs >= opts.updateTtlMs) {
        return true;
      }
    }

    return false;
  }

  async #createRequestAndWait(
    serverId: string,
    outbound: DaemonOutboundEnvelope,
    timeoutMs: number,
  ): Promise<PendingRequestRecord> {
    const ttlSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    const record = await this.#enqueue(serverId, outbound, { ttlSeconds });
    await this.#scheduleNearestAlarm();
    return record;
  }

  async #attachDaemonSocket(
    serverId: string,
    meta: {
      keyId: string;
      remoteAddress?: string;
      connectedAt?: string;
    },
  ): Promise<{ connectionId: string; lease: DaemonCellLease }> {
    const connectionId = crypto.randomUUID();

    const existingHolder = this.#existingDaemonSocketHolder();
    if (existingHolder && existingHolder !== connectionId) {
      throw new Error(
        `daemon socket lease held by another connection (${existingHolder})`,
      );
    }

    const lease = this.#applyDaemonSocketAttach(serverId, connectionId, meta);
    return { connectionId, lease };
  }

  async #detachDaemonSocket(
    serverId: string,
    params: {
      connectionId: string;
      reason?: string;
      closedAt?: string;
    },
  ): Promise<void> {
    const closedAt = params.closedAt ?? nowIso();

    let isCurrentConnection = false;
    this.#ctx.storage.transactionSync(() => {
      this.#sql("cleanup",
        `DELETE FROM leases
         WHERE lease_name = ? AND holder = ?`,
        DAEMON_SOCKET_LEASE_NAME,
        params.connectionId,
      );
      isCurrentConnection = readSqlChanges(
        this.#sql("cleanup", "SELECT changes() AS c"),
      ) > 0;
      if (isCurrentConnection) {
        this.#sql("cleanup",
          `UPDATE cell SET last_seen_at = ?, updated_at = ?
           WHERE server_id = ?`,
          closedAt,
          closedAt,
          serverId,
        );
      }
    });

    if (isCurrentConnection) {
      this.#runtimeConnected = false;
      this.#trace("detach", {
        serverId,
        conn: params.connectionId,
        reason: params.reason,
      });
      await this.#scheduleNearestAlarm();
    }
  }

  /** Reserved for outbox in-flight ownership; no production caller today. */
  async #claimDeliveryLease(
    serverId: string,
    holder: string,
    ttlMs: number,
  ): Promise<DaemonCellLease | null> {
    this.#ensureServerId(serverId);
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    if (sqlCursorHasRow(this.#sql("lease", 
      "SELECT holder FROM leases WHERE lease_name = ?",
      DELIVERY_LEASE_NAME,
    ))) {
      this.#trace("lease-claim", { serverId, holder, ok: false });
      return null;
    }

    this.#sql("lease",
      `INSERT INTO leases (lease_name, holder, expires_at)
       VALUES (?, ?, ?)`,
      DELIVERY_LEASE_NAME,
      holder,
      expiresAt,
    );
    this.#trace("lease-claim", { serverId, holder, ok: true });
    return { holder, expiresAt };
  }

  async #renewDeliveryLease(
    _serverId: string,
    holder: string,
    ttlMs: number,
  ): Promise<DaemonCellLease | null> {
    const renewed = await this.#renewLease(
      DELIVERY_LEASE_NAME,
      holder,
      ttlMs,
    );
    this.#trace("lease-renew", { serverId: _serverId, holder, ok: renewed });
    if (!renewed) return null;
    return {
      holder,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    };
  }

  async #renewLease(
    leaseName: string,
    holder: string,
    ttlMs: number,
  ): Promise<boolean> {
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    this.#sql("lease",
      `UPDATE leases SET expires_at = ?
       WHERE lease_name = ? AND holder = ?`,
      expiresAt,
      leaseName,
      holder,
    );
    return readSqlChanges(this.#sql("lease", "SELECT changes() AS c")) > 0;
  }

  async #releaseDeliveryLease(
    serverId: string,
    holder: string,
  ): Promise<void> {
    this.#sql("lease",
      "DELETE FROM leases WHERE lease_name = ? AND holder = ?",
      DELIVERY_LEASE_NAME,
      holder,
    );
    const ok = readSqlChanges(this.#sql("lease", "SELECT changes() AS c")) > 0;
    this.#trace("lease-release", { serverId, holder, ok });
  }

  async #readOutboxBatch(
    _serverId: string,
    params: { consumer: string; count: number; blockMs?: number },
  ): Promise<DaemonOutboundEnvelope[]> {
    this.#requeueExpiredInflightOutbox();

    const now = nowIso();
    const envelopes: DaemonOutboundEnvelope[] = [];
    const claimedAt = nowIso();
    this.#ctx.storage.transactionSync(() => {
      const cursor = this.#sql("outbox-read", 
        `SELECT seq, payload_json, delivery_id FROM outbox
         WHERE status = 'queued' AND (retry_at IS NULL OR retry_at <= ?)
         ORDER BY seq ASC LIMIT ?`,
        now,
        params.count,
      );
      for (const row of cursor) {
        const payload = row.payload_json ? String(row.payload_json) : null;
        if (!payload) continue;
        try {
          envelopes.push(JSON.parse(payload) as DaemonOutboundEnvelope);
        } catch {
          continue;
        }
        this.#sql("outbox-read", 
          `UPDATE outbox SET status = 'inflight', sent_at = ? WHERE seq = ?`,
          claimedAt,
          row.seq,
        );
      }
    });
    this.#trace("outbox-read", {
      serverId: _serverId,
      consumer: params.consumer,
      count: envelopes.length,
    });
    return envelopes;
  }

  async #ackOutbox(
    serverId: string,
    deliveryIds: OutboxDeliveryId[],
  ): Promise<void> {
    for (const deliveryId of deliveryIds) {
      this.#sql("outbox-ack", 
        "DELETE FROM outbox WHERE delivery_id = ?",
        deliveryId,
      );
    }
    this.#trace("outbox-ack", { serverId, count: deliveryIds.length });
    await this.#scheduleNearestAlarm();
  }
}
