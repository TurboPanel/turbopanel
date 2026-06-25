import type { DerivedSecretsConfig } from "../../client/authn/secrets.ts";
import {
  deriveSecretsConfig,
  parseSecretsEnv,
} from "../../client/authn/secrets.ts";
import { createWorkersDb, type Db } from "../../db.ts";
import { DAEMON_CHALLENGE_TTL_MS } from "../authn/challenge.ts";
import { verifyDaemonJwt } from "../authn/daemon-jwt.ts";
import type {
  DaemonCellLease,
  DaemonCellSnapshot,
  MonitorAlertRow,
  MonitorEventRow,
  MonitorInstanceRow,
  MonitorMetricRow,
  MonitorResourceRow,
  PendingRequestRecord,
  PendingRequestStatus,
} from "./contracts.ts";
import type {
  MonitorEvent,
  MonitorInstanceSummary,
  MonitorResourceKind,
  MonitorResourceState,
  MonitorResourceStatus,
} from "./monitor-contracts.ts";
import {
  evaluateFullSyncSequence,
  evaluateMonitorSequence,
  MONITOR_ALERT_COOLDOWN_MS,
  MONITOR_OFFLINE_GRACE_MS,
  normalizeMonitorMetricBucket,
} from "./monitor-contracts.ts";
import type {
  DaemonInboundEnvelope,
  DaemonOutboundEnvelope,
  OutboxDeliveryId,
} from "./protocol.ts";
import {
  outboundEnvelopeToWireMessage,
  parseDaemonMessage,
  wireMessageToInboundEnvelope,
} from "./protocol.ts";
import { mergeSnapshotPresence } from "./snapshot-merge.ts";
import { onDaemonDisconnected, onMonitorMessageApplied } from "./control-plane-monitor.ts";
import { projectServerDaemon } from "./postgres-projection.ts";

const TERMINAL_STATUSES = new Set<PendingRequestStatus>([
  "acked",
  "done",
  "failed",
  "expired",
]);

const DAEMON_SOCKET_LEASE_MS = 45_000;
const OUTBOX_INFLIGHT_LEASE_MS = 30_000;
const DELIVERY_LEASE_NAME = "delivery";
const DAEMON_SOCKET_LEASE_NAME = "daemon-socket";
const OUTBOX_PUMP_ALARM_MS = 2_000;
const MONITOR_EVENT_RETAIN = 500;
const MONITOR_ALERT_RESOLVED_RETAIN = 100;
const MONITOR_METRIC_RETAIN_HOURS = 72;
const MONITOR_ALERT_RESOLVED_RETAIN_DAYS = 7;

function nowIso(now = Date.now()): string {
  return new Date(now).toISOString();
}

