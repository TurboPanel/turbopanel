/**
 * Attach acknowledgement the control plane sends on `/ws/daemon/v1` once the
 * cell lease is held. `instanceVersion` is `INSTANCE_VERSION`. Older daemons
 * ignore the extra field; a daemon that never sees it treats the peer as
 * `unknown` (see turbopaneld `src/instance/version-wire.ts`).
 *
 * Workers and Deno both import this module — no Deno APIs.
 */
import { resolveInstanceRevision } from "../app/build-info.ts";
import { INSTANCE_VERSION } from "../app/version.ts";
import { DAEMON_WIRE_FEATURES } from "../lib/version-wire.ts";

export type InstanceAttachVersionFrame = {
  type: "version";
  commit: string;
  branch: string;
  at: string;
  instanceVersion: string;
  /** Advertised control-plane features. See `DAEMON_WIRE_FEATURES`. */
  features: readonly string[];
};

function revisionEnv(
  env: object | undefined,
): { TURBOPANEL_REVISION?: string } | undefined {
  if (!env || !("TURBOPANEL_REVISION" in env)) return undefined;
  const value = (env as { TURBOPANEL_REVISION?: unknown }).TURBOPANEL_REVISION;
  if (typeof value !== "string") return undefined;
  return { TURBOPANEL_REVISION: value };
}

export function instanceAttachVersionFrame(
  at: string,
  env?: object,
): InstanceAttachVersionFrame {
  const revision = resolveInstanceRevision(revisionEnv(env));
  return {
    type: "version",
    commit: revision.commit,
    branch: "unknown",
    at,
    instanceVersion: INSTANCE_VERSION,
    features: [...DAEMON_WIRE_FEATURES],
  };
}
