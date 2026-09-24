/**
 * Maintenance-tick entry. Resolves channel manifests (cached), maybe starts
 * an automatic run, then advances the active run. Hello handlers do not
 * enqueue; this is the path that does.
 */
import { INSTANCE_VERSION } from "../../app/version.ts";
import { resolveInstanceRevision } from "../../app/build-info.ts";
import { resolveColocatedServerId } from "../../client/authn/install-state.ts";
import type { DaemonCellRegistry } from "../../contracts/cell.ts";
import { resolveInstanceUpdateChannel } from "../../contracts/update-channel.ts";
import type { Db } from "../../db/connection.ts";
import { isExplicitDevelopmentMode } from "../../lib/dev-mode.ts";
import { createUpgradeCoordinator } from "./coordinator.ts";
import { createDrizzleUpgradeStore } from "./store.ts";
import type { UpgradeRuntime } from "./planner.ts";

export async function runUpgradeMaintenance(input: {
  db: Db;
  registry: DaemonCellRegistry | null;
  runtime: UpgradeRuntime;
  resolveManifests: boolean;
  env?: Record<string, string | undefined>;
}): Promise<void> {
  const env = input.env ??
    (typeof Deno === "undefined" ? {} : Deno.env.toObject());
  const channel = resolveInstanceUpdateChannel(env);
  const revision = resolveInstanceRevision(env);
  const colocated = input.registry
    ? await resolveColocatedServerId(input.db, input.registry)
    : null;
  const coordinator = createUpgradeCoordinator({
    store: createDrizzleUpgradeStore(input.db, input.registry),
    enqueue: async (serverId, envelope) => {
      if (!input.registry) return;
      await input.registry.getCell(serverId).enqueue(envelope);
    },
    runtime: input.runtime,
    channel,
    development: isExplicitDevelopmentMode(),
    now: () => new Date().toISOString(),
    colocatedServerId: colocated,
    instanceInstalled: { version: INSTANCE_VERSION, commit: revision.commit },
  });
  await coordinator.tick({ resolveManifests: input.resolveManifests });
}
