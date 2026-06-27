import type { Hono } from "hono";
import type { DerivedSecretsConfig } from "../client/authn/secrets.ts";
import { getDb } from "../db.ts";
import { DAEMON_WS_PATH } from "../surfaces.ts";
import { verifyDaemonJwt } from "./authn/daemon-jwt.ts";
import {
  resolveCellLocationHint,
} from "./cell/location.ts";

const CELL_SERVER_ID_HEADER = "X-Turbopanel-Cell-Server-Id";

export type WorkersDaemonWebSocketOptions = {
  secrets?: DerivedSecretsConfig;
};

/**
 * Daemon WebSocket hub for Cloudflare Workers / wrangler dev.
 *
 * Verifies the daemon JWT, then forwards the upgrade request to the per-server
 * Durable Object cell. The native Workers WebSocket lifecycle runs inside the
 * Durable Object (hibernation), so the Postgres presence projection — the
 * equivalent of `onDaemonConnected()` / `onDaemonDisconnected()` and agent
 * updates — is driven from `DaemonCellObject` itself rather than here. We stamp
 * the resolved server id onto the forwarded request so the cell resolves its
 * identity consistently across the WS and RPC entry paths.
 */
export function registerWorkersDaemonWebSocket(
  app: Hono,
  options: WorkersDaemonWebSocketOptions,
): void {
  app.get(DAEMON_WS_PATH, async (c) => {
    if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
      return c.text("Expected WebSocket", 426);
    }

    const authHeader = c.req.header("authorization")?.trim() ?? "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : "";
    if (!token || !options.secrets) {
      return new Response("Unauthorized", { status: 401 });
    }
    const payload = await verifyDaemonJwt(token, options.secrets);
    if (!payload) {
      return new Response("Unauthorized", { status: 401 });
    }

    const db = getDb(c);
    if (db === undefined) {
      return new Response("Database unavailable", { status: 503 });
    }

    const serverId = payload.sub;
    const locationHint = await resolveCellLocationHint(db, serverId);
    const logicalName = serverId;

    const env = c.env as CloudflareBindings;
    const stub = locationHint
      ? env.DAEMON_CELL.getByName(logicalName, {
        locationHint: locationHint as DurableObjectLocationHint,
      })
      : env.DAEMON_CELL.getByName(logicalName);

    const headers = new Headers(c.req.raw.headers);
    headers.set(CELL_SERVER_ID_HEADER, serverId);
    return stub.fetch(new Request(c.req.raw, { headers }));
  });
}
