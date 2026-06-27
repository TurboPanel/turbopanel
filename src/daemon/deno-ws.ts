import type { Hono } from "hono";
import { upgradeWebSocket } from "hono/deno";
import type { DaemonCellRegistry } from "./cell/contracts.ts";
import {
  DAEMON_INBOUND_ALLOWED,
  type DaemonMessage,
  generateDeliveryId,
  generateRequestId,
  outboundEnvelopeToWireMessage,
  parseDaemonMessage,
  wireMessageToInboundEnvelope,
} from "./cell/protocol.ts";
import type { DerivedSecretsConfig } from "../client/authn/secrets.ts";
import { tryAssignColocatedDaemonToInstalledOrganization } from "../client/authn/install-state.ts";
import type { Db } from "../db.ts";
import { compatLogError, compatLogInfo, compatLogWarn } from "../log-compat.ts";
import {
  onDaemonConnected,
  onMonitorMessageApplied,
} from "./cell/control-plane-monitor.ts";
import { incrementMonitorCounter } from "./cell/monitor-observability.ts";
import {
  CLIENT_WS_PATH,
  DAEMON_WS_PATH,
  DEVELOPER_WS_PATH,
} from "../surfaces.ts";
import { verifyDaemonJwt } from "./authn/daemon-jwt.ts";

