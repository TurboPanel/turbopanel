import type { Context, Hono } from "hono";
import type { AppEnv } from "../app/app.ts";
import { resolveInstanceRevision } from "../app/build-info.ts";
import { INSTANCE_VERSION } from "../app/version.ts";
import { resolveColocatedServerId } from "../client/authn/install-state.ts";
import type { DaemonCellRegistry } from "../contracts/cell.ts";
import type { DaemonOutboundEnvelope } from "../contracts/cell-protocol.ts";
import {
  generateDeliveryId,
  generateRequestId,
} from "../contracts/cell-protocol.ts";
import {
  resolveInstanceUpdateChannel,
  type UpdateChannel,
} from "../contracts/update-channel.ts";
import { getDaemonCellRegistry, getDb } from "../db/connection.ts";
import { resolveUpdateManifest } from "../features/update/manifest.ts";
import { resolvePlatformEnv } from "./routes-helpers.ts";

const INSTANCE_UPDATE_RUNTIME_ERROR =
  "control-plane update is not applicable on this runtime";

const NO_DAEMON_ERROR =
  "no co-located daemon connected to update the control plane";

const DAEMON_DISCONNECTED_ERROR = "co-located daemon disconnected";

type ColocatedDaemon = {
  serverId: string | null;
  connected: boolean;
  version: string | null;
  commit: string | null;
};

function isInstancePackageChannel(
  channel: UpdateChannel,
): channel is "canary" | "rc" | "release" {
  return channel === "canary" || channel === "rc" || channel === "release";
}

function instanceChannelError(channel: UpdateChannel): string {
  return `This control plane follows ${channel}, which has no control-plane package. Use canary, rc, or release.`;
}

async function readColocatedDaemon(
  c: Context<AppEnv>,
): Promise<ColocatedDaemon> {
  const empty: ColocatedDaemon = {
    serverId: null,
    connected: false,
    version: null,
    commit: null,
  };
  const db = getDb(c);
  const registry = getDaemonCellRegistry(c);
  if (!db || !registry) return empty;
  const serverId = await resolveColocatedServerId(db, registry);
  if (!serverId) return empty;
  const snapshots = await registry.getSnapshots([serverId]);
  const snapshot = snapshots.get(serverId);
  const build = snapshot?.daemonBuild;
  return {
    serverId,
    connected: snapshot?.connected === true,
    version: build?.version ?? null,
    commit: build?.commit ?? null,
  };
}

function updateEnvelope(
  kind: "update" | "instance-update",
  channel: UpdateChannel,
  extra: {
    targetVersion?: string;
    manifestUrl?: string;
    uiManifestUrl?: string;
  } = {},
): DaemonOutboundEnvelope {
  const pins = kind === "instance-update"
    ? {
      ...(extra.manifestUrl ? { manifestUrl: extra.manifestUrl } : {}),
      ...(extra.uiManifestUrl ? { uiManifestUrl: extra.uiManifestUrl } : {}),
    }
    : {};
  return {
    kind,
    deliveryId: generateDeliveryId(),
    requestId: generateRequestId(),
    at: new Date().toISOString(),
    channel,
    ...(extra.targetVersion ? { targetVersion: extra.targetVersion } : {}),
    ...pins,
  };
}

async function enqueueUpdate(
  registry: DaemonCellRegistry,
  serverId: string,
  envelope: DaemonOutboundEnvelope,
): Promise<void> {
  await registry.getCell(serverId).enqueue(envelope);
}

/**
 * Installed versions and channel targets for the control plane and the
 * co-located daemon, plus the two upgrade dispatches.
 *
 * The control-plane row is `INSTANCE_VERSION` — the same value `/api/health`
 * stamps. The UI export is installed by the same `run.sh --instance` run and
 * is not a separate version. `POST …/instance` returns as soon as the cell
 * message is queued: the install restarts the control plane, so the caller
 * must not wait for it. `POST …/daemon` enqueues the existing daemon `update`
 * for the co-located host specifically (the per-server route refuses that
 * host).
 */
