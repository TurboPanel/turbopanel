import type { Hono } from "hono";
import { upgradeWebSocket } from "hono/deno";
import type { DaemonCellRegistry } from "./cell/contracts.ts";
import {
  DAEMON_CELL_PING,
  DAEMON_CELL_PONG,
  DAEMON_INBOUND_ALLOWED,
  type DaemonMessage,
  outboundEnvelopeToWireMessage,
  parseDaemonMessage,
  wireMessageToInboundEnvelope,
} from "./cell/protocol.ts";
import type { DaemonJwtKeyring } from "./authn/daemon-jwt-keyring.ts";
import { tryAssignColocatedDaemonToInstalledOrganization } from "../client/authn/install-state.ts";
import type { Db } from "../db.ts";
import { compatLogError, compatLogWarn } from "../log-compat.ts";
import { cellTrace, daemonCellLog } from "../logger.ts";
import {
  onDaemonConnected,
  onDaemonDisconnected,
  onDaemonInbound,
  onDaemonUpdateResult,
} from "./cell/control-plane-monitor.ts";
import {
  CLIENT_WS_PATH,
  DAEMON_WS_PATH,
  DEVELOPER_WS_PATH,
} from "../surfaces.ts";
import { resolveSelfHostedGeo } from "../lib/geo/self-hosted-geo-provider.ts";
import { touchServerMetadata } from "../server-registry.ts";
import { verifyDaemonJwt } from "./authn/daemon-jwt.ts";
import type { ServerMetricsStore } from "./metrics/types.ts";
import {
  metricsPayloadByteLength,
  rateLimitedMetricsLog,
  validateHostMetricsSample,
} from "./metrics/validation.ts";
import { getServerDaemonStateByServerId } from "./authn/server-identity-db.ts";
import type { RateLimiter } from "./rate-limit/contracts.ts";
import { createInboundWindowGate } from "./rate-limit/inbound-window.ts";
import { daemonConnectRateLimitKey } from "./rate-limit/keys.ts";

/** Max idle block for outbox pump reads — keep low so new commands aren't stuck behind a long sleep. */
const OUTBOX_PUMP_BLOCK_MS = 250;

function isClosedConnectionError(err: unknown): boolean {
  return /connection is closed/i.test(String(err));
}

function assignColocatedDaemonOnConnect(
  db: Db,
  registry: DaemonCellRegistry,
): void {
  void tryAssignColocatedDaemonToInstalledOrganization(db, registry).catch(
    (err) => {
      compatLogError(
        "ws",
        "failed to assign colocated server:",
        String(err),
      );
    },
  );
}

function startDaemonOutboxPump(params: {
  cell: ReturnType<DaemonCellRegistry["getCell"]>;
  serverId: string;
  connectionId: string;
  consumer: string;
  ws: WebSocket;
  abortRef: { abort: boolean };
}): void {
  const { cell, serverId, connectionId, consumer, ws, abortRef } = params;

  void (async () => {
    while (!abortRef.abort) {
      try {
        const batch = await cell.readOutboxBatch({
          consumer,
          count: 50,
          blockMs: OUTBOX_PUMP_BLOCK_MS,
        });
        for (const envelope of batch) {
          const wireMsg = outboundEnvelopeToWireMessage(envelope);
          await cell.markSent(envelope.deliveryId, connectionId);
          cellTrace("outbox-send", {
            serverId,
            conn: connectionId,
            deliveryId: envelope.deliveryId,
            requestId: envelope.requestId,
            kind: envelope.kind,
          });
          ws.send(JSON.stringify(wireMsg));
          await cell.ackOutbox([envelope.deliveryId], consumer);
        }
        if (batch.length > 0) {
          await cell.putSnapshot({
            lastOutboundAt: new Date().toISOString(),
          });
        }
      } catch (err) {
        if (abortRef.abort) {
          break;
        }
        if (isClosedConnectionError(err)) {
          abortRef.abort = true;
          break;
        }
        compatLogWarn("ws", `outbox pump error: ${String(err)}`);
      }
    }
  })();
}

