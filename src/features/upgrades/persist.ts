/**
 * Postgres writes from hello / progress / result frames. These never enqueue.
 * The maintenance tick is what advances a run after a step is marked done.
 */
import type { UpdateProgressStage } from "../../contracts/cell-protocol.ts";
import type { Db } from "../../db/connection.ts";
import type { UpdateChannel } from "../../contracts/update-channel.ts";
import { createUpgradeCoordinator } from "./coordinator.ts";
import { createDrizzleUpgradeStore } from "./store.ts";
import type { UpgradeStepUnit } from "./vocabulary.ts";

function writer(db: Db) {
  return createUpgradeCoordinator({
    store: createDrizzleUpgradeStore(db, null),
    enqueue: () => Promise.resolve(),
    runtime: "deno",
    channel: "release" satisfies UpdateChannel,
    development: false,
    now: () => new Date().toISOString(),
    colocatedServerId: null,
    instanceInstalled: { version: "0.0.0", commit: null },
  });
}

/** A hello/heartbeat commit that matches the active daemon step marks it done. */
export async function persistDaemonReachedTarget(
  db: Db,
  serverId: string,
  commit: string,
  at: string,
): Promise<void> {
  try {
    await writer(db).noteDaemonCommit(serverId, commit, at);
  } catch {
    // A missing upgrade table must not drop the socket.
  }
}

export async function persistUpgradeProgress(
  db: Db,
  input: {
    serverId: string;
    upgradeId?: string;
    unit: UpgradeStepUnit;
    stage: UpdateProgressStage;
    at: string;
    detail?: string;
    errorCode?: string;
    requestId: string;
  },
): Promise<void> {
  try {
    await writer(db).noteProgress({
      serverId: input.serverId,
      upgradeId: input.upgradeId,
      unit: input.unit,
      stage: input.stage,
      at: input.at,
      detail: input.detail,
      errorCode: input.errorCode,
      requestId: input.requestId,
    });
  } catch {
    // Fire-and-forget. The tick still observes the daemon build.
  }
}

export async function persistUpgradeOutcome(
  db: Db,
  input: {
    serverId: string;
    upgradeId?: string;
    unit: UpgradeStepUnit;
    ok: boolean;
    at: string;
    error?: string;
    errorCode?: string;
    requestId: string;
  },
): Promise<void> {
  try {
    await writer(db).noteOutcome({
      serverId: input.serverId,
      upgradeId: input.upgradeId,
      unit: input.unit,
      ok: input.ok,
      at: input.at,
      error: input.error,
      errorCode: input.errorCode,
      requestId: input.requestId,
    });
  } catch {
    // Same as progress: never fail the cell frame because the step row is gone.
  }
}
