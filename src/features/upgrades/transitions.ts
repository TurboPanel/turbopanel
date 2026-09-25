/**
 * Pure per-step state machine. Given a step row, the facts the tick already
 * knows (is the server connected, what commit does it run now), and the clock,
 * decide the single next action. The orchestrator applies it (writes Postgres,
 * enqueues the cell message); this module never touches either.
 *
 * Self-healing rules encoded here:
 *   - An offline server's step becomes `waiting`; it is dispatched on reconnect.
 *     A step still waiting after {@link UPGRADE_OFFLINE_DEADLINE_MS} becomes
 *     `needs_attention` (`server_offline`), so one unreachable host cannot hold
 *     the single instance-wide run open. The retry endpoint reopens it.
 *   - No progress within the step timeout → retry with backoff, up to
 *     {@link UPGRADE_STEP_MAX_ATTEMPTS} dispatches, then `needs_attention`.
 *   - `rolled_back` → one automatic retry, then `needs_attention`.
 *   - A commit that matches the target marks the step `done` (this is also
 *     what the hello/heartbeat projection sees when a host comes back on the
 *     new build).
 */
import type { UpgradeStepStatus } from "./vocabulary.ts";

/** Total dispatches allowed for a step whose install stalls. */
export const UPGRADE_STEP_MAX_ATTEMPTS = 3;

/** Total dispatches allowed for a step that keeps rolling back (one retry). */
export const UPGRADE_ROLLBACK_MAX_ATTEMPTS = 2;

/** No stage change within this window is treated as a stalled install. */
export const UPGRADE_STEP_TIMEOUT_MS = 15 * 60 * 1000;

/** First retry waits this long; each further retry doubles it. */
export const UPGRADE_BACKOFF_BASE_MS = 60 * 1000;

/** Retry backoff never exceeds this. */
export const UPGRADE_BACKOFF_MAX_MS = 30 * 60 * 1000;

/**
 * How long a step may wait for its server to come back, counted from when it
 * started waiting (the orchestrator stamps `lastStageAt` on entry).
 */
export const UPGRADE_OFFLINE_DEADLINE_MS = 60 * 60 * 1000;

/** Statuses that are settled — the tick leaves them alone. */
const SETTLED: readonly UpgradeStepStatus[] = [
  "done",
  "skipped",
  "failed",
  "needs_attention",
];

/** Stages that mean an install is in flight on the daemon. */
const IN_FLIGHT: readonly UpgradeStepStatus[] = [
  "dispatched",
  "preparing",
  "downloading",
  "installing",
  "restarting",
  "verifying",
];

export function isSettledStepStatus(status: UpgradeStepStatus): boolean {
  return SETTLED.includes(status);
}

export function isInFlightStepStatus(status: UpgradeStepStatus): boolean {
  return IN_FLIGHT.includes(status);
}

export type StepView = {
  status: UpgradeStepStatus;
  attempts: number;
  nextAttemptAt: string | null;
  lastStageAt: string | null;
  /** The commit this step installs (copied from the run target). */
  toCommit: string | null;
};

export type StepFacts = {
  serverConnected: boolean;
  /** The commit the host reports running now (from the projection). */
  currentCommit: string | null;
};

export type StepConfig = {
  now: string;
  maxAttempts?: number;
  rollbackMaxAttempts?: number;
  stepTimeoutMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  offlineDeadlineMs?: number;
};

export type StepAction =
  | { kind: "none" }
  | { kind: "done" }
  | { kind: "dispatch" }
  | { kind: "wait_offline" }
  | { kind: "retry"; nextAttemptAt: string }
  | { kind: "needs_attention"; errorCode: string };

/** Exponential backoff for the n-th retry (attempt ≥ 1), capped. */
export function computeBackoffMs(
  attempt: number,
  baseMs: number = UPGRADE_BACKOFF_BASE_MS,
  maxMs: number = UPGRADE_BACKOFF_MAX_MS,
): number {
  const exponent = Math.max(0, attempt - 1);
  const scaled = baseMs * 2 ** exponent;
  return Math.min(scaled, maxMs);
}

function backoffAt(cfg: StepConfig, attempt: number): string {
  const delay = computeBackoffMs(attempt, cfg.backoffBaseMs, cfg.backoffMaxMs);
  return new Date(Date.parse(cfg.now) + delay).toISOString();
}

function reachedTarget(step: StepView, facts: StepFacts): boolean {
  const want = step.toCommit;
  return typeof want === "string" && want.length > 0 &&
    facts.currentCommit === want;
}

function backoffElapsed(step: StepView, cfg: StepConfig): boolean {
  if (!step.nextAttemptAt) return true;
  return Date.parse(cfg.now) >= Date.parse(step.nextAttemptAt);
}

function isStalled(step: StepView, cfg: StepConfig): boolean {
  if (!step.lastStageAt) return false;
  const timeout = cfg.stepTimeoutMs ?? UPGRADE_STEP_TIMEOUT_MS;
  return Date.parse(cfg.now) - Date.parse(step.lastStageAt) > timeout;
}

/** Only a step already `waiting` has a `lastStageAt` that marks when it went offline. */
function offlineTooLong(step: StepView, cfg: StepConfig): boolean {
  if (step.status !== "waiting" || !step.lastStageAt) return false;
  const deadline = cfg.offlineDeadlineMs ?? UPGRADE_OFFLINE_DEADLINE_MS;
  return Date.parse(cfg.now) - Date.parse(step.lastStageAt) > deadline;
}

function handleRolledBack(
  step: StepView,
  facts: StepFacts,
  cfg: StepConfig,
): StepAction {
  const limit = cfg.rollbackMaxAttempts ?? UPGRADE_ROLLBACK_MAX_ATTEMPTS;
  if (step.attempts >= limit) {
    return { kind: "needs_attention", errorCode: "rolled_back" };
  }
  if (!facts.serverConnected) return { kind: "wait_offline" };
  return { kind: "dispatch" };
}

function handleDue(
  step: StepView,
  facts: StepFacts,
  cfg: StepConfig,
): StepAction {
  if (!facts.serverConnected) {
    if (offlineTooLong(step, cfg)) {
      return { kind: "needs_attention", errorCode: "server_offline" };
    }
    return { kind: "wait_offline" };
  }
  if (!backoffElapsed(step, cfg)) return { kind: "none" };
  return { kind: "dispatch" };
}

function handleInFlight(
  step: StepView,
  facts: StepFacts,
  cfg: StepConfig,
): StepAction {
  // A host that drops mid-install cannot finish; re-dispatch on reconnect.
  if (!facts.serverConnected) return { kind: "wait_offline" };
  if (!isStalled(step, cfg)) return { kind: "none" };
  const maxAttempts = cfg.maxAttempts ?? UPGRADE_STEP_MAX_ATTEMPTS;
  if (step.attempts >= maxAttempts) {
    return { kind: "needs_attention", errorCode: "step_timeout" };
  }
  return { kind: "retry", nextAttemptAt: backoffAt(cfg, step.attempts) };
}

/**
 * The single next action for one step. `done` and `dispatch`/`retry` are
 * applied by the orchestrator; `none` means nothing to do this tick.
 */
export function planStepAction(
  step: StepView,
  facts: StepFacts,
  cfg: StepConfig,
): StepAction {
  if (isSettledStepStatus(step.status)) return { kind: "none" };
  if (reachedTarget(step, facts)) return { kind: "done" };
  if (step.status === "rolled_back") return handleRolledBack(step, facts, cfg);
  if (step.status === "pending" || step.status === "waiting") {
    return handleDue(step, facts, cfg);
  }
  return handleInFlight(step, facts, cfg);
}
