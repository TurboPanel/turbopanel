import type { Hono } from "hono";
import { upgradeWebSocket } from "hono/deno";
import type { DaemonCellRegistry } from "./cell/contracts.ts";
import {
  DAEMON_CELL_PING,
  DAEMON_CELL_PONG,
  DAEMON_INBOUND_ALLOWED,
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
import { verifyDaemonJwt } from "./authn/daemon-jwt.ts";
import { getServerDaemonStateByServerId } from "./authn/server-identity-db.ts";

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


export type DaemonWebSocketOptions = {
  developerSurface?: boolean;
  db?: Db;
  secrets?: DaemonJwtKeyring;
  daemonCellRegistry?: DaemonCellRegistry;
};

export function registerDaemonWebSocket(
  app: Hono,
  options: DaemonWebSocketOptions,
): void {
  app.get(DAEMON_WS_PATH, async (c, next) => {
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

      const handleInboundMessage = async (
        raw: string,
        ws: WebSocket,
      ): Promise<void> => {
        if (raw === DAEMON_CELL_PING) {
          const cell = registry.getCell(payload.sub);
          cellTrace("ping", {
            serverId: payload.sub,
            conn: connectionId,
          });
          ws.send(DAEMON_CELL_PONG);
          cellTrace("pong", {
            serverId: payload.sub,
            conn: connectionId,
          });
          await cell.recordInbound({
            connectionId,
            at: new Date().toISOString(),
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

        const cell = registry.getCell(payload.sub);

        if (message.type === "hello") {
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
            const daemonRow = await getServerDaemonStateByServerId(db, payload.sub);
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

          daemonCellLog(
            "INFO",
            payload.sub,
            connectionId,
            `daemon connected${
              remoteAddress ? ` from ${remoteAddress}` : ""
            }`,
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
          if (!attachReady) {
            pendingMessages.push(raw);
            return;
          }
          await handleInboundMessage(raw, ws);
        },
        onClose() {
          pumpControl.abort = true;
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