export type DaemonWebSocketOptions = {
  developerSurface?: boolean;
  db?: Db;
  secrets?: DerivedSecretsConfig;
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
      let leaseToken: string | undefined;
      let pumpAbort = false;
      let pingTimer: ReturnType<typeof setInterval> | undefined;
      let keyTouched = false;
      let attachReady = false;
      const pendingMessages: string[] = [];

      const touchKey = () => {
        if (keyTouched) return;
        keyTouched = true;
        const now = new Date().toISOString();
        registry.getCell(payload.sub).putSnapshot({ keyLastUsedAt: now }).catch(
          (err) => {
            compatLogWarn(
              "ws",
              `failed to touch daemon key for ${payload.sub}: ${String(err)}`,
            );
          },
        );
      };

      const handleInboundMessage = async (
        raw: string,
        ws: WebSocket,
      ): Promise<void> => {
        const message = parseDaemonMessage(raw);
        if (!message) {
          compatLogWarn("ws", "ignored non-JSON message from daemon");
          return;
        }

        compatLogInfo(
          "ws",
          `from ${connectionId ?? "unknown"}: ${message.type}`,
        );

        if (!DAEMON_INBOUND_ALLOWED.has(message.type)) {
          compatLogWarn(
            "ws",
            `ignored disallowed message type ${message.type} from ${
              connectionId ?? "unknown"
            }`,
          );
          return;
        }

        const cell = registry.getCell(payload.sub);

        if (message.type === "ping") {
          const pong: DaemonMessage = {
            type: "pong",
            id: message.id,
            at: new Date().toISOString(),
          };
          ws.send(JSON.stringify(pong));
          if (connectionId) {
            void cell.heartbeat({ connectionId });
            void cell.putSnapshot({ lastInboundAt: message.at });
          }
          touchKey();
          return;
        }

        const envelope = wireMessageToInboundEnvelope(message);
        if (
          envelope?.kind === "monitor-sync" ||
          envelope?.kind === "monitor-heartbeat" ||
          envelope?.kind === "monitor-transition"
        ) {
          let acceptedSequence = 0;
          let resyncNeeded = false;
          if (envelope.kind === "monitor-sync") {
            incrementMonitorCounter("monitorFullSync");
            const result = await cell.applyMonitorSync(envelope);
            acceptedSequence = result.acceptedSequence;
            resyncNeeded = result.resyncNeeded;
            if (!result.resyncNeeded) {
              await onMonitorMessageApplied(
                db,
                payload.sub,
                cell,
                "monitor-sync",
                envelope,
              );
            }
          } else if (envelope.kind === "monitor-heartbeat") {
            const result = await cell.applyMonitorHeartbeat(envelope);
            acceptedSequence = result.acceptedSequence;
            resyncNeeded = result.resyncNeeded;
            if (!result.resyncNeeded) {
              await onMonitorMessageApplied(
                db,
                payload.sub,
                cell,
                "monitor-heartbeat",
                envelope,
              );
            }
          } else {
            const result = await cell.applyMonitorTransition(envelope);
            acceptedSequence = result.acceptedSequence;
            resyncNeeded = result.resyncNeeded;
            if (!result.resyncNeeded) {
              await onMonitorMessageApplied(
                db,
                payload.sub,
                cell,
                "monitor-transition",
                envelope,
              );
            }
          }

          await cell.putSnapshot({
            lastHeartbeatAt: new Date().toISOString(),
          });

          const ackWire = outboundEnvelopeToWireMessage({
            kind: "monitor-ack",
            serverId: payload.sub,
            acceptedSequence,
            resyncNeeded: resyncNeeded || undefined,
            deliveryId: generateDeliveryId(),
            requestId: generateRequestId(),
            at: new Date().toISOString(),
          });
          ws.send(JSON.stringify(ackWire));

          compatLogInfo(
            "ws",
            `monitor ack for ${payload.sub}: acceptedSequence=${acceptedSequence}${
              resyncNeeded ? ", resyncNeeded" : ""
            }`,
          );
          touchKey();
          return;
        }

        if (envelope) {
          void cell.handleInbound(envelope);
          void cell.putSnapshot({ lastInboundAt: message.at });
        }

        if (message.type === "pong" && connectionId) {
          void cell.heartbeat({ connectionId });
        }

        touchKey();
      };

      return {
        async onOpen(_event, ws) {
          const cell = registry.getCell(payload.sub);
          const attached = await cell.attachDaemonSocket({
            keyId: payload.kid,
            sessionId: payload.jti,
            hostname: undefined,
            remoteAddress: identityAddress,
            connectedAt,
          });
          connectionId = attached.connectionId;
          leaseToken = attached.lease.token;

          await onDaemonConnected(db, payload.sub, cell, connectedAt);

          compatLogInfo(
            "ws",
            `daemon connected: ${connectionId}${
              remoteAddress ? ` from ${remoteAddress}` : ""
            }`,
          );

          touchKey();

          if (identityAddress === "__direct__") {
            void tryAssignColocatedDaemonToInstalledOrganization(db, registry)
              .catch((err) => {
                compatLogError(
                  "ws",
                  "failed to assign colocated server:",
                  String(err),
                );
              });
          }

          const consumer = `ws:${connectionId}`;

          const outboxPump = async () => {
            while (!pumpAbort) {
              try {
                const batch = await cell.readOutboxBatch({
                  consumer,
                  count: 50,
                  blockMs: 15_000,
                });
                for (const envelope of batch) {
                  const wireMsg = outboundEnvelopeToWireMessage(envelope);
                  await cell.markSent(envelope.deliveryId, connectionId!);
                  ws.send(JSON.stringify(wireMsg));
                  await cell.ackOutbox([envelope.deliveryId], consumer);
                }
                if (batch.length > 0) {
                  await cell.putSnapshot({
                    lastOutboundAt: new Date().toISOString(),
                  });
                }
              } catch (err) {
                if (!pumpAbort) {
                  compatLogWarn("ws", `outbox pump error: ${String(err)}`);
                }
              }
            }
          };
          void outboxPump();

          pingTimer = setInterval(() => {
            void cell.enqueue({
              kind: "ping",
              deliveryId: generateDeliveryId(),
              requestId: generateRequestId(),
              at: new Date().toISOString(),
            });
          }, 15_000);

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
          pumpAbort = true;
          if (pingTimer) clearInterval(pingTimer);
          if (connectionId && leaseToken) {
            void registry.getCell(payload.sub).detachDaemonSocket({
              connectionId,
              leaseToken,
              reason: "closed",
              closedAt: new Date().toISOString(),
            }).then(() => {
              compatLogInfo("ws", `daemon disconnected: ${connectionId}`);
            });
          }
        },
        onError() {
          pumpAbort = true;
          if (pingTimer) clearInterval(pingTimer);
          if (connectionId && leaseToken) {
            void registry.getCell(payload.sub).detachDaemonSocket({
              connectionId,
              leaseToken,
              reason: "error",
              closedAt: new Date().toISOString(),
            }).then(() => {
              compatLogInfo("ws", `daemon disconnected: ${connectionId}`);
            });
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