function isTerminalStatus(status: PendingRequestStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function parseSnapshotJson(
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

function snapshotFromMetaRow(
  serverId: string,
  row: Record<string, SqlStorageValue>,
): DaemonCellSnapshot {
  return {
    serverId,
    version: Number(row.snapshot_version ?? 0),
    updatedAt: String(row.updated_at ?? nowIso()),
    hostname: row.hostname ? String(row.hostname) : undefined,
    machineId: row.machine_id ? String(row.machine_id) : undefined,
    remoteAddress: row.remote_address ? String(row.remote_address) : undefined,
    sessionId: row.session_id ? String(row.session_id) : undefined,
    keyId: row.key_id ? String(row.key_id) : undefined,
    connected: Number(row.connected ?? 0) === 1,
    connectedAt: row.connected_at ? String(row.connected_at) : undefined,
    lastInboundAt: row.last_inbound_at
      ? String(row.last_inbound_at)
      : undefined,
    lastOutboundAt: row.last_outbound_at
      ? String(row.last_outbound_at)
      : undefined,
    lastHeartbeatAt: row.last_heartbeat_at
      ? String(row.last_heartbeat_at)
      : undefined,
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

export class DaemonCellObject {
  readonly #ctx: DurableObjectState;
  readonly #env: CloudflareBindings;
  #schemaReady = false;
  #daemonJwtSecrets: DerivedSecretsConfig | null = null;
  #daemonJwtSecretsPromise: Promise<DerivedSecretsConfig> | null = null;
  #projectionDb: Db | null = null;

  constructor(ctx: DurableObjectState, env: CloudflareBindings) {
    this.#ctx = ctx;
    this.#env = env;
  }

  async #getDaemonJwtSecrets(): Promise<DerivedSecretsConfig> {
    if (this.#daemonJwtSecrets) return this.#daemonJwtSecrets;
    if (!this.#daemonJwtSecretsPromise) {
      this.#daemonJwtSecretsPromise = (async () => {
        const secretsConfig = parseSecretsEnv(
          this.#env.TURBOPANEL_SECRET,
          this.#env.TURBOPANEL_SECRETS,
          "workers",
        );
        const derived = await deriveSecretsConfig(
          secretsConfig,
          "daemon-jwt-signing",
        );
        this.#daemonJwtSecrets = derived;
        return derived;
      })();
    }
    return await this.#daemonJwtSecretsPromise;
  }

  #ensureSchema(): void {
    if (this.#schemaReady) return;
    this.#ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS cell_meta (
        server_id TEXT PRIMARY KEY,
        connected INTEGER DEFAULT 0,
        connection_id TEXT,
        session_id TEXT,
        key_id TEXT,
        hostname TEXT,
        machine_id TEXT,
        remote_address TEXT,
        connected_at TEXT,
        last_inbound_at TEXT,
        last_outbound_at TEXT,
        last_heartbeat_at TEXT,
        snapshot_version INTEGER DEFAULT 0,
        location_hint TEXT,
        generation INTEGER DEFAULT 1,
        updated_at TEXT
      )
    `);
    this.#ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS snapshot (
        server_id TEXT PRIMARY KEY,
        version INTEGER,
        snapshot_json TEXT,
        updated_at TEXT
      )
    `);
    this.#ctx.storage.sql.exec(`
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
        acked_at TEXT
      )
    `);
    this.#ctx.storage.sql.exec(`
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
        sent_at TEXT
      )
    `);
    this.#ensureRequestsSchema();
    this.#ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS event_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT,
        payload_json TEXT,
        created_at TEXT,
        expires_at TEXT
      )
    `);
    this.#ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS leases (
        lease_name TEXT PRIMARY KEY,
        holder TEXT,
        token TEXT,
        expires_at TEXT
      )
    `);
    this.#ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS connections (
        connection_id TEXT PRIMARY KEY,
        session_id TEXT,
        key_id TEXT,
        connected_at TEXT,
        closed_at TEXT,
        remote_address TEXT,
        reason TEXT
      )
    `);
    this.#ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS challenges (
        challenge_id TEXT PRIMARY KEY,
        challenge_type TEXT,
        server_id TEXT,
        key_id TEXT,
        nonce TEXT,
        at TEXT,
        issued_at_ms INTEGER,
        expires_at TEXT
      )
    `);
    this.#ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS monitor_instance (
        server_id TEXT PRIMARY KEY,
        sequence INTEGER,
        at TEXT,
        instance_json TEXT,
        updated_at TEXT
      )
    `);
    this.#ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS monitor_resource (
        resource_key TEXT PRIMARY KEY,
        server_id TEXT,
        kind TEXT,
        status TEXT,
        state_json TEXT,
        updated_at TEXT
      )
    `);
    this.#ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS monitor_metric_minute (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id TEXT,
        bucket_at TEXT,
        cpu REAL,
        memory REAL,
        disk REAL,
        load REAL,
        created_at TEXT
      )
    `);
    this.#ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS monitor_event (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id TEXT,
        resource_key TEXT,
        kind TEXT,
        from_status TEXT,
        to_status TEXT,
        reason TEXT,
        at TEXT,
        created_at TEXT
      )
    `);
    this.#ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS monitor_alert (
        resource_key TEXT PRIMARY KEY,
        server_id TEXT,
        status TEXT,
        opened_at TEXT,
        last_notified_at TEXT,
        last_delivered_at TEXT,
        cooldown_until TEXT,
        resolved_at TEXT
      )
    `);
    this.#ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS monitor_deadline (
        deadline_name TEXT PRIMARY KEY,
        server_id TEXT,
        due_at TEXT,
        kind TEXT,
        payload_json TEXT
      )
    `);
    this.#ensureMonitorAlertSchema();
    this.#schemaReady = true;
  }

  #ensureRequestsSchema(): void {
    const info = this.#ctx.storage.sql.exec("PRAGMA table_info(requests)");
    let hasCommandText = false;
    for (const row of info) {
      if (String(row.name) === "command_text") {
        hasCommandText = true;
        break;
      }
    }
    if (!hasCommandText) {
      this.#ctx.storage.sql.exec(
        "ALTER TABLE requests ADD COLUMN command_text TEXT",
      );
    }
  }

  #ensureMonitorAlertSchema(): void {
    const info = this.#ctx.storage.sql.exec("PRAGMA table_info(monitor_alert)");
    let hasLastDeliveredAt = false;
    for (const row of info) {
      if (String(row.name) === "last_delivered_at") {
        hasLastDeliveredAt = true;
        break;
      }
    }
    if (!hasLastDeliveredAt) {
      this.#ctx.storage.sql.exec(
        "ALTER TABLE monitor_alert ADD COLUMN last_delivered_at TEXT",
      );
    }
  }

  #resolveServerId(request: Request): string | null {
    const header = request.headers.get("X-Turbopanel-Cell-Server-Id")?.trim();
    if (header) return header;
    const cursor = this.#ctx.storage.sql.exec(
      "SELECT server_id FROM cell_meta LIMIT 1",
    );
    for (const row of cursor) {
      const id = row.server_id;
      if (id) return String(id);
    }
    return null;
  }

  #ensureServerId(serverId: string): void {
    this.#ctx.storage.sql.exec(
      `INSERT INTO cell_meta (server_id, connected, snapshot_version, generation, updated_at)
       VALUES (?, 0, 0, 1, ?)
       ON CONFLICT(server_id) DO NOTHING`,
      serverId,
      nowIso(),
    );
  }

  async fetch(request: Request): Promise<Response> {
    this.#ensureSchema();

    if (request.headers.get("Upgrade") === "websocket") {
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
    const cursor = this.#ctx.storage.sql.exec(
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
      this.#ctx.storage.sql.exec(
        `DELETE FROM leases
         WHERE lease_name = ? AND holder = ?`,
        DAEMON_SOCKET_LEASE_NAME,
        connectionId,
      );
      const metaCursor = this.#ctx.storage.sql.exec(
        "SELECT connection_id FROM cell_meta WHERE server_id = ?",
        serverId,
      );
      for (const row of metaCursor) {
        if (String(row.connection_id) === connectionId) {
          this.#ctx.storage.sql.exec(
            "UPDATE cell_meta SET connected = 0, updated_at = ? WHERE server_id = ?",
            closedAt,
            serverId,
          );
        }
      }
      this.#ctx.storage.sql.exec(
        `UPDATE connections SET closed_at = ?, reason = ?
         WHERE connection_id = ?`,
        closedAt,
        "replaced by new connection",
        connectionId,
      );
    });
    this.#appendEventInternal("disconnected", {
      connectionId,
      reason: "replaced by new connection",
    });
  }

  #applyDaemonSocketAttach(
    serverId: string,
    connectionId: string,
    meta: {
      sessionId?: string;
      keyId: string;
      hostname?: string;
      machineId?: string;
      remoteAddress?: string;
      connectedAt?: string;
    },
  ): DaemonCellLease {
    const connectedAt = meta.connectedAt ?? nowIso();
    const sessionId = meta.sessionId ?? "";
    const leaseExpiresAt = new Date(Date.now() + DAEMON_SOCKET_LEASE_MS)
      .toISOString();

    this.#ctx.storage.transactionSync(() => {
      this.#ensureServerId(serverId);
      this.#ctx.storage.sql.exec(
        `INSERT INTO cell_meta (
          server_id, connected, connection_id, session_id, key_id,
          hostname, machine_id, remote_address, connected_at,
          snapshot_version, generation, updated_at
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?)
        ON CONFLICT(server_id) DO UPDATE SET
          connected = 1,
          connection_id = excluded.connection_id,
          session_id = excluded.session_id,
          key_id = excluded.key_id,
          hostname = excluded.hostname,
          machine_id = excluded.machine_id,
          remote_address = excluded.remote_address,
          connected_at = excluded.connected_at,
          updated_at = excluded.updated_at`,
        serverId,
        connectionId,
        sessionId,
        meta.keyId,
        meta.hostname ?? "",
        meta.machineId ?? "",
        meta.remoteAddress ?? "",
        connectedAt,
        connectedAt,
      );
      this.#ctx.storage.sql.exec(
        `INSERT INTO connections (
          connection_id, session_id, key_id, connected_at, remote_address
        ) VALUES (?, ?, ?, ?, ?)`,
        connectionId,
        sessionId,
        meta.keyId,
        connectedAt,
        meta.remoteAddress ?? "",
      );
      this.#ctx.storage.sql.exec(
        `INSERT INTO leases (lease_name, holder, token, expires_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(lease_name) DO UPDATE SET
           holder = excluded.holder,
           token = excluded.token,
           expires_at = excluded.expires_at`,
        DAEMON_SOCKET_LEASE_NAME,
        connectionId,
        connectionId,
        leaseExpiresAt,
      );
    });

    this.#appendEventInternal("connected", { connectionId });

    this.#resetMonitorSequenceForReconnect(serverId);

    void this.#projectOnline(serverId, meta, connectedAt);

    return {
      holder: connectionId,
      token: connectionId,
      expiresAt: leaseExpiresAt,
    };
  }

  async #scheduleOfflineDeadline(
    serverId: string,
    now = Date.now(),
  ): Promise<void> {
    const dueAt = nowIso(now + MONITOR_OFFLINE_GRACE_MS);
    this.#ctx.storage.sql.exec(
      `INSERT INTO monitor_deadline (deadline_name, server_id, due_at, kind, payload_json)
       VALUES ('offline', ?, ?, 'offline', NULL)
       ON CONFLICT(deadline_name) DO UPDATE SET
         server_id = excluded.server_id,
         due_at = excluded.due_at,
         kind = excluded.kind`,
      serverId,
      dueAt,
    );
    await this.#scheduleNearestAlarm();
  }

  async #cancelOfflineDeadline(serverId: string): Promise<void> {
    this.#ctx.storage.sql.exec(
      "DELETE FROM monitor_deadline WHERE deadline_name = 'offline' AND server_id = ?",
      serverId,
    );
    await this.#scheduleNearestAlarm();
  }

  async #scheduleNearestAlarm(): Promise<void> {
    const candidates: number[] = [];
    const cursor = this.#ctx.storage.sql.exec(
      "SELECT MIN(due_at) AS min_due FROM monitor_deadline",
    );
    for (const row of cursor) {
      if (row.min_due) {
        const ms = Date.parse(String(row.min_due));
        if (!Number.isNaN(ms)) candidates.push(ms);
      }
    }
    if (this.#hasDeliverableOutbox() && this.#ctx.getWebSockets().length > 0) {
      candidates.push(Date.now() + OUTBOX_PUMP_ALARM_MS);
    }
    if (candidates.length === 0) {
      await this.#ctx.storage.deleteAlarm();
      return;
    }
    await this.#ctx.storage.setAlarm(Math.min(...candidates));
  }

  #hasDeliverableOutbox(): boolean {
    const cursor = this.#ctx.storage.sql.exec(
      `SELECT seq FROM outbox WHERE status IN ('queued', 'inflight') LIMIT 1`,
    );
    for (const _ of cursor) return true;
    return false;
  }

  #requeueExpiredInflightOutbox(nowMs = Date.now()): void {
    const cutoff = nowIso(nowMs - OUTBOX_INFLIGHT_LEASE_MS);
    this.#ctx.storage.sql.exec(
      `UPDATE outbox SET status = 'queued', sent_at = NULL
       WHERE status = 'inflight' AND sent_at IS NOT NULL AND sent_at <= ?`,
      cutoff,
    );
  }

  #requeueOutbox(deliveryId: string): void {
    this.#ctx.storage.sql.exec(
      `UPDATE outbox SET status = 'queued', sent_at = NULL WHERE delivery_id = ?`,
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

    let delivered = false;
    for (const ws of sockets) {
      const attachment = ws.deserializeAttachment() as {
        connectionId: string;
        serverId: string;
      } | null;
      if (!attachment || attachment.serverId !== serverId) continue;

      for (const envelope of batch) {
        try {
          const wireMsg = outboundEnvelopeToWireMessage(envelope);
          ws.send(JSON.stringify(wireMsg));
          await this.#markSent(
            serverId,
            envelope.deliveryId,
            attachment.connectionId,
          );
          await this.#ackOutbox(serverId, [envelope.deliveryId]);
          delivered = true;
        } catch {
          this.#requeueOutbox(envelope.deliveryId);
        }
      }
    }

    if (delivered) {
      const at = nowIso();
      this.#ctx.storage.sql.exec(
        "UPDATE cell_meta SET last_outbound_at = ?, updated_at = ? WHERE server_id = ?",
        at,
        at,
        serverId,
      );
    }

    if (this.#hasDeliverableOutbox()) {
      await this.#scheduleOutboxRetryIfNeeded();
    }
  }

  async #handleWebSocketUpgrade(request: Request): Promise<Response> {
    const authHeader = request.headers.get("Authorization") ?? "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : "";
    if (!token) return new Response("Unauthorized", { status: 401 });

    const secrets = await this.#getDaemonJwtSecrets();
    const payload = await verifyDaemonJwt(token, secrets);
    if (!payload) return new Response("Unauthorized", { status: 401 });

    const serverId = payload.sub;
    const sessionId = payload.jti;
    const keyId = payload.kid;

    const connectionId = crypto.randomUUID();
    const connectedAt = nowIso();
    const remoteAddress = request.headers.get("X-Real-IP") ?? "";

    const existingHolder = this.#existingDaemonSocketHolder();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.#ctx.acceptWebSocket(server);

    if (existingHolder && existingHolder !== connectionId) {
      this.#forceDetachDaemonSocket(serverId, existingHolder);
      for (const ws of this.#ctx.getWebSockets()) {
        if (ws !== server) {
          ws.close(4000, "replaced by new connection");
        }
      }
    }

    server.serializeAttachment({ connectionId, serverId, sessionId, keyId });

    this.#applyDaemonSocketAttach(serverId, connectionId, {
      sessionId,
      keyId,
      remoteAddress,
      connectedAt,
    });

    await this.#cancelOfflineDeadline(serverId);

    void this.#pumpOutboxToDaemonSockets(serverId);
    await this.#scheduleOutboxRetryIfNeeded();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    this.#ensureSchema();
    const attachment = ws.deserializeAttachment() as {
      connectionId: string;
      serverId: string;
      sessionId: string;
      keyId: string;
    } | null;
    if (!attachment) return;

    const raw = typeof message === "string"
      ? message
      : new TextDecoder().decode(message);

    const at = nowIso();
    this.#ctx.storage.sql.exec(
      "UPDATE cell_meta SET last_inbound_at = ?, updated_at = ? WHERE server_id = ?",
      at,
      at,
      attachment.serverId,
    );

    const parsed = parseDaemonMessage(raw);
    if (!parsed) return;

    if (parsed.type === "ping") {
      ws.send(JSON.stringify({
        type: "pong",
        id: parsed.id,
        at: nowIso(),
      }));
      await this.#heartbeat(attachment.serverId, {
        connectionId: attachment.connectionId,
        at,
      });
      return;
    }

    if (parsed.type === "pong") {
      await this.#handleInboundMessage(attachment.serverId, parsed);
      await this.#heartbeat(attachment.serverId, {
        connectionId: attachment.connectionId,
        at,
      });
      return;
    }

    const monitorInbound = wireMessageToInboundEnvelope(parsed);
    if (
      monitorInbound?.kind === "monitor-sync" ||
      monitorInbound?.kind === "monitor-heartbeat" ||
      monitorInbound?.kind === "monitor-transition"
    ) {
      let acceptedSequence = 0;
      let resyncNeeded = false;
      if (monitorInbound.kind === "monitor-sync") {
        const result = await this.#applyMonitorSync(
          attachment.serverId,
          monitorInbound,
        );
        acceptedSequence = result.acceptedSequence;
        resyncNeeded = result.resyncNeeded;
      } else if (monitorInbound.kind === "monitor-heartbeat") {
        const result = await this.#applyMonitorHeartbeat(
          attachment.serverId,
          monitorInbound,
        );
        acceptedSequence = result.acceptedSequence;
        resyncNeeded = result.resyncNeeded;
      } else {
        const result = await this.#applyMonitorTransition(
          attachment.serverId,
          monitorInbound,
        );
        acceptedSequence = result.acceptedSequence;
        resyncNeeded = result.resyncNeeded;
      }

      this.#ctx.storage.sql.exec(
        "UPDATE cell_meta SET last_heartbeat_at = ?, updated_at = ? WHERE server_id = ?",
        at,
        at,
        attachment.serverId,
      );
      await this.#scheduleOfflineDeadline(attachment.serverId);

      ws.send(JSON.stringify({
        type: "monitor.ack",
        from: "instance",
        serverId: attachment.serverId,
        at: nowIso(),
        acceptedSequence,
        resyncNeeded: resyncNeeded || undefined,
      }));

      if (!resyncNeeded) {
        void this.#projectMonitorMessage(
          attachment.serverId,
          monitorInbound,
        );
      }
      return;
    }

    await this.#handleInboundMessage(attachment.serverId, parsed);
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
    const attachment = ws.deserializeAttachment() as {
      connectionId: string;
      serverId: string;
    } | null;
    if (!attachment) return;

    const closedAt = nowIso();
    const reasonText = reason || String(code);

    let isCurrentConnection = false;
    this.#ctx.storage.transactionSync(() => {
      const metaCursor = this.#ctx.storage.sql.exec(
        "SELECT connection_id FROM cell_meta WHERE server_id = ?",
        attachment.serverId,
      );
      for (const row of metaCursor) {
        isCurrentConnection =
          String(row.connection_id ?? "") === attachment.connectionId;
      }

      this.#ctx.storage.sql.exec(
        `UPDATE connections SET closed_at = ?, reason = ?
         WHERE connection_id = ?`,
        closedAt,
        reasonText,
        attachment.connectionId,
      );
      this.#ctx.storage.sql.exec(
        `DELETE FROM leases
         WHERE lease_name = ? AND holder = ? AND token = ?`,
        DAEMON_SOCKET_LEASE_NAME,
        attachment.connectionId,
        attachment.connectionId,
      );

      if (isCurrentConnection) {
        this.#ctx.storage.sql.exec(
          "UPDATE cell_meta SET connected = 0, updated_at = ? WHERE server_id = ?",
          closedAt,
          attachment.serverId,
        );
      }
    });

    this.#appendEventInternal("disconnected", {
      connectionId: attachment.connectionId,
      reason: reasonText,
    });

    if (isCurrentConnection) {
      await this.#scheduleOfflineDeadline(attachment.serverId);
      void this.#projectDisconnected(attachment.serverId);
    }
  }

  async alarm(): Promise<void> {
    this.#ensureSchema();
    const nowMs = Date.now();
    const now = nowIso(nowMs);

    this.#ctx.storage.sql.exec(
      "DELETE FROM challenges WHERE expires_at <= ?",
      now,
    );
    this.#ctx.storage.sql.exec(
      "DELETE FROM requests WHERE expires_at <= ?",
      now,
    );
    this.#ctx.storage.sql.exec(`
      DELETE FROM event_log
      WHERE seq NOT IN (
        SELECT seq FROM event_log ORDER BY seq DESC LIMIT 500
      )
    `);
    this.#ctx.storage.sql.exec(`
      DELETE FROM outbox
      WHERE seq NOT IN (
        SELECT seq FROM outbox ORDER BY seq DESC LIMIT 1000
      )
    `);

    const serverId = this.#resolveServerId(new Request("https://do.internal/"));
    if (serverId) {
      this.#requeueExpiredInflightOutbox(nowMs);
      await this.#processDueMonitorDeadlines(serverId, now, nowMs);
      this.#pruneMonitorTables(nowMs);
      await this.#pumpOutboxToDaemonSockets(serverId);
    }

    await this.#scheduleNearestAlarm();
  }

  async #handleRpc(request: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    const method = request.method;

    if (path === "/rpc/snapshot" && method === "GET") {
      const serverId = this.#resolveServerId(request);
      if (!serverId) return errorResponse("server id unknown", 404);
      return jsonResponse(await this.#getSnapshot(serverId));
    }

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

      case "/rpc/event":
        if (method !== "POST") return errorResponse("method not allowed", 405);
        await this.#appendEvent(
          this.#requireServerId(request, body),
          String(body?.kind ?? ""),
          (body?.payload ?? {}) as Record<string, unknown>,
          body?.ttlSeconds as number | undefined,
        );
        return jsonResponse({ ok: true });

      case "/rpc/events":
        if (method !== "GET") return errorResponse("method not allowed", 405);
        return jsonResponse({
          events: await this.#listEvents(
            this.#resolveServerId(request),
            Number(url.searchParams.get("limit") ?? 50),
          ),
        });

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
              hostname?: string;
              machineId?: string;
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
            leaseToken: string;
            reason?: string;
            closedAt?: string;
          },
        );
        return jsonResponse({ ok: true });

      case "/rpc/heartbeat":
        await this.#heartbeat(
          this.#requireServerId(request, body),
          body?.params as {
            connectionId?: string;
            hostname?: string;
            at?: string;
          },
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
            String(body?.token ?? ""),
            Number(body?.ttlMs ?? 0),
          ),
        });

      case "/rpc/lease/release":
        await this.#releaseDeliveryLease(
          this.#requireServerId(request, body),
          String(body?.holder ?? ""),
          String(body?.token ?? ""),
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

      case "/rpc/prune":
        const offlineApplied = await this.#prune(body?.now as number | undefined);
        return jsonResponse({ ok: true, offlineApplied });

      case "/rpc/challenge/issue":
        return jsonResponse(await this.#issueChallenge(body));

      case "/rpc/challenge/consume":
        return jsonResponse({
          challenge: await this.#consumeChallenge(body),
        });

      case "/rpc/monitor/sync":
        if (method !== "POST") return errorResponse("method not allowed", 405);
        return jsonResponse(
          await this.#applyMonitorSync(
            this.#requireServerId(request, body),
            body?.msg as DaemonInboundEnvelope & { kind: "monitor-sync" },
          ),
        );

      case "/rpc/monitor/heartbeat":
        if (method !== "POST") return errorResponse("method not allowed", 405);
        return jsonResponse(
          await this.#applyMonitorHeartbeat(
            this.#requireServerId(request, body),
            body?.msg as DaemonInboundEnvelope & { kind: "monitor-heartbeat" },
          ),
        );

      case "/rpc/monitor/transition":
        if (method !== "POST") return errorResponse("method not allowed", 405);
        return jsonResponse(
          await this.#applyMonitorTransition(
            this.#requireServerId(request, body),
            body?.msg as DaemonInboundEnvelope & { kind: "monitor-transition" },
          ),
        );

      case "/rpc/monitor/instance":
        if (method !== "GET") return errorResponse("method not allowed", 405);
        return jsonResponse({
          instance: this.#getMonitorInstance(this.#resolveServerId(request)),
        });

      case "/rpc/monitor/resources":
        if (method !== "GET") return errorResponse("method not allowed", 405);
        return jsonResponse({
          resources: this.#listMonitorResources(this.#resolveServerId(request)),
        });

      case "/rpc/monitor/events":
        if (method !== "GET") return errorResponse("method not allowed", 405);
        return jsonResponse({
          events: this.#listMonitorEvents(
            this.#resolveServerId(request),
            Number(url.searchParams.get("limit") ?? 50),
          ),
        });

      case "/rpc/monitor/metrics":
        if (method !== "GET") return errorResponse("method not allowed", 405);
        return jsonResponse({
          metrics: this.#listMonitorMetrics(
            this.#resolveServerId(request),
            Number(url.searchParams.get("limit") ?? 50),
          ),
        });

      case "/rpc/monitor/alerts":
        if (method !== "GET") return errorResponse("method not allowed", 405);
        return jsonResponse({
          alerts: this.#listMonitorAlerts(this.#resolveServerId(request)),
        });

      case "/rpc/monitor/drain-candidates":
        if (method !== "POST") {
          return errorResponse("method not allowed", 405);
        }
        return jsonResponse({
          alerts: this.#drainNotificationCandidates(
            this.#requireServerId(request, body),
          ),
        });

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
    this.#ensureServerId(serverId);

    const snapCursor = this.#ctx.storage.sql.exec(
      "SELECT snapshot_json FROM snapshot WHERE server_id = ?",
      serverId,
    );
    let fromJson: DaemonCellSnapshot | null = null;
    for (const row of snapCursor) {
      fromJson = parseSnapshotJson(
        row.snapshot_json ? String(row.snapshot_json) : null,
        serverId,
      );
      if (fromJson) break;
    }

    const metaCursor = this.#ctx.storage.sql.exec(
      "SELECT * FROM cell_meta WHERE server_id = ?",
      serverId,
    );
    let fromMeta: DaemonCellSnapshot | null = null;
    for (const row of metaCursor) {
      fromMeta = snapshotFromMetaRow(serverId, row);
      break;
    }

    if (fromJson && fromMeta) {
      return mergeSnapshotPresence(fromJson, fromMeta);
    }
    if (fromJson) return fromJson;
    if (fromMeta) return fromMeta;

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
    const current = await this.#getSnapshot(serverId);
    const updated: DaemonCellSnapshot = {
      ...current,
      ...patch,
      serverId,
      version: current.version + 1,
      updatedAt: nowIso(),
    };

    this.#ctx.storage.transactionSync(() => {
      this.#ctx.storage.sql.exec(
        `INSERT INTO snapshot (server_id, version, snapshot_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(server_id) DO UPDATE SET
           version = excluded.version,
           snapshot_json = excluded.snapshot_json,
           updated_at = excluded.updated_at`,
        serverId,
        updated.version,
        JSON.stringify(updated),
        updated.updatedAt,
      );
      this.#ctx.storage.sql.exec(
        `UPDATE cell_meta SET snapshot_version = ?, updated_at = ? WHERE server_id = ?`,
        updated.version,
        updated.updatedAt,
        serverId,
      );
    });

    return updated;
  }

  #appendEventInternal(
    kind: string,
    payload: Record<string, unknown>,
    ttlSeconds?: number,
  ): void {
    const at = nowIso();
    const expiresAt = ttlSeconds != null
      ? nowIso(Date.now() + ttlSeconds * 1000)
      : null;
    this.#ctx.storage.sql.exec(
      `INSERT INTO event_log (kind, payload_json, created_at, expires_at)
       VALUES (?, ?, ?, ?)`,
      kind,
      JSON.stringify(payload),
      at,
      expiresAt,
    );
  }

  async #appendEvent(
    serverId: string,
    kind: string,
    payload: Record<string, unknown>,
    ttlSeconds?: number,
  ): Promise<void> {
    this.#ensureServerId(serverId);
    this.#appendEventInternal(kind, payload, ttlSeconds);
  }

  async #listEvents(
    serverId: string | null,
    limit: number,
  ): Promise<
    Array<{
      seq: string;
      kind: string;
      at: string;
      payload: Record<string, unknown>;
    }>
  > {
    if (!serverId) return [];
    const cursor = this.#ctx.storage.sql.exec(
      `SELECT seq, kind, payload_json, created_at
       FROM event_log ORDER BY seq DESC LIMIT ?`,
      limit,
    );
    const events: Array<{
      seq: string;
      kind: string;
      at: string;
      payload: Record<string, unknown>;
    }> = [];
    for (const row of cursor) {
      let payload: Record<string, unknown> = {};
      if (row.payload_json) {
        try {
          payload = JSON.parse(String(row.payload_json)) as Record<
            string,
            unknown
          >;
        } catch {
          payload = {};
        }
      }
      events.push({
        seq: String(row.seq),
        kind: String(row.kind ?? ""),
        at: String(row.created_at ?? ""),
        payload,
      });
    }
    return events.reverse();
  }

  async #enqueue(
    serverId: string,
    outbound: DaemonOutboundEnvelope,
    opts?: { ttlSeconds?: number },
  ): Promise<PendingRequestRecord> {
    const now = Date.now();
    const createdAt = outbound.at ?? nowIso(now);
    const ttlSeconds = opts?.ttlSeconds ?? 300;
    const expiresAt = nowIso(now + ttlSeconds * 1000);

    const existingCursor = this.#ctx.storage.sql.exec(
      "SELECT * FROM requests WHERE request_id = ?",
      outbound.requestId,
    );
    for (const row of existingCursor) {
      const dupCursor = this.#ctx.storage.sql.exec(
        "SELECT seq FROM outbox WHERE delivery_id = ?",
        outbound.deliveryId,
      );
      let exists = false;
      for (const _ of dupCursor) exists = true;
      if (exists) {
        return parseRequestRow(serverId, row);
      }

      this.#ctx.storage.transactionSync(() => {
        this.#ctx.storage.sql.exec(
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
        this.#ctx.storage.sql.exec(
          "UPDATE requests SET updated_at = ? WHERE request_id = ?",
          nowIso(),
          outbound.requestId,
        );
      });
      void this.#pumpOutboxToDaemonSockets(serverId);
      void this.#scheduleOutboxRetryIfNeeded();
      return parseRequestRow(serverId, row);
    }

    this.#ctx.storage.transactionSync(() => {
      this.#ctx.storage.sql.exec(
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
      this.#ctx.storage.sql.exec(
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

    const cursor = this.#ctx.storage.sql.exec(
      "SELECT * FROM requests WHERE request_id = ?",
      outbound.requestId,
    );
    for (const row of cursor) {
      void this.#pumpOutboxToDaemonSockets(serverId);
      void this.#scheduleOutboxRetryIfNeeded();
      return parseRequestRow(serverId, row);
    }

    void this.#pumpOutboxToDaemonSockets(serverId);
    void this.#scheduleOutboxRetryIfNeeded();
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
    this.#ctx.storage.transactionSync(() => {
      this.#ctx.storage.sql.exec(
        `UPDATE outbox SET status = 'sent', sent_at = ? WHERE delivery_id = ?`,
        at,
        deliveryId,
      );
      const cursor = this.#ctx.storage.sql.exec(
        "SELECT request_id FROM outbox WHERE delivery_id = ?",
        deliveryId,
      );
      for (const row of cursor) {
        this.#ctx.storage.sql.exec(
          `UPDATE requests SET status = 'sent', sent_at = ?, updated_at = ?
           WHERE request_id = ?`,
          at,
          at,
          String(row.request_id),
        );
      }
    });
    this.#ctx.storage.sql.exec(
      "UPDATE cell_meta SET last_outbound_at = ?, updated_at = ? WHERE server_id = ?",
      at,
      at,
      serverId,
    );
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

  async #handleInbound(
    serverId: string,
    inbound: DaemonInboundEnvelope,
  ): Promise<PendingRequestRecord | null> {
    const cursor = this.#ctx.storage.sql.exec(
      "SELECT * FROM requests WHERE request_id = ?",
      inbound.requestId,
    );
    let row: Record<string, SqlStorageValue> | null = null;
    for (const r of cursor) row = r;
    if (!row) return null;

    const existing = parseRequestRow(serverId, row);
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
        await this.#putSnapshot(serverId, {
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

    const finishedAt = inbound.at;
    this.#ctx.storage.sql.exec(
      `UPDATE requests SET status = ?, result_json = ?, error = ?,
       finished_at = ?, updated_at = ? WHERE request_id = ?`,
      status,
      result !== undefined ? JSON.stringify(result) : null,
      error ?? null,
      finishedAt,
      nowIso(),
      inbound.requestId,
    );

    if (inbound.kind !== "addresses-result") {
      this.#ctx.storage.sql.exec(
        "UPDATE cell_meta SET last_inbound_at = ?, updated_at = ? WHERE server_id = ?",
        inbound.at,
        nowIso(),
        serverId,
      );
    }

    this.#appendEventInternal("inbound", {
      kind: inbound.kind,
      requestId: inbound.requestId,
    });

    const updatedCursor = this.#ctx.storage.sql.exec(
      "SELECT * FROM requests WHERE request_id = ?",
      inbound.requestId,
    );
    for (const updated of updatedCursor) {
      return parseRequestRow(serverId, updated);
    }
    return existing;
  }

  async #getRequest(
    serverId: string | null,
    requestId: string,
  ): Promise<PendingRequestRecord | null> {
    if (!serverId || !requestId) return null;
    const cursor = this.#ctx.storage.sql.exec(
      "SELECT * FROM requests WHERE request_id = ?",
      requestId,
    );
    for (const row of cursor) {
      return parseRequestRow(serverId, row);
    }
    return null;
  }

  async #listRequests(
    serverId: string | null,
    limit: number,
    requestKind?: string,
  ): Promise<PendingRequestRecord[]> {
    if (!serverId) return [];
    const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 50;
    const cursor = requestKind
      ? this.#ctx.storage.sql.exec(
        `SELECT * FROM requests
         WHERE request_kind = ?
         ORDER BY created_at DESC LIMIT ?`,
        requestKind,
        safeLimit,
      )
      : this.#ctx.storage.sql.exec(
        `SELECT * FROM requests ORDER BY created_at DESC LIMIT ?`,
        safeLimit,
      );
    const records: PendingRequestRecord[] = [];
    for (const row of cursor) {
      records.push(parseRequestRow(serverId, row));
    }
    return records.reverse();
  }

  async #waitForRequest(
    serverId: string,
    requestId: string,
    timeoutMs: number,
  ): Promise<PendingRequestRecord | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const record = await this.#getRequest(serverId, requestId);
      if (record && isTerminalStatus(record.status)) return record;
      await scheduler.wait(250);
    }
    return null;
  }

  async #createRequestAndWait(
    serverId: string,
    outbound: DaemonOutboundEnvelope,
    timeoutMs: number,
  ): Promise<PendingRequestRecord> {
    await this.#enqueue(serverId, outbound);
    const result = await this.#waitForRequest(
      serverId,
      outbound.requestId,
      timeoutMs,
    );
    if (result) return result;

    const expiredAt = nowIso();
    this.#ctx.storage.sql.exec(
      `UPDATE requests SET status = 'expired', finished_at = ?, updated_at = ?
       WHERE request_id = ?`,
      expiredAt,
      expiredAt,
      outbound.requestId,
    );
    return {
      serverId,
      requestId: outbound.requestId,
      requestKind: outbound.kind,
      status: "expired",
      createdAt: outbound.at,
      expiresAt: expiredAt,
      finishedAt: expiredAt,
    };
  }

  async #attachDaemonSocket(
    serverId: string,
    meta: {
      keyId: string;
      hostname?: string;
      machineId?: string;
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
    await this.#cancelOfflineDeadline(serverId);

    return { connectionId, lease };
  }

  async #detachDaemonSocket(
    serverId: string,
    params: {
      connectionId: string;
      leaseToken: string;
      reason?: string;
      closedAt?: string;
    },
  ): Promise<void> {
    const closedAt = params.closedAt ?? nowIso();

    this.#ctx.storage.transactionSync(() => {
      this.#ctx.storage.sql.exec(
        `DELETE FROM leases
         WHERE lease_name = ? AND token = ?`,
        DAEMON_SOCKET_LEASE_NAME,
        params.leaseToken,
      );
      const metaCursor = this.#ctx.storage.sql.exec(
        "SELECT connection_id FROM cell_meta WHERE server_id = ?",
        serverId,
      );
      for (const row of metaCursor) {
        if (String(row.connection_id) === params.connectionId) {
          this.#ctx.storage.sql.exec(
            "UPDATE cell_meta SET connected = 0, updated_at = ? WHERE server_id = ?",
            closedAt,
            serverId,
          );
        }
      }
      this.#ctx.storage.sql.exec(
        `UPDATE connections SET closed_at = ?, reason = ?
         WHERE connection_id = ?`,
        closedAt,
        params.reason ?? "",
        params.connectionId,
      );
    });

    this.#appendEventInternal("disconnected", {
      connectionId: params.connectionId,
      reason: params.reason ?? "",
    });
  }

  async #heartbeat(
    serverId: string,
    params: {
      connectionId?: string;
      hostname?: string;
      at?: string;
    },
  ): Promise<void> {
    const at = params.at ?? nowIso();
    const metaCursor = this.#ctx.storage.sql.exec(
      "SELECT connection_id FROM cell_meta WHERE server_id = ?",
      serverId,
    );
    let connectionId = params.connectionId;
    for (const row of metaCursor) {
      if (!connectionId) connectionId = String(row.connection_id ?? "");
    }
    if (!connectionId) return;

    const renewed = await this.#renewLease(
      DAEMON_SOCKET_LEASE_NAME,
      connectionId,
      connectionId,
      DAEMON_SOCKET_LEASE_MS,
    );
    if (!renewed) return;

    const fields: Array<string | null> = [at, at, serverId];
    let sql = "UPDATE cell_meta SET last_heartbeat_at = ?, updated_at = ?";
    if (params.hostname) {
      sql += ", hostname = ?";
      fields.splice(2, 0, params.hostname);
    }
    sql += " WHERE server_id = ?";
    this.#ctx.storage.sql.exec(sql, ...fields);
  }

  async #claimDeliveryLease(
    serverId: string,
    holder: string,
    ttlMs: number,
  ): Promise<DaemonCellLease | null> {
    this.#ensureServerId(serverId);
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const existing = this.#ctx.storage.sql.exec(
      "SELECT holder FROM leases WHERE lease_name = ?",
      DELIVERY_LEASE_NAME,
    );
    for (const _ of existing) return null;

    this.#ctx.storage.sql.exec(
      `INSERT INTO leases (lease_name, holder, token, expires_at)
       VALUES (?, ?, ?, ?)`,
      DELIVERY_LEASE_NAME,
      holder,
      holder,
      expiresAt,
    );
    return { holder, token: holder, expiresAt };
  }

  async #renewDeliveryLease(
    _serverId: string,
    holder: string,
    token: string,
    ttlMs: number,
  ): Promise<DaemonCellLease | null> {
    const renewed = await this.#renewLease(
      DELIVERY_LEASE_NAME,
      token,
      holder,
      ttlMs,
    );
    if (!renewed) return null;
    return {
      holder,
      token: holder,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    };
  }

  async #renewLease(
    leaseName: string,
    token: string,
    holder: string,
    ttlMs: number,
  ): Promise<boolean> {
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    this.#ctx.storage.sql.exec(
      `UPDATE leases SET expires_at = ?, holder = ?
       WHERE lease_name = ? AND token = ?`,
      expiresAt,
      holder,
      leaseName,
      token,
    );
    const changesCursor = this.#ctx.storage.sql.exec("SELECT changes() AS c");
    for (const row of changesCursor) {
      return Number(row.c) > 0;
    }
    return false;
  }

  async #releaseDeliveryLease(
    _serverId: string,
    _holder: string,
    token: string,
  ): Promise<void> {
    this.#ctx.storage.sql.exec(
      "DELETE FROM leases WHERE lease_name = ? AND token = ?",
      DELIVERY_LEASE_NAME,
      token,
    );
  }

  async #readOutboxBatch(
    _serverId: string,
    params: { consumer: string; count: number; blockMs?: number },
  ): Promise<DaemonOutboundEnvelope[]> {
    if (params.blockMs && params.blockMs > 0) {
      await scheduler.wait(params.blockMs);
    }

    this.#requeueExpiredInflightOutbox();

    const envelopes: DaemonOutboundEnvelope[] = [];
    const claimedAt = nowIso();
    this.#ctx.storage.transactionSync(() => {
      const cursor = this.#ctx.storage.sql.exec(
        `SELECT seq, payload_json, delivery_id FROM outbox
         WHERE status = 'queued' ORDER BY seq ASC LIMIT ?`,
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
        this.#ctx.storage.sql.exec(
          `UPDATE outbox SET status = 'inflight', sent_at = ? WHERE seq = ?`,
          claimedAt,
          row.seq,
        );
      }
    });
    return envelopes;
  }

  async #ackOutbox(
    _serverId: string,
    deliveryIds: OutboxDeliveryId[],
  ): Promise<void> {
    const at = nowIso();
    for (const deliveryId of deliveryIds) {
      this.#ctx.storage.sql.exec(
        `UPDATE outbox SET status = 'acked', acked_at = ? WHERE delivery_id = ?`,
        at,
        deliveryId,
      );
    }
  }

  async #prune(now = Date.now()): Promise<boolean> {
    const nowStr = nowIso(now);
    this.#ctx.storage.sql.exec(
      "DELETE FROM challenges WHERE expires_at <= ?",
      nowStr,
    );
    this.#ctx.storage.sql.exec(
      "DELETE FROM requests WHERE expires_at <= ?",
      nowStr,
    );
    this.#ctx.storage.sql.exec(`
      DELETE FROM event_log
      WHERE seq NOT IN (
        SELECT seq FROM event_log ORDER BY seq DESC LIMIT 500
      )
    `);
    this.#ctx.storage.sql.exec(`
      DELETE FROM outbox
      WHERE seq NOT IN (
        SELECT seq FROM outbox ORDER BY seq DESC LIMIT 1000
      )
    `);

    const serverId = this.#resolveServerId(new Request("https://do.internal/"));
    if (!serverId) return false;
    const offlineApplied = await this.#processDueMonitorDeadlines(
      serverId,
      nowStr,
      now,
    );
    this.#pruneMonitorTables(now);
    return offlineApplied;
  }

  async #issueChallenge(
    body: Record<string, unknown> | null,
  ): Promise<{ id: string; nonce: string; at: string }> {
    const ttlMs = typeof body?.ttlMs === "number" && body.ttlMs > 0
      ? body.ttlMs
      : DAEMON_CHALLENGE_TTL_MS;
    const challengeId = crypto.randomUUID();
    const nonce = crypto.randomUUID();
    const at = nowIso();
    const issuedAtMs = Date.now();
    const expiresAt = nowIso(issuedAtMs + ttlMs);
    const serverId = typeof body?.serverId === "string" ? body.serverId : "";
    const keyId = typeof body?.keyId === "string" ? body.keyId : "";

    this.#ctx.storage.sql.exec(
      `INSERT INTO challenges (
        challenge_id, challenge_type, server_id, key_id, nonce, at,
        issued_at_ms, expires_at
      ) VALUES (?, 'daemon', ?, ?, ?, ?, ?, ?)`,
      challengeId,
      serverId,
      keyId,
      nonce,
      at,
      issuedAtMs,
      expiresAt,
    );

    return { id: challengeId, nonce, at };
  }

  async #consumeChallenge(
    body: Record<string, unknown> | null,
  ): Promise<{ id: string; nonce: string; at: string } | null> {
    const challengeId = String(body?.challengeId ?? "");
    if (!challengeId) return null;
    const serverId = typeof body?.serverId === "string" ? body.serverId : "";
    const keyId = typeof body?.keyId === "string" ? body.keyId : "";
    const ttlMs = typeof body?.ttlMs === "number" && body.ttlMs > 0
      ? body.ttlMs
      : DAEMON_CHALLENGE_TTL_MS;

    const cursor = this.#ctx.storage.sql.exec(
      "SELECT * FROM challenges WHERE challenge_id = ?",
      challengeId,
    );
    let row: Record<string, SqlStorageValue> | null = null;
    for (const r of cursor) row = r;
    if (!row) return null;

    const storedServerId = row.server_id ? String(row.server_id) : "";
    const storedKeyId = row.key_id ? String(row.key_id) : "";
    if (storedServerId && storedServerId !== serverId) return null;
    if (storedKeyId && storedKeyId !== keyId) return null;

    const issuedAtMs = Number(row.issued_at_ms ?? 0);
    const expiresAt = row.expires_at ? String(row.expires_at) : "";
    const expiredByStoredAt = expiresAt && Date.parse(expiresAt) <= Date.now();
    const expiredByIssuedAt = issuedAtMs > 0 &&
      issuedAtMs + ttlMs <= Date.now();
    if (expiredByStoredAt || expiredByIssuedAt) {
      this.#ctx.storage.sql.exec(
        "DELETE FROM challenges WHERE challenge_id = ?",
        challengeId,
      );
      return null;
    }

    this.#ctx.storage.sql.exec(
      "DELETE FROM challenges WHERE challenge_id = ?",
      challengeId,
    );

    return {
      id: challengeId,
      nonce: String(row.nonce),
      at: String(row.at),
    };
  }

  #metricValuesFromInstance(instance: MonitorInstanceSummary): {
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

  #readMonitorSequence(serverId: string): number {
    const cursor = this.#ctx.storage.sql.exec(
      "SELECT sequence FROM monitor_instance WHERE server_id = ?",
      serverId,
    );
    for (const row of cursor) {
      return Number(row.sequence ?? 0);
    }
    return 0;
  }

  #resetMonitorSequence(serverId: string): void {
    this.#ctx.storage.sql.exec(
      "UPDATE monitor_instance SET sequence = 0 WHERE server_id = ?",
      serverId,
    );
  }

  #resetMonitorSequenceForReconnect(serverId: string): void {
    this.#resetMonitorSequence(serverId);
    this.#ctx.storage.sql.exec(
      "DELETE FROM monitor_deadline WHERE deadline_name = 'offline' AND server_id = ?",
      serverId,
    );
  }

  #persistMonitorSequence(serverId: string, sequence: number): void {
    const updatedAt = nowIso();
    const cursor = this.#ctx.storage.sql.exec(
      "SELECT server_id FROM monitor_instance WHERE server_id = ?",
      serverId,
    );
    let exists = false;
    for (const _ of cursor) exists = true;

    if (exists) {
      this.#ctx.storage.sql.exec(
        "UPDATE monitor_instance SET sequence = ?, updated_at = ? WHERE server_id = ?",
        sequence,
        updatedAt,
        serverId,
      );
      return;
    }

    this.#ctx.storage.sql.exec(
      `INSERT INTO monitor_instance (server_id, sequence, at, instance_json, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      serverId,
      sequence,
      updatedAt,
      "{}",
      updatedAt,
    );
  }

  #upsertMonitorInstance(
    serverId: string,
    sequence: number,
    at: string,
    instance: MonitorInstanceSummary,
  ): void {
    this.#ctx.storage.sql.exec(
      `INSERT INTO monitor_instance (server_id, sequence, at, instance_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(server_id) DO UPDATE SET
         sequence = excluded.sequence,
         at = excluded.at,
         instance_json = excluded.instance_json,
         updated_at = excluded.updated_at`,
      serverId,
      sequence,
      at,
      JSON.stringify(instance),
      nowIso(),
    );
  }

  #upsertMonitorResource(
    serverId: string,
    resource: MonitorResourceState,
  ): void {
    this.#ctx.storage.sql.exec(
      `INSERT INTO monitor_resource (
         resource_key, server_id, kind, status, state_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(resource_key) DO UPDATE SET
         server_id = excluded.server_id,
         kind = excluded.kind,
         status = excluded.status,
         state_json = excluded.state_json,
         updated_at = excluded.updated_at`,
      resource.resourceKey,
      serverId,
      resource.kind,
      resource.status,
      JSON.stringify(resource),
      nowIso(),
    );
  }

  #readMonitorResourceStatus(
    serverId: string,
    resourceKey: string,
  ): MonitorResourceStatus | null {
    const cursor = this.#ctx.storage.sql.exec(
      "SELECT status FROM monitor_resource WHERE server_id = ? AND resource_key = ?",
      serverId,
      resourceKey,
    );
    for (const row of cursor) {
      return String(row.status) as MonitorResourceStatus;
    }
    return null;
  }

  #insertMonitorEvent(serverId: string, event: MonitorEvent): void {
    this.#ctx.storage.sql.exec(
      `INSERT INTO monitor_event (
         server_id, resource_key, kind, from_status, to_status, reason, at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      serverId,
      event.resourceKey ?? null,
      event.kind ?? null,
      event.fromStatus ?? null,
      event.toStatus,
      event.reason ?? null,
      event.at,
      nowIso(),
    );
  }

  #emitMonitorTransition(
    serverId: string,
    event: MonitorEvent,
    nowMs = Date.now(),
  ): void {
    this.#insertMonitorEvent(serverId, event);
    this.#handleMonitorTransitionAlerts(serverId, event, nowMs);
  }

  #deriveAndEmitResourceTransitions(
    serverId: string,
    resources: MonitorResourceState[],
    at: string,
    nowMs: number,
  ): void {
    for (const resource of resources) {
      const previousStatus = this.#readMonitorResourceStatus(
        serverId,
        resource.resourceKey,
      );
      if (previousStatus === resource.status) continue;
      this.#emitMonitorTransition(
        serverId,
        {
          resourceKey: resource.resourceKey,
          kind: resource.kind,
          fromStatus: previousStatus ?? undefined,
          toStatus: resource.status,
          at,
          reason: previousStatus == null ? "sync-initial" : "sync-changed",
        },
        nowMs,
      );
    }
  }

  #resolveServerOfflineAlert(serverId: string, nowMs: number): void {
    this.#resolveAlert(serverId, serverId, nowMs);
  }

  #patchMonitorResourceFromTransition(
    serverId: string,
    event: MonitorEvent,
    at: string,
  ): void {
    if (!event.resourceKey) return;

    const resourceKey = event.resourceKey;
    const cursor = this.#ctx.storage.sql.exec(
      "SELECT kind, state_json FROM monitor_resource WHERE resource_key = ?",
      resourceKey,
    );
    let state: MonitorResourceState | null = null;
    for (const row of cursor) {
      try {
        state = JSON.parse(String(row.state_json)) as MonitorResourceState;
      } catch {
        state = {
          resourceKey,
          kind: String(row.kind) as MonitorResourceKind,
          status: event.toStatus,
        };
      }
      break;
    }

    if (!state) {
      state = {
        resourceKey,
        kind: (event.kind ?? "service") as MonitorResourceKind,
        status: event.toStatus,
      };
    }

    state.status = event.toStatus;
    state.updatedAt = at;
    if (event.kind) state.kind = event.kind;
    this.#upsertMonitorResource(serverId, state);
  }

  #markMonitorResourceOffline(
    serverId: string,
    resourceKey: string,
    kind: MonitorResourceKind,
    currentStatus: MonitorResourceStatus,
    at: string,
    reason: string,
  ): void {
    this.#insertMonitorEvent(serverId, {
      resourceKey,
      kind,
      fromStatus: currentStatus,
      toStatus: "offline",
      at,
      reason,
    });
    const cursor = this.#ctx.storage.sql.exec(
      "SELECT state_json FROM monitor_resource WHERE resource_key = ?",
      resourceKey,
    );
    for (const row of cursor) {
      let state: MonitorResourceState;
      try {
        state = JSON.parse(String(row.state_json)) as MonitorResourceState;
      } catch {
        state = { resourceKey, kind, status: currentStatus };
      }
      state.status = "offline";
      state.updatedAt = at;
      this.#ctx.storage.sql.exec(
        `UPDATE monitor_resource SET status = 'offline', state_json = ?, updated_at = ?
         WHERE resource_key = ?`,
        JSON.stringify(state),
        at,
        resourceKey,
      );
      return;
    }
  }

  #openOrUpdateAlert(
    serverId: string,
    resourceKey: string,
    toStatus: MonitorResourceStatus,
    nowMs: number,
  ): void {
    const now = nowIso(nowMs);
    const cursor = this.#ctx.storage.sql.exec(
      "SELECT * FROM monitor_alert WHERE resource_key = ?",
      resourceKey,
    );
    let existing: Record<string, SqlStorageValue> | null = null;
    for (const row of cursor) existing = row;

    if (!existing || existing.resolved_at) {
      this.#ctx.storage.sql.exec(
        `INSERT INTO monitor_alert (
           resource_key, server_id, status, opened_at, last_notified_at,
           last_delivered_at, cooldown_until, resolved_at
         ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)
         ON CONFLICT(resource_key) DO UPDATE SET
           server_id = excluded.server_id,
           status = excluded.status,
           opened_at = excluded.opened_at,
           last_notified_at = excluded.last_notified_at,
           last_delivered_at = NULL,
           cooldown_until = NULL,
           resolved_at = NULL`,
        resourceKey,
        serverId,
        toStatus,
        now,
        now,
      );
      return;
    }

    const cooldownUntil = existing.cooldown_until
      ? String(existing.cooldown_until)
      : null;
    if (cooldownUntil && Date.parse(cooldownUntil) > nowMs) return;

    const newCooldownUntil = nowIso(nowMs + MONITOR_ALERT_COOLDOWN_MS);
    this.#ctx.storage.sql.exec(
      `UPDATE monitor_alert
       SET status = ?, last_notified_at = ?, cooldown_until = ?
       WHERE resource_key = ?`,
      toStatus,
      now,
      newCooldownUntil,
      resourceKey,
    );
    this.#ctx.storage.sql.exec(
      `INSERT INTO monitor_deadline (deadline_name, server_id, due_at, kind, payload_json)
       VALUES (?, ?, ?, 'cooldown', NULL)
       ON CONFLICT(deadline_name) DO UPDATE SET
         server_id = excluded.server_id,
         due_at = excluded.due_at,
         kind = excluded.kind`,
      `cooldown:${resourceKey}`,
      serverId,
      newCooldownUntil,
    );
  }

  #resolveAlert(
    serverId: string,
    resourceKey: string,
    nowMs: number,
  ): void {
    const now = nowIso(nowMs);
    this.#ctx.storage.sql.exec(
      "UPDATE monitor_alert SET resolved_at = ?, cooldown_until = NULL WHERE resource_key = ?",
      now,
      resourceKey,
    );
    this.#ctx.storage.sql.exec(
      "DELETE FROM monitor_deadline WHERE deadline_name = ?",
      `cooldown:${resourceKey}`,
    );
  }

  #handleMonitorTransitionAlerts(
    serverId: string,
    event: MonitorEvent,
    nowMs: number,
  ): void {
    const resourceKey = event.resourceKey ?? serverId;
    if (
      event.toStatus === "degraded" ||
      event.toStatus === "unhealthy" ||
      event.toStatus === "failed"
    ) {
      this.#openOrUpdateAlert(serverId, resourceKey, event.toStatus, nowMs);
      return;
    }
    if (event.toStatus === "healthy" || event.toStatus === "stopped") {
      if (event.resourceKey) {
        this.#resolveAlert(serverId, event.resourceKey, nowMs);
      }
    }
  }

  async #processDueMonitorDeadlines(
    serverId: string,
    now: string,
    nowMs: number,
  ): Promise<boolean> {
    const cursor = this.#ctx.storage.sql.exec(
      "SELECT deadline_name, kind FROM monitor_deadline WHERE due_at <= ?",
      now,
    );
    const due: Array<{ deadlineName: string; kind: string }> = [];
    for (const row of cursor) {
      due.push({
        deadlineName: String(row.deadline_name),
        kind: String(row.kind),
      });
    }

    let offlineApplied = false;
    for (const { deadlineName, kind } of due) {
      if (kind === "offline") {
        offlineApplied = this.#processOfflineDeadline(serverId, nowMs) ||
          offlineApplied;
      } else if (kind === "cooldown") {
        const resourceKey = deadlineName.startsWith("cooldown:")
          ? deadlineName.slice("cooldown:".length)
          : deadlineName;
        this.#ctx.storage.sql.exec(
          "UPDATE monitor_alert SET cooldown_until = NULL WHERE resource_key = ?",
          resourceKey,
        );
      }
      this.#ctx.storage.sql.exec(
        "DELETE FROM monitor_deadline WHERE deadline_name = ?",
        deadlineName,
      );
    }
    return offlineApplied;
  }

  #processOfflineDeadline(serverId: string, nowMs: number): boolean {
    const instance = this.#getMonitorInstance(serverId);
    if (!instance) return false;

    const lastHeartbeatMs = Date.parse(instance.at);
    if (
      Number.isNaN(lastHeartbeatMs) ||
      nowMs - lastHeartbeatMs < MONITOR_OFFLINE_GRACE_MS
    ) {
      return false;
    }

    const at = nowIso(nowMs);
    let offlineApplied = false;
    this.#ctx.storage.transactionSync(() => {
      const resourceCursor = this.#ctx.storage.sql.exec(
        "SELECT resource_key, kind, status FROM monitor_resource WHERE server_id = ?",
        serverId,
      );
      for (const row of resourceCursor) {
        const resourceKey = String(row.resource_key);
        const currentStatus = String(row.status) as MonitorResourceStatus;
        if (
          currentStatus === "offline" ||
          currentStatus === "stopped" ||
          currentStatus === "failed"
        ) {
          continue;
        }
        const kind = String(row.kind) as MonitorResourceKind;
        this.#markMonitorResourceOffline(
          serverId,
          resourceKey,
          kind,
          currentStatus,
          at,
          "heartbeat-timeout",
        );
        offlineApplied = true;
      }
      this.#openOrUpdateAlert(serverId, serverId, "offline", nowMs);
      offlineApplied = true;
    });

    if (offlineApplied) {
      void this.#projectOffline(serverId);
    }
    return offlineApplied;
  }

  #pruneMonitorTables(nowMs: number): void {
    this.#ctx.storage.sql.exec(
      `
      DELETE FROM monitor_event
      WHERE seq NOT IN (
        SELECT seq FROM monitor_event ORDER BY seq DESC LIMIT ?
      )
    `,
      MONITOR_EVENT_RETAIN,
    );

    const metricCutoff = nowIso(
      nowMs - MONITOR_METRIC_RETAIN_HOURS * 60 * 60 * 1000,
    );
    this.#ctx.storage.sql.exec(
      "DELETE FROM monitor_metric_minute WHERE bucket_at < ?",
      metricCutoff,
    );

    const alertCutoff = nowIso(
      nowMs - MONITOR_ALERT_RESOLVED_RETAIN_DAYS * 24 * 60 * 60 * 1000,
    );
    this.#ctx.storage.sql.exec(
      "DELETE FROM monitor_alert WHERE resolved_at IS NOT NULL AND resolved_at < ?",
      alertCutoff,
    );
    this.#ctx.storage.sql.exec(
      `
      DELETE FROM monitor_alert
      WHERE resolved_at IS NOT NULL
        AND resource_key NOT IN (
          SELECT resource_key FROM monitor_alert
          WHERE resolved_at IS NOT NULL
          ORDER BY resolved_at DESC
          LIMIT ?
        )
    `,
      MONITOR_ALERT_RESOLVED_RETAIN,
    );
  }

  #listMonitorAlerts(serverId: string | null): MonitorAlertRow[] {
    if (!serverId) return [];
    const cursor = this.#ctx.storage.sql.exec(
      `SELECT * FROM monitor_alert
       WHERE server_id = ? AND resolved_at IS NULL
       ORDER BY opened_at DESC`,
      serverId,
    );
    const rows: MonitorAlertRow[] = [];
    for (const row of cursor) {
      rows.push({
        resourceKey: String(row.resource_key),
        serverId,
        status: String(row.status) as MonitorResourceStatus,
        openedAt: String(row.opened_at ?? ""),
        lastNotifiedAt: row.last_notified_at
          ? String(row.last_notified_at)
          : undefined,
        cooldownUntil: row.cooldown_until
          ? String(row.cooldown_until)
          : undefined,
        resolvedAt: row.resolved_at ? String(row.resolved_at) : undefined,
      });
    }
    return rows;
  }

  #drainNotificationCandidates(
    serverId: string,
  ): MonitorAlertRow[] {
    const cursor = this.#ctx.storage.sql.exec(
      `SELECT * FROM monitor_alert
       WHERE server_id = ?
         AND resolved_at IS NULL
         AND last_notified_at IS NOT NULL
         AND (last_delivered_at IS NULL OR last_delivered_at < last_notified_at)`,
      serverId,
    );
    const rows: MonitorAlertRow[] = [];
    const drained: Array<{ resourceKey: string; lastNotifiedAt: string }> = [];
    for (const row of cursor) {
      const resourceKey = String(row.resource_key);
      const lastNotifiedAt = String(row.last_notified_at ?? "");
      rows.push({
        resourceKey,
        serverId,
        status: String(row.status) as MonitorResourceStatus,
        openedAt: String(row.opened_at ?? ""),
        lastNotifiedAt,
        cooldownUntil: row.cooldown_until
          ? String(row.cooldown_until)
          : undefined,
      });
      drained.push({ resourceKey, lastNotifiedAt });
    }
    for (const { resourceKey, lastNotifiedAt } of drained) {
      this.#ctx.storage.sql.exec(
        "UPDATE monitor_alert SET last_delivered_at = ? WHERE resource_key = ?",
        lastNotifiedAt,
        resourceKey,
      );
    }
    return rows;
  }

  #insertMonitorMetric(
    serverId: string,
    at: string,
    instance: MonitorInstanceSummary,
  ): void {
    const bucketAt = normalizeMonitorMetricBucket(at);
    const metrics = this.#metricValuesFromInstance(instance);
    const createdAt = nowIso();
    this.#ctx.storage.sql.exec(
      `DELETE FROM monitor_metric_minute WHERE server_id = ? AND bucket_at = ?`,
      serverId,
      bucketAt,
    );
    this.#ctx.storage.sql.exec(
      `INSERT INTO monitor_metric_minute (
         server_id, bucket_at, cpu, memory, disk, load, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      serverId,
      bucketAt,
      metrics.cpu ?? null,
      metrics.memory ?? null,
      metrics.disk ?? null,
      metrics.load ?? null,
      createdAt,
    );
  }

  #reconcileMonitorResources(
    serverId: string,
    incomingKeys: Set<string>,
  ): void {
    const cursor = this.#ctx.storage.sql.exec(
      "SELECT resource_key, kind, status FROM monitor_resource WHERE server_id = ?",
      serverId,
    );
    const at = nowIso();
    for (const row of cursor) {
      const resourceKey = String(row.resource_key);
      if (incomingKeys.has(resourceKey)) continue;

      const currentStatus = String(row.status) as MonitorResourceStatus;
      if (
        currentStatus !== "offline" &&
        currentStatus !== "stopped" &&
        currentStatus !== "failed"
      ) {
        this.#insertMonitorEvent(serverId, {
          resourceKey,
          kind: String(row.kind) as MonitorResourceKind,
          fromStatus: currentStatus,
          toStatus: "offline",
          at,
          reason: "reconcile-removed",
        });
      }

      this.#ctx.storage.sql.exec(
        "DELETE FROM monitor_resource WHERE resource_key = ?",
        resourceKey,
      );
    }
  }

  async #applyMonitorSync(
    serverId: string,
    msg: DaemonInboundEnvelope & { kind: "monitor-sync" },
  ): Promise<{ acceptedSequence: number; resyncNeeded: boolean }> {
    let currentSequence = this.#readMonitorSequence(serverId);
    let decision = evaluateFullSyncSequence(currentSequence, msg.sequence);
    if (decision.action === "gap") {
      return {
        acceptedSequence: decision.acceptedSequence,
        resyncNeeded: decision.resyncNeeded,
      };
    }

    const hasResources = msg.resources.length > 0;
    const isStaleNoop = decision.action === "noop" &&
      msg.sequence <= currentSequence;

    if (isStaleNoop && !hasResources) {
      return {
        acceptedSequence: currentSequence,
        resyncNeeded: false,
      };
    }

    if (isStaleNoop && hasResources && msg.sequence < currentSequence) {
      this.#resetMonitorSequence(serverId);
      currentSequence = 0;
      decision = evaluateFullSyncSequence(0, msg.sequence);
    }

    const nowMs = Date.now();
    this.#ctx.storage.transactionSync(() => {
      this.#upsertMonitorInstance(serverId, msg.sequence, msg.at, msg.instance);
      this.#resolveServerOfflineAlert(serverId, nowMs);
      this.#deriveAndEmitResourceTransitions(
        serverId,
        msg.resources,
        msg.at,
        nowMs,
      );
      const incomingKeys = new Set<string>();
      for (const resource of msg.resources) {
        incomingKeys.add(resource.resourceKey);
        this.#upsertMonitorResource(serverId, resource);
      }
      if (hasResources) {
        this.#reconcileMonitorResources(serverId, incomingKeys);
      }
      this.#insertMonitorMetric(serverId, msg.at, msg.instance);
      this.#persistMonitorSequence(serverId, msg.sequence);
    });
    await this.#scheduleOfflineDeadline(serverId, nowMs);
    return {
      acceptedSequence: msg.sequence,
      resyncNeeded: false,
    };
  }

  async #applyMonitorHeartbeat(
    serverId: string,
    msg: DaemonInboundEnvelope & { kind: "monitor-heartbeat" },
  ): Promise<{ acceptedSequence: number; resyncNeeded: boolean }> {
    const currentSequence = this.#readMonitorSequence(serverId);
    const decision = evaluateMonitorSequence(currentSequence, msg.sequence);
    if (decision.action !== "accept") {
      return {
        acceptedSequence: decision.acceptedSequence,
        resyncNeeded: decision.resyncNeeded,
      };
    }

    const nowMs = Date.now();
    this.#ctx.storage.transactionSync(() => {
      this.#upsertMonitorInstance(serverId, msg.sequence, msg.at, msg.instance);
      this.#resolveServerOfflineAlert(serverId, nowMs);
      if (msg.resources) {
        this.#deriveAndEmitResourceTransitions(
          serverId,
          msg.resources,
          msg.at,
          nowMs,
        );
        for (const resource of msg.resources) {
          this.#upsertMonitorResource(serverId, resource);
        }
      }
      this.#insertMonitorMetric(serverId, msg.at, msg.instance);
      this.#persistMonitorSequence(serverId, msg.sequence);
    });
    await this.#scheduleOfflineDeadline(serverId, nowMs);
    return {
      acceptedSequence: msg.sequence,
      resyncNeeded: false,
    };
  }

  async #applyMonitorTransition(
    serverId: string,
    msg: DaemonInboundEnvelope & { kind: "monitor-transition" },
  ): Promise<{ acceptedSequence: number; resyncNeeded: boolean }> {
    const currentSequence = this.#readMonitorSequence(serverId);
    const decision = evaluateMonitorSequence(currentSequence, msg.sequence);
    if (decision.action !== "accept") {
      return {
        acceptedSequence: decision.acceptedSequence,
        resyncNeeded: decision.resyncNeeded,
      };
    }

    const nowMs = Date.now();
    this.#ctx.storage.transactionSync(() => {
      for (const event of msg.events) {
        const previousStatus = event.resourceKey
          ? this.#readMonitorResourceStatus(serverId, event.resourceKey)
          : null;
        if (!event.resourceKey || previousStatus !== event.toStatus) {
          this.#emitMonitorTransition(
            serverId,
            {
              ...event,
              fromStatus: event.fromStatus ?? previousStatus ?? undefined,
            },
            nowMs,
          );
        }
        this.#patchMonitorResourceFromTransition(serverId, event, msg.at);
      }
      if (msg.resources) {
        for (const resource of msg.resources) {
          this.#upsertMonitorResource(serverId, resource);
        }
      }
      this.#persistMonitorSequence(serverId, msg.sequence);
    });
    await this.#scheduleOfflineDeadline(serverId, nowMs);
    return {
      acceptedSequence: decision.acceptedSequence,
      resyncNeeded: decision.resyncNeeded,
    };
  }

  #getMonitorInstance(serverId: string | null): MonitorInstanceRow | null {
    if (!serverId) return null;
    const cursor = this.#ctx.storage.sql.exec(
      "SELECT * FROM monitor_instance WHERE server_id = ?",
      serverId,
    );
    for (const row of cursor) {
      let instance: MonitorInstanceSummary = {};
      try {
        instance = JSON.parse(
          String(row.instance_json),
        ) as MonitorInstanceSummary;
      } catch {
        instance = {};
      }
      return {
        serverId,
        sequence: Number(row.sequence ?? 0),
        at: String(row.at ?? ""),
        instance,
        updatedAt: String(row.updated_at ?? ""),
      };
    }
    return null;
  }

  #listMonitorResources(serverId: string | null): MonitorResourceRow[] {
    if (!serverId) return [];
    const cursor = this.#ctx.storage.sql.exec(
      "SELECT * FROM monitor_resource WHERE server_id = ? ORDER BY resource_key",
      serverId,
    );
    const rows: MonitorResourceRow[] = [];
    for (const row of cursor) {
      let state: MonitorResourceState;
      try {
        state = JSON.parse(String(row.state_json)) as MonitorResourceState;
      } catch {
        state = {
          resourceKey: String(row.resource_key),
          kind: String(row.kind) as MonitorResourceState["kind"],
          status: String(row.status) as MonitorResourceState["status"],
        };
      }
      rows.push({
        resourceKey: String(row.resource_key),
        serverId,
        kind: state.kind,
        status: state.status,
        state,
        updatedAt: String(row.updated_at ?? ""),
      });
    }
    return rows;
  }

  #listMonitorEvents(serverId: string | null, limit = 50): MonitorEventRow[] {
    if (!serverId) return [];
    const cursor = this.#ctx.storage.sql.exec(
      `SELECT * FROM monitor_event
       WHERE server_id = ?
       ORDER BY seq DESC
       LIMIT ?`,
      serverId,
      limit,
    );
    const rows: MonitorEventRow[] = [];
    for (const row of cursor) {
      rows.push({
        seq: Number(row.seq),
        serverId,
        resourceKey: row.resource_key ? String(row.resource_key) : undefined,
        kind: row.kind
          ? String(row.kind) as MonitorEventRow["kind"]
          : undefined,
        fromStatus: row.from_status
          ? String(row.from_status) as MonitorEventRow["fromStatus"]
          : undefined,
        toStatus: String(row.to_status) as MonitorEventRow["toStatus"],
        reason: row.reason ? String(row.reason) : undefined,
        at: String(row.at ?? ""),
        createdAt: String(row.created_at ?? ""),
      });
    }
    return rows;
  }

  #listMonitorMetrics(serverId: string | null, limit = 50): MonitorMetricRow[] {
    if (!serverId) return [];
    const cursor = this.#ctx.storage.sql.exec(
      `SELECT * FROM monitor_metric_minute
       WHERE server_id = ?
       ORDER BY bucket_at DESC
       LIMIT ?`,
      serverId,
      limit,
    );
    const rows: MonitorMetricRow[] = [];
    for (const row of cursor) {
      const metric: MonitorMetricRow = {
        seq: Number(row.seq),
        serverId,
        bucketAt: String(row.bucket_at ?? ""),
        createdAt: String(row.created_at ?? ""),
      };
      if (row.cpu != null) metric.cpu = Number(row.cpu);
      if (row.memory != null) metric.memory = Number(row.memory);
      if (row.disk != null) metric.disk = Number(row.disk);
      if (row.load != null) metric.load = Number(row.load);
      rows.push(metric);
    }
    return rows;
  }

  #getProjectionDb(): Db | null {
    if (!this.#env.HYPERDRIVE) return null;
    if (!this.#projectionDb) {
      this.#projectionDb = createWorkersDb(this.#env.HYPERDRIVE);
    }
    return this.#projectionDb;
  }

  async #projectOnline(
    serverId: string,
    meta: {
      keyId: string;
      hostname?: string;
      machineId?: string;
      remoteAddress?: string;
    },
    connectedAt: string,
  ): Promise<void> {
    const db = this.#getProjectionDb();
    if (!db) return;
    await projectServerDaemon(db, serverId, {
      kind: "online",
      identity: {
        hostname: meta.hostname || undefined,
        machineId: meta.machineId || undefined,
        remoteAddress: meta.remoteAddress || undefined,
        keyId: meta.keyId,
      },
      connectedAt,
    }, {
      resources: this.#listMonitorResources(serverId),
      instanceAt: this.#getMonitorInstance(serverId)?.at,
    });
  }

  async #projectOffline(serverId: string): Promise<void> {
    const db = this.#getProjectionDb();
    if (!db) return;
    await projectServerDaemon(db, serverId, { kind: "offline" });
  }

  async #projectDisconnected(serverId: string): Promise<void> {
    const db = this.#getProjectionDb();
    if (!db) return;
    await onDaemonDisconnected(db, serverId);
  }

  async #projectMonitorMessage(
    serverId: string,
    msg: DaemonInboundEnvelope,
  ): Promise<void> {
    const db = this.#getProjectionDb();
    if (!db) return;
    if (
      msg.kind !== "monitor-sync" &&
      msg.kind !== "monitor-heartbeat" &&
      msg.kind !== "monitor-transition"
    ) {
      return;
    }

    const cellAdapter = {
      listMonitorResources: async () => this.#listMonitorResources(serverId),
      getMonitorInstance: async () => this.#getMonitorInstance(serverId),
      getSnapshot: async () => this.#getSnapshot(serverId),
    } as Pick<
      import("./contracts.ts").DaemonCell,
      "listMonitorResources" | "getMonitorInstance" | "getSnapshot"
    >;

    await onMonitorMessageApplied(
      db,
      serverId,
      cellAdapter as import("./contracts.ts").DaemonCell,
      msg.kind,
      msg,
    );
  }
}
