/**
 * Deno cell-maintenance scheduler.
 *
 * Liveness (`maintain` + `sweepStalePresence`) must not share an in-flight
 * flag with slower cleanup. A hung command-dispatch, webhook, execution-log,
 * or system-reconcile phase must not suppress the next stale-presence tick.
 * Each lane still refuses to overlap itself.
 */

export type DenoMaintenanceHooks = {
  runLiveness: () => Promise<void>;
  runCleanup: () => Promise<void>;
};

export type DenoMaintenanceScheduler = {
  /** Fire-and-forget tick used by `setInterval`. */
  tick: () => void;
  /**
   * Await this tick's liveness pass. Cleanup may still be in flight; a later
   * call still runs liveness when cleanup is hung.
   */
  runTick: () => Promise<void>;
};

export function createDenoMaintenanceScheduler(
  hooks: DenoMaintenanceHooks,
): DenoMaintenanceScheduler {
  let livenessInFlight = false;
  let cleanupInFlight = false;

  async function tickLiveness(): Promise<void> {
    if (livenessInFlight) return;
    livenessInFlight = true;
    try {
      await hooks.runLiveness();
    } finally {
      livenessInFlight = false;
    }
  }

  function tickCleanup(): void {
    if (cleanupInFlight) return;
    cleanupInFlight = true;
    void (async () => {
      try {
        await hooks.runCleanup();
      } finally {
        cleanupInFlight = false;
      }
    })();
  }

  async function runTick(): Promise<void> {
    const liveness = tickLiveness();
    tickCleanup();
    await liveness;
  }

  return {
    tick: () => {
      void runTick();
    },
    runTick,
  };
}
