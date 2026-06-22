import type { WSContext } from "hono/ws";
import type { DerivedSecretsConfig } from "../client/authn/secrets.ts";
import {
  DAEMON_INBOUND_ALLOWED,
  type DaemonMessage,
  evictDuplicateDaemons,
  parseDaemonMessage,
  pruneStaleDaemons,
  recordAddressesResult,
  recordCommandResult,
  recordDaemonAck,
  recordDaemonMessage,
  registerDaemon,
  setDaemonAuthenticated,
  setDaemonKeyId,
  setDaemonRemoteAddress,
  setDaemonServerId,
  touchDaemonInbound,
  unregisterDaemon,
} from "./hub.ts";
import type { Db } from "../db.ts";
import { tryAssignColocatedDaemonToInstalledOrganization } from "../client/authn/install-state.ts";
import { touchDaemonSessionLastUsed } from "./authn/daemon-session-db.ts";
import { compatLogError, compatLogInfo, compatLogWarn } from "../log-compat.ts";

let pruneTimer: ReturnType<typeof setInterval> | undefined;

function runPruneCycle(): void {
  const pruned = pruneStaleDaemons();
  if (pruned.length > 0) {
    compatLogInfo(
      "ws",
      `pruned ${pruned.length} stale daemon connection(s): ${
        pruned.join(", ")
      }`,
    );
  }
}

function ensurePruneTimer(): void {
  if (pruneTimer) return;
  pruneTimer = setInterval(runPruneCycle, 15_000);
}

export type DaemonWebSocketOptions = {
  developerSurface?: boolean;
  db?: Db;
  secrets?: DerivedSecretsConfig;
};

export type DaemonWebSocketIdentity = {
  serverId: string;
  keyId: string;
  sessionId: string;
};

export type DaemonWebSocketSession = {
  onMessage: (event: MessageEvent, ws: WSContext) => void;
  onClose: () => void;
  onError: () => void;
};

export type DaemonWebSocketConnectMeta = {
  /** From X-Real-IP / X-Forwarded-For; omit for direct Unix-socket dials. */
  remoteAddress?: string;
};

/** Shared daemon hub logic for Deno and Workers WebSocket upgrades. */
export function createDaemonWebSocketSession(
  ws: WSContext,
  { db }: DaemonWebSocketOptions,
  identity: DaemonWebSocketIdentity,
  { remoteAddress }: DaemonWebSocketConnectMeta = {},
): DaemonWebSocketSession {
  let connId: string | undefined;
  let identityAddress = remoteAddress ?? "__direct__";
  let pingTimer: ReturnType<typeof setInterval> | undefined;

  ensurePruneTimer();
  const conn = registerDaemon(
    (data) => ws.send(data),
    () => ws.close(),
  );
  connId = conn.id;
  identityAddress = remoteAddress ?? "__direct__";
  setDaemonRemoteAddress(conn.id, identityAddress);

  connId = setDaemonServerId(conn.id, identity.serverId);
  const activeId = connId ?? conn.id;
  setDaemonKeyId(activeId, identity.keyId);
  setDaemonAuthenticated(activeId);

  if (db) {
    touchDaemonSessionLastUsed(db, identity.sessionId).catch((err) => {
      compatLogWarn(
        "ws",
        `failed to touch daemon session ${identity.sessionId}: ${String(err)}`,
      );
    });
  }

  compatLogInfo(
    "ws",
    `daemon connected: ${conn.id}${
      remoteAddress ? ` from ${remoteAddress}` : ""
    }`,
  );

  const startPingTimer = () => {
    if (pingTimer) return;
    pingTimer = setInterval(() => {
      const ping: DaemonMessage = {
        type: "ping",
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
      };
      ws.send(JSON.stringify(ping));
    }, 15_000);
  };

  const evicted = evictDuplicateDaemons(activeId, {
    serverId: identity.serverId,
    remoteAddress: identityAddress,
  });
  if (evicted.length > 0) {
    compatLogInfo(
      "ws",
      `evicted ${evicted.length} duplicate connection(s) for ${
        identity.serverId ?? activeId
      }`,
    );
  }

  if (identityAddress === "__direct__" && db) {
    void tryAssignColocatedDaemonToInstalledOrganization(db).catch((err) => {
      compatLogError("ws", `failed to assign colocated server: ${err}`);
    });
  }

  startPingTimer();

  const onMessage = (event: MessageEvent, ws: WSContext) => {
    const raw = typeof event.data === "string"
      ? event.data
      : String(event.data);
    const message = parseDaemonMessage(raw);
    if (!message) {
      compatLogWarn("ws", "ignored non-JSON message from daemon");
      return;
    }

    compatLogInfo("ws", `from ${connId ?? "unknown"}: ${message.type}`);
    if (connId) {
      touchDaemonInbound(connId);
      recordDaemonMessage(connId, "in", message);
    }

    if (!DAEMON_INBOUND_ALLOWED.has(message.type)) {
      compatLogWarn(
        "ws",
        `ignored disallowed message type ${message.type} from ${
          connId ?? "unknown"
        }`,
      );
      return;
    }

    if (message.type === "ping") {
      const pong: DaemonMessage = {
        type: "pong",
        id: message.id,
        at: new Date().toISOString(),
      };
      if (connId) recordDaemonMessage(connId, "out", pong);
      ws.send(JSON.stringify(pong));
    }

    if (message.type === "command-result") {
      recordCommandResult(message);
    }

    if (message.type === "addresses-result") {
      recordAddressesResult(message);
    }

    if (
      message.type === "dev-sync-result" ||
      message.type === "tunnel-token-result" ||
      message.type === "update-result"
    ) {
      recordDaemonAck(message.id, message.ok, message.error);
    }
  };

  const cleanup = () => {
    if (pingTimer) clearInterval(pingTimer);
    if (connId) {
      unregisterDaemon(connId);
      compatLogInfo("ws", `daemon disconnected: ${connId}`);
    }
  };

  return {
    onMessage,
    onClose: cleanup,
    onError: cleanup,
  };
}