function detachDaemonSocketSafe(
  cell: ReturnType<DaemonCellRegistry["getCell"]>,
  params: {
    connectionId: string;
    reason: string;
    closedAt: string;
  },
  db: Db,
  serverId: string,
  connectionId: string | undefined,
): void {
  void cell.detachDaemonSocket(params).then(async () => {
    cellTrace("detach", {
      serverId,
      conn: connectionId,
      reason: params.reason,
    });
    await onDaemonDisconnected(db, serverId, cell);
    daemonCellLog(
      "INFO",
      serverId,
      connectionId,
      "daemon disconnected",
    );
  }).catch((err) => {
    if (isClosedConnectionError(err)) {
      return;
    }
    compatLogWarn("ws", `detachDaemonSocket failed: ${String(err)}`);
  });
}

/**
 * Handle the wire cell ping: pong immediately, refresh presence, and repair a
 * Postgres-only false-offline that can linger after a prior Redis demotion.
 */
async function handleDaemonCellPing(params: {
  cell: ReturnType<DaemonCellRegistry["getCell"]>;
  db: Db;
  serverId: string;
  connectionId: string | undefined;
  ws: WebSocket;
}): Promise<void> {
  const { cell, db, serverId, connectionId, ws } = params;
  const pingAt = new Date().toISOString();
  cellTrace("ping", { serverId, conn: connectionId });
  ws.send(DAEMON_CELL_PONG);
  cellTrace("pong", { serverId, conn: connectionId });
  // Snapshot before recordInbound: after a false Redis demotion the cell may
  // still show connected=0 so we can re-project Postgres online. recordInbound
  // alone self-heals Redis and would make a later inbound hit
  // steadyStateInboundSkipsDbRead while Postgres stays offline (UI shows Offline
  // despite a live socket).
  const snapshotBefore = await cell.getSnapshot();
  await cell.recordInbound({ connectionId, at: pingAt });
  if (!snapshotBefore.connected) {
    await onDaemonConnected(
      db,
      serverId,
      cell,
      snapshotBefore.connectedAt ?? pingAt,
    );
    return;
  }
  // Redis already connected — still repair Postgres-only false offline (stuck
  // after a prior demotion that self-healed Redis only).
  const daemonRow = await getServerDaemonStateByServerId(db, serverId);
  if (daemonRow?.status?.connected === false) {
    await onDaemonConnected(
      db,
      serverId,
      cell,
      snapshotBefore.connectedAt ?? pingAt,
    );
  }
}

/** Validate and fire-and-forget-persist a host metrics frame. */
// Deprecated transition fallback: superseded by POST /api/daemon/v1/metrics;
// removable once all daemons emit host metrics over HTTP.
function handleMetricsMessage(params: {
  message: DaemonMessage;
  serverId: string;
  raw: string;
  metricsStore: ServerMetricsStore | undefined;
}): void {
  const { message, serverId, raw, metricsStore } = params;
  const result = validateHostMetricsSample(message, {
    serverId,
    receivedAt: new Date().toISOString(),
    payloadBytes: metricsPayloadByteLength(raw),
  });
  if (!result.ok) {
    rateLimitedMetricsLog(serverId, result.reason, (reason) => {
      compatLogWarn(
        "metrics",
        `ignored invalid metrics from ${serverId}: ${reason}`,
      );
    });
    return;
  }
  const logWriteFailed = (err: unknown) => {
    rateLimitedMetricsLog(serverId, "write_failed", () => {
      compatLogWarn(
        "metrics",
        `metrics write failed for ${serverId}: ${String(err)}`,
      );
    });
  };
  try {
    const writeResult = metricsStore?.writeHostSample(result.sample);
    void Promise.resolve(writeResult).catch(logWriteFailed);
  } catch (err) {
    logWriteFailed(err);
  }
}

export type DaemonWebSocketOptions = {
  developerSurface?: boolean;
  db?: Db;
  secrets?: DaemonJwtKeyring;
  daemonCellRegistry?: DaemonCellRegistry;
  metricsStore?: ServerMetricsStore;
  connectLimiter?: RateLimiter;
  inboundMessageLimit?: number;
  inboundMessageWindowMs?: number;
};