export function registerInstanceUpdatesAdminRoutes(
  admin: Hono<AppEnv>,
  opts: {
    runtime: "deno" | "workers";
    getEnv?: () => Record<string, string | undefined>;
  },
): void {
  admin.get("/instance/updates", async (c) => {
    const env = resolvePlatformEnv(c, opts);
    const channel = resolveInstanceUpdateChannel(env);
    const revision = resolveInstanceRevision(env);
    const [instanceTarget, uiTarget, daemonTarget, daemon] = await Promise.all([
      resolveUpdateManifest(channel, "instance"),
      resolveUpdateManifest(channel, "ui"),
      resolveUpdateManifest(channel, "daemon"),
      readColocatedDaemon(c),
    ]);
    return c.json({
      ok: true,
      channel,
      units: {
        instance: {
          installed: { version: INSTANCE_VERSION, commit: revision.commit },
          target: instanceTarget,
          uiTarget,
        },
        daemon: {
          installed: daemon.serverId
            ? { version: daemon.version, commit: daemon.commit }
            : null,
          target: daemonTarget,
          serverId: daemon.serverId,
          connected: daemon.connected,
        },
      },
    });
  });

  admin.post("/instance/updates/instance", async (c) => {
    if (opts.runtime === "workers") {
      return c.json({ ok: false, error: INSTANCE_UPDATE_RUNTIME_ERROR }, 422);
    }
    const channel = resolveInstanceUpdateChannel(resolvePlatformEnv(c, opts));
    if (!isInstancePackageChannel(channel)) {
      return c.json({ ok: false, error: instanceChannelError(channel) }, 422);
    }
    const refused = await refuseWithoutConnectedDaemon(c);
    if (refused) return refused;
    const [target, uiTarget] = await Promise.all([
      resolveUpdateManifest(channel, "instance"),
      resolveUpdateManifest(channel, "ui"),
    ]);
    const registry = getDaemonCellRegistry(c);
    const daemon = await readColocatedDaemon(c);
    if (!registry || !daemon.serverId) {
      return c.json({ ok: false, error: NO_DAEMON_ERROR }, 503);
    }
    await enqueueUpdate(
      registry,
      daemon.serverId,
      updateEnvelope("instance-update", channel, {
        ...(target?.version ? { targetVersion: target.version } : {}),
        ...(target?.manifestUrl ? { manifestUrl: target.manifestUrl } : {}),
        ...(uiTarget?.manifestUrl
          ? { uiManifestUrl: uiTarget.manifestUrl }
          : {}),
      }),
    );
    return c.json({ ok: true, dispatched: true }, 202);
  });

  admin.post("/instance/updates/daemon", async (c) => {
    const channel = resolveInstanceUpdateChannel(resolvePlatformEnv(c, opts));
    const refused = await refuseWithoutConnectedDaemon(c);
    if (refused) return refused;
    const registry = getDaemonCellRegistry(c);
    const daemon = await readColocatedDaemon(c);
    if (!registry || !daemon.serverId) {
      return c.json({ ok: false, error: NO_DAEMON_ERROR }, 503);
    }
    await enqueueUpdate(
      registry,
      daemon.serverId,
      updateEnvelope("update", channel),
    );
    return c.json({ ok: true, dispatched: true }, 202);
  });
}

async function refuseWithoutConnectedDaemon(
  c: Context<AppEnv>,
): Promise<Response | null> {
  const db = getDb(c);
  if (!db) return c.json({ ok: false, error: "Database unavailable" }, 503);
  const registry = getDaemonCellRegistry(c);
  if (!registry) {
    return c.json(
      { ok: false, error: "Daemon cell registry unavailable" },
      503,
    );
  }
  const daemon = await readColocatedDaemon(c);
  if (!daemon.serverId) {
    return c.json({ ok: false, error: NO_DAEMON_ERROR }, 503);
  }
  if (!daemon.connected) {
    return c.json({ ok: false, error: DAEMON_DISCONNECTED_ERROR }, 503);
  }
  return null;
}
