import type { DerivedSecretsConfig } from "../../client/authn/secrets.ts";
import {
  deriveSecretsConfig,
  parseSecretsEnv,
} from "../../client/authn/secrets.ts";
import { createWorkersDb, type Db } from "../../db.ts";
import { verifyDaemonJwt } from "../authn/daemon-jwt.ts";
import {
  onDaemonConnected,
  onDaemonDisconnected,
  onDaemonHeartbeat,
} from "./control-plane-monitor.ts";
import type {
  DaemonCell,
  DaemonCellLease,
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
  outboundEnvelopeToWireMessage,
  parseDaemonMessage,
  wireMessageToInboundEnvelope,
} from "./protocol.ts";

const TERMINAL_STATUSES = new Set<PendingRequestStatus>([
  "acked",
  "done",
  "failed",
  "expired",
]);

const DAEMON_SOCKET_LEASE_MS = 180_000;
const OUTBOX_INFLIGHT_LEASE_MS = 30_000;
const DELIVERY_LEASE_NAME = "delivery";
const DAEMON_SOCKET_LEASE_NAME = "daemon-socket";
const OUTBOX_PUMP_ALARM_MS = 2_000;
const HEARTBEAT_COALESCE_MS = 60_000;

function nowIso(now = Date.now()): string {
  return new Date(now).toISOString();
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
): DaemonCellSnapshot {
  return {
    serverId,
    version: 0,
    updatedAt: String(row.updated_at ?? nowIso()),
    hostname: row.hostname ? String(row.hostname) : undefined,
    machineId: row.machine_id ? String(row.machine_id) : undefined,
    remoteAddress: row.remote_address ? String(row.remote_address) : undefined,
    sessionId: row.session_id ? String(row.session_id) : undefined,
    keyId: row.key_id ? String(row.key_id) : undefined,
    connected: Number(row.connected ?? 0) === 1,
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
        last_seen_at TEXT,
        key_last_used_at TEXT,
        agent_json TEXT,
        updated_at TEXT
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
    this.#schemaReady = true;
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
      `INSERT INTO cell_meta (server_id, connected, updated_at)
       VALUES (?, 0, ?)
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
    if (this.#env.HYPERDRIVE) {
      return createWorkersDb(this.#env.HYPERDRIVE);
    }
    const url = this.#env.TURBOPANEL_DATABASE_URL?.trim();
    if (url) {
      return createWorkersDb({ connectionString: url });
    }
    return null;
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

  async #projectConnected(serverId: string, connectedAt: string): Promise<void> {
    const db = this.#newProjectionDb();
    if (!db) return;
    try {
      await onDaemonConnected(
        db,
        serverId,
        this.#projectionCell(serverId),
        connectedAt,
      );
    } catch (err) {
      console.error(
        `daemon cell connect projection failed (${serverId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async #projectDisconnected(serverId: string): Promise<void> {
    const db = this.#newProjectionDb();
    if (!db) return;
    try {
      await onDaemonDisconnected(db, serverId, this.#projectionCell(serverId));
    } catch (err) {
      console.error(
        `daemon cell disconnect projection failed (${serverId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async #projectAgent(
    serverId: string,
    agent: DaemonAgentInfo | undefined,
  ): Promise<void> {
    if (!agent?.commit || !agent?.buildId) return;
    const db = this.#newProjectionDb();
    if (!db) return;
    try {
      await onDaemonHeartbeat(
        db,
        serverId,
        this.#projectionCell(serverId),
        agent,
      );
    } catch (err) {
      console.error(
        `daemon cell agent projection failed (${serverId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
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
            `UPDATE cell_meta SET connected = 0, last_seen_at = ?, updated_at = ?
             WHERE server_id = ?`,
            closedAt,
            closedAt,
            serverId,
          );
        }
      }
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
    const keyLastUsedAt = nowIso();
    const sessionId = meta.sessionId ?? "";
    const leaseExpiresAt = new Date(Date.now() + DAEMON_SOCKET_LEASE_MS)
      .toISOString();

    this.#ctx.storage.transactionSync(() => {
      this.#ensureServerId(serverId);
      this.#ctx.storage.sql.exec(
        `INSERT INTO cell_meta (
          server_id, connected, connection_id, session_id, key_id,
          hostname, machine_id, remote_address, connected_at,
          last_seen_at, key_last_used_at, updated_at
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(server_id) DO UPDATE SET
          connected = 1,
          connection_id = excluded.connection_id,
          session_id = excluded.session_id,
          key_id = excluded.key_id,
          hostname = excluded.hostname,
          machine_id = excluded.machine_id,
          remote_address = excluded.remote_address,
          connected_at = excluded.connected_at,
          last_seen_at = excluded.last_seen_at,
          key_last_used_at = excluded.key_last_used_at,
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
        keyLastUsedAt,
        connectedAt,
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

    return {
      holder: connectionId,
      token: connectionId,
      expiresAt: leaseExpiresAt,
    };
  }

  async #scheduleNearestAlarm(): Promise<void> {
    if (this.#hasDeliverableOutbox() && this.#ctx.getWebSockets().length > 0) {
      await this.#ctx.storage.setAlarm(Date.now() + OUTBOX_PUMP_ALARM_MS);
      return;
    }
    await this.#ctx.storage.deleteAlarm();
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

    void this.#projectConnected(serverId, connectedAt);
    void this.#pumpOutboxToDaemonSockets(serverId);
    await this.#scheduleOutboxRetryIfNeeded();

    return new Response(null, { status: 101, webSocket: client });
  }

  #shouldCoalesceLastSeenAt(serverId: string, atMs: number): boolean {
    const cursor = this.#ctx.storage.sql.exec(
      "SELECT last_seen_at FROM cell_meta WHERE server_id = ?",
      serverId,
    );
    for (const row of cursor) {
      const lastSeenAt = row.last_seen_at ? String(row.last_seen_at) : null;
      if (!lastSeenAt) return true;
      const lastSeenMs = Date.parse(lastSeenAt);
      if (Number.isNaN(lastSeenMs)) return true;
      return atMs - lastSeenMs >= HEARTBEAT_COALESCE_MS;
    }
    return true;
  }

  #readStoredAgent(serverId: string): DaemonAgentInfo | undefined {
    const cursor = this.#ctx.storage.sql.exec(
      "SELECT agent_json FROM cell_meta WHERE server_id = ?",
      serverId,
    );
    for (const row of cursor) {
      return parseAgentJson(
        row.agent_json ? String(row.agent_json) : null,
      );
    }
    return undefined;
  }

  #recordInbound(
    serverId: string,
    at: string,
    agent?: DaemonAgentInfo,
  ): void {
    const atMs = Date.parse(at);
    const coalesce = Number.isNaN(atMs) ||
      this.#shouldCoalesceLastSeenAt(serverId, atMs);
    const now = nowIso();

    if (agent) {
      const agentChanged = !agentIdentityEqual(agent, this.#readStoredAgent(serverId));
      if (coalesce) {
        this.#ctx.storage.sql.exec(
          `UPDATE cell_meta SET last_seen_at = ?, key_last_used_at = ?, agent_json = ?, updated_at = ?
           WHERE server_id = ?`,
          at,
          at,
          JSON.stringify(agent),
          now,
          serverId,
        );
      } else if (agentChanged) {
        this.#ctx.storage.sql.exec(
          `UPDATE cell_meta SET key_last_used_at = ?, agent_json = ?, updated_at = ? WHERE server_id = ?`,
          at,
          JSON.stringify(agent),
          now,
          serverId,
        );
      } else {
        this.#ctx.storage.sql.exec(
          "UPDATE cell_meta SET key_last_used_at = ?, updated_at = ? WHERE server_id = ?",
          at,
          now,
          serverId,
        );
      }
      return;
    }

    if (coalesce) {
      this.#ctx.storage.sql.exec(
        `UPDATE cell_meta SET last_seen_at = ?, key_last_used_at = ?, updated_at = ?
         WHERE server_id = ?`,
        at,
        at,
        now,
        serverId,
      );
    } else {
      this.#ctx.storage.sql.exec(
        "UPDATE cell_meta SET key_last_used_at = ?, updated_at = ? WHERE server_id = ?",
        at,
        now,
        serverId,
      );
    }
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

    const parsed = parseDaemonMessage(raw);
    if (!parsed) return;

    if (parsed.type === "hello") {
      this.#recordInbound(attachment.serverId, parsed.at, parsed.agent);
      await this.#projectAgent(attachment.serverId, parsed.agent);
      return;
    }

    if (parsed.type === "heartbeat") {
      this.#recordInbound(
        attachment.serverId,
        parsed.at,
        parsed.agent,
      );
      await this.#projectAgent(attachment.serverId, parsed.agent);
      return;
    }

    this.#recordInbound(attachment.serverId, parsed.at);
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
        `DELETE FROM leases
         WHERE lease_name = ? AND holder = ? AND token = ?`,
        DAEMON_SOCKET_LEASE_NAME,
        attachment.connectionId,
        attachment.connectionId,
      );

      if (isCurrentConnection) {
        this.#ctx.storage.sql.exec(
          `UPDATE cell_meta SET connected = 0, last_seen_at = ?, updated_at = ?
           WHERE server_id = ?`,
          closedAt,
          closedAt,
          attachment.serverId,
        );
      }
    });

    if (isCurrentConnection) {
      await this.#projectDisconnected(attachment.serverId);
      await this.#scheduleNearestAlarm();
    }
  }

  async alarm(): Promise<void> {
    this.#ensureSchema();
    const nowMs = Date.now();
    const now = nowIso(nowMs);

    this.#ctx.storage.sql.exec(
      "DELETE FROM requests WHERE expires_at <= ?",
      now,
    );
    this.#ctx.storage.sql.exec(
      `DELETE FROM requests
       WHERE status IN ('acked', 'done', 'failed', 'expired')
       AND finished_at IS NOT NULL
       AND finished_at <= ?`,
      nowIso(nowMs - 60_000),
    );
    this.#ctx.storage.sql.exec(
      "DELETE FROM outbox WHERE expires_at <= ?",
      now,
    );

    const serverId = this.#resolveServerId(new Request("https://do.internal/"));
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
      const clearedAt = nowIso();
      this.#ctx.storage.transactionSync(() => {
        this.#ctx.storage.sql.exec("DELETE FROM leases");
        this.#ctx.storage.sql.exec(
          `UPDATE cell_meta SET
             connected = 0,
             connection_id = NULL,
             session_id = NULL,
             updated_at = ?
           WHERE server_id = ?`,
          clearedAt,
          serverId,
        );
      });
    }

    await this.#ctx.storage.deleteAlarm();
    await this.#ctx.storage.deleteAll();
    this.#schemaReady = false;
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

      case "/rpc/record-inbound":
        this.#recordInbound(
          this.#requireServerId(request, body),
          String((body?.params as { at?: string })?.at ?? nowIso()),
          (body?.params as { agent?: DaemonAgentInfo })?.agent,
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

    // Read-only: never insert `cell_meta` here. Reading a missing or purged
    // snapshot returns a synthetic disconnected snapshot without recreating the
    // row. Row creation belongs only on mutation paths (attach, patch, enqueue,
    // and other writes that go through `#ensureServerId`).
    const metaCursor = this.#ctx.storage.sql.exec(
      "SELECT * FROM cell_meta WHERE server_id = ?",
      serverId,
    );
    for (const row of metaCursor) {
      return snapshotFromMetaRow(serverId, row);
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
    let sql = "UPDATE cell_meta SET updated_at = ?";

    if (patch.hostname !== undefined) {
      sql += ", hostname = ?";
      fields.push(patch.hostname);
    }
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
    this.#ctx.storage.sql.exec(sql, ...fields);
    return await this.#getSnapshot(serverId);
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
    _serverId: string,
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

    const updatedCursor = this.#ctx.storage.sql.exec(
      "SELECT * FROM requests WHERE request_id = ?",
      inbound.requestId,
    );
    for (const updated of updatedCursor) {
      const record = parseRequestRow(serverId, updated);
      if (isTerminalStatus(record.status)) {
        this.#reclaimTerminalOutbox(inbound.requestId);
        await this.#scheduleNearestAlarm();
      }
      return record;
    }
    return existing;
  }

  #reclaimTerminalOutbox(requestId: string): void {
    this.#ctx.storage.sql.exec(
      "DELETE FROM outbox WHERE request_id = ?",
      requestId,
    );
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
      if (record && isTerminalStatus(record.status)) {
        this.#reclaimTerminalRequest(requestId);
        return record;
      }
      await scheduler.wait(250);
    }
    return null;
  }

  #reclaimTerminalRequest(requestId: string): void {
    this.#ctx.storage.sql.exec(
      `DELETE FROM requests
       WHERE request_id = ? AND status IN ('acked', 'done', 'failed', 'expired')`,
      requestId,
    );
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
    this.#reclaimTerminalOutbox(outbound.requestId);
    const expiredRecord: PendingRequestRecord = {
      serverId,
      requestId: outbound.requestId,
      requestKind: outbound.kind,
      status: "expired",
      createdAt: outbound.at,
      expiresAt: expiredAt,
      finishedAt: expiredAt,
    };
    this.#reclaimTerminalRequest(outbound.requestId);
    return expiredRecord;
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
            `UPDATE cell_meta SET connected = 0, last_seen_at = ?, updated_at = ?
             WHERE server_id = ?`,
            closedAt,
            closedAt,
            serverId,
          );
        }
      }
    });
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
    for (const deliveryId of deliveryIds) {
      this.#ctx.storage.sql.exec(
        "DELETE FROM outbox WHERE delivery_id = ?",
        deliveryId,
      );
    }
    await this.#scheduleNearestAlarm();
  }
}
