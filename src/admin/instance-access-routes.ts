import type { Hono } from "hono";
import type { AppEnv } from "../app/app.ts";
import { getDaemonCellRegistry, getDb } from "../db/connection.ts";
import { resolveColocatedServerId } from "../client/authn/install-state.ts";
import { getCommandQueue } from "../features/commands/queue.ts";
import {
  DEFAULT_TRUSTED_PROXY_CIDRS,
  parseTrustedProxyCidrs,
} from "../lib/peer-address.ts";
import { parseCertificatePem } from "../lib/tls/parse.ts";
import { resolveDaemonCapabilities } from "../lib/version-wire.ts";
import {
  dispatchInstanceTunnelToken,
  parseTunnelTokenBody,
} from "../developer/tunnel-token.ts";
import { resolvePlatformEnv } from "./routes-helpers.ts";
import { enqueuePlatformCaTrustReconcile } from "./tls-trust-reconcile.ts";

const PLATFORM_CA_RUNTIME_ERROR =
  "platform CA is not available on this runtime";

function emptyDaemonCapabilities() {
  return {
    applicable: true as const,
    connected: false,
    serverId: null,
    version: null,
    capabilities: resolveDaemonCapabilities(null),
  };
}

/**
 * Admin reads and actions for how people and machines reach this control
 * plane. Mounted beside the hostname routes. Nothing here reads or writes
 * an organization's ACME opt-in or `tls` rows.
 */
export function registerInstanceAccessAdminRoutes(
  admin: Hono<AppEnv>,
  opts: {
    runtime: "deno" | "workers";
    getEnv?: () => Record<string, string | undefined>;
    readPlatformCaBundle?: () => Promise<string>;
  },
): void {
  admin.get("/instance/daemon", async (c) => {
    if (opts.runtime === "workers") {
      return c.json({ applicable: false });
    }
    const db = getDb(c);
    const registry = getDaemonCellRegistry(c);
    if (!db || !registry) return c.json(emptyDaemonCapabilities());
    const serverId = await resolveColocatedServerId(db, registry);
    if (!serverId) return c.json(emptyDaemonCapabilities());
    const snapshots = await registry.getSnapshots([serverId]);
    const snapshot = snapshots.get(serverId);
    const version = snapshot?.daemonBuild?.version ?? null;
    return c.json({
      applicable: true,
      connected: snapshot?.connected === true,
      serverId,
      version,
      capabilities: resolveDaemonCapabilities(version),
    });
  });

  admin.get("/instance/platform-ca", async (c) => {
    if (opts.runtime !== "deno") {
      return c.json({ ok: false, error: PLATFORM_CA_RUNTIME_ERROR }, 422);
    }
    return c.json(await readPlatformCaInfo(opts.readPlatformCaBundle));
  });

  admin.post("/instance/platform-ca/trust-reconcile", async (c) => {
    if (opts.runtime !== "deno") {
      return c.json({ ok: false, error: PLATFORM_CA_RUNTIME_ERROR }, 422);
    }
    const db = getDb(c);
    if (!db) return c.json({ ok: false, error: "Database unavailable" }, 503);
    const commandQueue = getCommandQueue(c);
    const actorId = c.get("session")?.userId;
    if (!commandQueue || !actorId || !opts.readPlatformCaBundle) {
      return c.json({ ok: false, error: "Command queue unavailable" }, 503);
    }
    try {
      const { enqueued } = await enqueuePlatformCaTrustReconcile({
        db,
        commandQueue,
        actorId,
        readBundle: opts.readPlatformCaBundle,
      });
      return c.json({ ok: true, enqueued });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, error: message }, 503);
    }
  });

  admin.get("/instance/trusted-proxies", (c) => {
    const raw = resolvePlatformEnv(c, opts).TURBOPANEL_TRUSTED_PROXY_CIDRS;
    const cidrs = parseTrustedProxyCidrs(raw);
    return c.json({ cidrs, isDefault: trustedProxiesAreDefault(cidrs) });
  });

  admin.post("/instance/tunnel-token", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = parseTunnelTokenBody(body);
    if (!parsed.ok) {
      return c.json({ ok: false, error: "expected { token: string }" }, 400);
    }
    const db = getDb(c);
    if (!db) return c.json({ ok: false, error: "Database unavailable" }, 503);
    const registry = getDaemonCellRegistry(c);
    if (!registry) {
      return c.json({ ok: false, error: "Daemon cell registry unavailable" }, 503);
    }
    const result = await dispatchInstanceTunnelToken({
      db,
      registry,
      token: parsed.token,
      secretsConfig: c.get("secretsConfig"),
    });
    if (!result.ok) return c.json({ ok: false, error: result.error }, result.status);
    return c.json({ ok: true });
  });
}

async function readPlatformCaInfo(
  readBundle: (() => Promise<string>) | undefined,
): Promise<
  | { ok: false }
  | {
    ok: true;
    fingerprintSha256: string;
    subject: string;
    notBefore: string;
    notAfter: string;
    pem: string;
  }
> {
  if (!readBundle) return { ok: false };
  try {
    const pem = await readBundle();
    const parsed = await parseCertificatePem(pem);
    return {
      ok: true,
      fingerprintSha256: parsed.fingerprintSha256,
      subject: parsed.subject,
      notBefore: parsed.notBefore.toISOString(),
      notAfter: parsed.notAfter.toISOString(),
      pem,
    };
  } catch {
    return { ok: false };
  }
}

function trustedProxiesAreDefault(cidrs: readonly string[]): boolean {
  const defaults = DEFAULT_TRUSTED_PROXY_CIDRS;
  if (cidrs.length !== defaults.length) return false;
  return cidrs.every((cidr, index) => cidr === defaults[index]);
}
