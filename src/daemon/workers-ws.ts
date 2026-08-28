import type { Env, Hono } from "hono";
import type { DaemonJwtKeyring } from "./authn/daemon-jwt-keyring.ts";
import { getDb } from "../db.ts";
import { DAEMON_WS_PATH } from "../surfaces.ts";
import { verifyDaemonJwt } from "./authn/daemon-jwt.ts";
import {
  resolveCellLocationHint,
} from "./cell/location.ts";
import { extractCloudflareGeo } from "../lib/geo/server-geo.ts";
import type { RateLimiter } from "./rate-limit/contracts.ts";
import { daemonConnectRateLimitKey } from "./rate-limit/keys.ts";
import { resolvePeerAddress } from "../lib/peer-address.ts";

const CELL_SERVER_ID_HEADER = "X-Turbopanel-Cell-Server-Id";
const CELL_GEO_HEADER = "X-Turbopanel-Cell-Geo";
const REAL_IP_HEADER = "X-Real-IP";

/** Internal headers stamped by the Workers isolate — never pass through from clients. */
const INTERNAL_CELL_FORWARD_HEADERS = [
  CELL_SERVER_ID_HEADER,
  CELL_GEO_HEADER,
  REAL_IP_HEADER,
] as const;

export type WorkersDaemonWebSocketOptions = {
  secrets?: DaemonJwtKeyring;
  /** Cloudflare Rate Limit binding adapter — gates reconnect storms before the DO wakes. */
  connectLimiter?: RateLimiter;
};

export function buildWorkersDaemonCellForwardHeaders(
  inbound: Headers,
  options: {
    serverId: string;
    cf?: unknown;
    cfConnectingIp?: string | null;
  },
): Headers {
  const headers = new Headers(inbound);
  for (const name of INTERNAL_CELL_FORWARD_HEADERS) {
    headers.delete(name);
  }

  headers.set(CELL_SERVER_ID_HEADER, options.serverId);

  const geo = extractCloudflareGeo(options.cf);
  if (geo) {
    headers.set(CELL_GEO_HEADER, JSON.stringify(geo));
  }

  // The edge strips any client-supplied CF-Connecting-IP, so this is the one
  // address a Workers deployment can trust. Same resolver as the Deno
  // transport so both agree on what "peer address" means.
  const peer = resolvePeerAddress(
    { cfConnectingIp: options.cfConnectingIp },
    { runtime: "workers" },
  );
  if (peer) {
    headers.set(REAL_IP_HEADER, peer.address);
  }

  return headers;
}

/**
 * Daemon WebSocket hub for Cloudflare Workers / wrangler dev.
 *
 * Verifies the daemon JWT, then forwards the upgrade request to the per-server
 * Durable Object cell. The native Workers WebSocket lifecycle runs inside the
 * Durable Object (hibernation), so the Postgres presence projection — the
 * equivalent of `onDaemonConnected()` / `onDaemonDisconnected()` and daemon
 * build updates — is driven from `DaemonCellObject` itself rather than here. We stamp
 * the resolved server id onto the forwarded request so the cell resolves its
 * identity consistently across the WS and RPC entry paths.
 */
export function registerWorkersDaemonWebSocket<E extends Env>(
  app: Hono<E>,
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

    const serverId = payload.sub;
    if (options.connectLimiter) {
      const { success } = await options.connectLimiter.limit({
        key: daemonConnectRateLimitKey(serverId),
      });
      if (!success) {
        return new Response("Too Many Requests", { status: 429 });
      }
    }

    const db = getDb(c);
    if (db === undefined) {
      return new Response("Database unavailable", { status: 503 });
    }

    const locationHint = await resolveCellLocationHint(db, serverId);
    const logicalName = serverId;

    const env = c.env as CloudflareBindings;
    const stub = locationHint
      ? env.DAEMON_CELL.getByName(logicalName, {
        locationHint: locationHint as DurableObjectLocationHint,
      })
      : env.DAEMON_CELL.getByName(logicalName);

    const headers = buildWorkersDaemonCellForwardHeaders(c.req.raw.headers, {
      serverId,
      cf: (c.req.raw as Request & { cf?: unknown }).cf,
      cfConnectingIp: c.req.header("CF-Connecting-IP"),
    });

    return stub.fetch(new Request(c.req.raw, { headers }));
  });
}