export function registerDaemonWebSocket(
  app: Hono,
  options: DaemonWebSocketOptions,
): void {
  const inboundMessageLimit = options.inboundMessageLimit ?? 120;
  const inboundMessageWindowMs = options.inboundMessageWindowMs ?? 60_000;

  app.get(DAEMON_WS_PATH, async (c, next) => {
    if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
      return c.text("Expected WebSocket", 426);
    }

    const authHeader = c.req.header("authorization")?.trim() ?? "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : "";
    if (!token || !options.secrets) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }
    const payload = await verifyDaemonJwt(token, options.secrets);
    if (!payload) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }

    if (options.connectLimiter) {
      const { success } = await options.connectLimiter.limit({
        key: daemonConnectRateLimitKey(payload.sub),
      });
      if (!success) {
        return c.text("Too Many Requests", 429);
      }
    }

    const db = options.db;
    if (!db) {
      return c.json({ ok: false, error: "Database unavailable" }, 503);
    }

    const registry = options.daemonCellRegistry;
    if (!registry) {
      return c.json(
        { ok: false, error: "Daemon cell registry unavailable" },
        503,
      );
    }

    return upgradeWebSocket((c) => {
      const remoteAddress = c.req.header("x-real-ip")?.trim() ||
        c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
      const identityAddress = remoteAddress ?? "__direct__";
      const connectedAt = new Date().toISOString();

      let connectionId: string | undefined;
      let leaseHolder: string | undefined;
      const pumpControl = { abort: false };
      let attachReady = false;
      const pendingMessages: string[] = [];
      const inboundGate = createInboundWindowGate(
        inboundMessageLimit,
        inboundMessageWindowMs,
      );

      const handleInboundMessage = async (
        raw: string,
        ws: WebSocket,
      ): Promise<void> => {
        if (raw === DAEMON_CELL_PING) {
          await handleDaemonCellPing({
            cell: registry.getCell(payload.sub),
            db,
            serverId: payload.sub,
            connectionId,
            ws,
          });
          return;
        }

        const message = parseDaemonMessage(raw);
        if (!message) {
          compatLogWarn("ws", "ignored non-JSON message from daemon");
          return;
        }

        cellTrace("inbound", {
          serverId: payload.sub,
          conn: connectionId,
          type: message.type,
        });

        if (!DAEMON_INBOUND_ALLOWED.has(message.type)) {
          cellTrace("inbound-disallowed", {
            serverId: payload.sub,
            conn: connectionId,
            type: message.type,
          });
          compatLogWarn(
            "ws",
            `ignored disallowed message type ${message.type} from ${
              connectionId ?? "unknown"
            }`,
          );
          return;
        }

        if (message.type === "metrics") {
          handleMetricsMessage({
            message,
            serverId: payload.sub,
            raw,
            metricsStore: options.metricsStore,
          });
          return;
        }

        const cell = registry.getCell(payload.sub);

        if (message.type === "hello") {
          await touchServerMetadata(db, payload.sub, {
            hostname: message.hostname,
            machineId: message.machineId,
            os: message.os,
          });
          await cell.recordInbound({
            connectionId,
            at: message.at,
            agent: message.agent,
          });
          await onDaemonInbound(db, payload.sub, cell, {
            at: message.at,
            agent: message.agent,
          });
          return;
        }

        if (message.type === "heartbeat") {
          await cell.recordInbound({
            connectionId,
            at: message.at,
            agent: message.agent,
          });
          await onDaemonInbound(db, payload.sub, cell, {
            at: message.at,
            agent: message.agent,
          });
          return;
        }

        await cell.recordInbound({ connectionId, at: message.at });

        const envelope = wireMessageToInboundEnvelope(message);
        if (envelope) {
          const record = await cell.handleInbound(envelope);
          if (envelope.kind === "update-result" && record) {
            await onDaemonUpdateResult(
              db,
              payload.sub,
              envelope.requestId,
              envelope.ok,
              envelope.at,
              envelope.error,
            );
          }
        }
      };

      return {
        async onOpen(_event, ws) {
          const cell = registry.getCell(payload.sub);
          try {
            const attached = await cell.attachDaemonSocket({
              keyId: payload.kid,
              remoteAddress: identityAddress,
              connectedAt,
            });
            connectionId = attached.connectionId;
            leaseHolder = attached.lease.holder;
          } catch (err) {
            daemonCellLog(
              "WARN",
              payload.sub,
              undefined,
              `daemon attach failed: ${String(err)}`,
            );
            ws.close(1013, "attach failed");
            return;
          }

          if (identityAddress === "__direct__") {
            const daemonRow = await getServerDaemonStateByServerId(
              db,
              payload.sub,
            );
            if (!daemonRow) {
              compatLogWarn(
                "ws",
                `colocated daemon ${payload.sub} has no postgres row; forcing re-enroll`,
              );
              pumpControl.abort = true;
              ws.close(4401, "server row missing");
              return;
            }
          }

          const geo = resolveSelfHostedGeo(remoteAddress);
          await onDaemonConnected(
            db,
            payload.sub,
            cell,
            connectedAt,
            undefined,
            geo ?? undefined,
            payload.kid,
          );

          cellTrace("attach", {
            serverId: payload.sub,
            conn: connectionId,
            remoteAddress: identityAddress,
          });

          const connectedFromSuffix = remoteAddress
            ? ` from ${remoteAddress}`
            : "";
          daemonCellLog(
            "INFO",
            payload.sub,
            connectionId,
            `daemon connected${connectedFromSuffix}`,
          );

          if (identityAddress === "__direct__") {
            assignColocatedDaemonOnConnect(db, registry);
          }

          const consumer = `ws:${connectionId}`;

          startDaemonOutboxPump({
            cell,
            serverId: payload.sub,
            connectionId,
            consumer,
            ws,
            abortRef: pumpControl,
          });

          attachReady = true;
          for (const raw of pendingMessages.splice(0)) {
            await handleInboundMessage(raw, ws);
          }
        },
        async onMessage(event, ws) {
          const raw = typeof event.data === "string"
            ? event.data
            : String(event.data);
          const gateKey = connectionId ?? identityAddress;
          if (!inboundGate.allow(gateKey)) {
            cellTrace("inbound-rate-limited", {
              serverId: payload.sub,
              conn: connectionId,
            });
            pendingMessages.length = 0;
            pumpControl.abort = true;
            ws.close(1008, "rate_limited");
            return;
          }
          if (!attachReady) {
            if (pendingMessages.length >= inboundMessageLimit) {
              pendingMessages.length = 0;
              pumpControl.abort = true;
              ws.close(1008, "rate_limited");
              return;
            }
            pendingMessages.push(raw);
            return;
          }
          await handleInboundMessage(raw, ws);
        },
        onClose() {
          pumpControl.abort = true;
          if (connectionId) {
            inboundGate.release(connectionId);
          } else {
            inboundGate.release(identityAddress);
          }
          if (connectionId && leaseHolder) {
            const cell = registry.getCell(payload.sub);
            detachDaemonSocketSafe(
              cell,
              {
                connectionId,
                reason: "closed",
                closedAt: new Date().toISOString(),
              },
              db,
              payload.sub,
              connectionId,
            );
          }
        },
        onError() {
          pumpControl.abort = true;
          if (connectionId) {
            inboundGate.release(connectionId);
          } else {
            inboundGate.release(identityAddress);
          }
          if (connectionId && leaseHolder) {
            const cell = registry.getCell(payload.sub);
            detachDaemonSocketSafe(
              cell,
              {
                connectionId,
                reason: "error",
                closedAt: new Date().toISOString(),
              },
              db,
              payload.sub,
              connectionId,
            );
          }
        },
      };
    })(c, next);
  });

  if (options.developerSurface) {
    registerStubWebSocket(app, DEVELOPER_WS_PATH, "developer");
  }
  registerStubWebSocket(app, CLIENT_WS_PATH, "client");
}

/**
 * Placeholder WebSocket surface for the admin/client UIs. Today the UIs poll
 * REST; these endpoints reserve the namespace for future live streaming. They
 * accept the upgrade, greet the peer, and otherwise idle.
 */
function registerStubWebSocket(app: Hono, path: string, surface: string): void {
  app.get(
    path,
    upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        ws.send(JSON.stringify({
          type: "hello",
          surface,
          at: new Date().toISOString(),
        }));
      },
    })),
  );
}
