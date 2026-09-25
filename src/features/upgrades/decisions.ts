/**
 * Host-free decisions the upgrade coordinator applies. No DB, no clock, no
 * cell. Ordering and gating stay in `planner.ts` / `run.ts` / `transitions.ts`.
 */
import type { UpdateProgressStage } from "../../contracts/cell-protocol.ts";
import type { UpgradeRuntime } from "./planner.ts";
import type { UpgradePhase, UpgradeStepStatus } from "./vocabulary.ts";

/** Wire feature a co-located daemon must advertise before a control-plane install. */
export const MANAGED_UPGRADE_FEATURE = "managed-upgrade-v1";

/**
 * Production path of the daemon's `ORCHESTRATE_HELPER`
 * (`turbopaneld` `src/orchestration/assets.ts`). Operators run this absolute
 * path when the panel is down; a bare `tp-orchestrate` is not on `PATH`.
 */
export const MANAGED_ORCHESTRATE_HELPER =
  "/opt/turbopanel/share/orchestration/scripts/tp-orchestrate";

const UPGRADE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

/** True when `upgradeId` is one path segment the rollback playbook will accept. */
export function isUpgradeRunId(upgradeId: string): boolean {
  return UPGRADE_ID_RE.test(upgradeId);
}

/**
 * Backup directory the rollback playbook reads for this attempt
 * (`turbopanel_backup_dir` default `/backup`).
 */
export function controlPlaneBackupPath(upgradeId: string): string {
  const id = isUpgradeRunId(upgradeId) ? upgradeId : "<upgrade id>";
  return `/backup/control-plane/${id}`;
}

/** Rollback command the preflight sheet copies. `upgradeId` is one path segment. */
export function controlPlaneRollbackCommand(upgradeId: string): string {
  const id = isUpgradeRunId(upgradeId) ? upgradeId : "<upgrade id>";
  return `sudo -n ${MANAGED_ORCHESTRATE_HELPER} playbook -i localhost, -c local -e turbopanel_upgrade_id=${id} instance-rollback.yml`;
}

/** A copied rollback command that names a real attempt, not a placeholder id. */
export function isRunnableRollbackCommand(command: string): boolean {
  if (command.includes("pending") || command.includes("<upgrade id>")) {
    return false;
  }
  return /turbopanel_upgrade_id=[A-Za-z0-9][A-Za-z0-9._-]{0,80}(?:\s|$)/.test(
    command,
  );
}

/**
 * First transition onto this release: daemon package only, pinned manifest,
 * no control-plane install. On a host that already runs the control plane,
 * `run.sh` takes this through `daemon-colocated-refresh.yml` so socket-mode
 * `daemon.env`, shared ownership, and instance ordering stay put. It does
 * not run the remote-node `daemon-install.yml` playbook. The operator takes
 * a backup first when managed backup is not available yet.
 */
export function daemonOnlyUpdateCommand(manifestUrl: string | null): string {
  const pin = manifestUrl?.trim()
    ? manifestUrl.trim()
    : "<pinned daemon manifest url>";
  return `curl -fsSL turbopanel.sh | TURBOPANEL_DAEMON_ONLY=1 TURBOPANEL_MANIFEST_URL=${pin} sh`;
}

/** Map a fire-and-forget progress stage onto an `upgradestep` status. */
export function stepStatusForProgressStage(
  stage: UpdateProgressStage,
): UpgradeStepStatus {
  if (stage === "rolled-back") return "rolled_back";
  return stage;
}

export function isProgressTerminal(status: UpgradeStepStatus): boolean {
  return status === "done" || status === "failed" || status === "rolled_back";
}

export function phaseFromDetail(detail: unknown): UpgradePhase {
  if (typeof detail !== "object" || detail === null) return "fleet";
  const phase = (detail as { phase?: unknown }).phase;
  if (
    phase === "colocated_daemon" || phase === "control_plane" ||
    phase === "fleet"
  ) {
    return phase;
  }
  return "fleet";
}

/** Earlier dispatch ids a step remembers; one per retry is plenty. */
export const MAX_PRIOR_REQUEST_IDS = 5;

/**
 * What a step remembers about its earlier dispatches.
 *
 * - `priorRequestIds`: wire ids of earlier `update` / `instance-update`
 *   dispatches for this step, oldest first. A stall retry mints a new id; the
 *   install it retried may still finish and report under an older one.
 * - `inProgressRefused`: the current dispatch was refused because an earlier
 *   one is still installing, so that earlier install is the live one.
 */
export type StepDispatchHistory = {
  priorRequestIds: string[];
  inProgressRefused: boolean;
};

export type StepDetail = {
  phase: UpgradePhase;
  progressDetail?: string;
  priorRequestIds?: string[];
  inProgressRefused?: boolean;
};

function detailRecord(detail: unknown): Record<string, unknown> {
  return typeof detail === "object" && detail !== null && !Array.isArray(detail)
    ? detail as Record<string, unknown>
    : {};
}

export function readDispatchHistory(detail: unknown): StepDispatchHistory {
  const record = detailRecord(detail);
  const ids = Array.isArray(record.priorRequestIds)
    ? record.priorRequestIds.filter((id): id is string =>
      typeof id === "string" && id.length > 0
    )
    : [];
  return {
    priorRequestIds: ids.slice(-MAX_PRIOR_REQUEST_IDS),
    inProgressRefused: record.inProgressRefused === true,
  };
}

/** Record a superseded dispatch id before a step is dispatched again. */
export function withSupersededRequest(
  detail: unknown,
  requestId: string | null,
): Record<string, unknown> {
  const history = readDispatchHistory(detail);
  const ids = requestId && !history.priorRequestIds.includes(requestId)
    ? [...history.priorRequestIds, requestId].slice(-MAX_PRIOR_REQUEST_IDS)
    : history.priorRequestIds;
  return {
    ...detailRecord(detail),
    priorRequestIds: ids,
    inProgressRefused: false,
  };
}

/** Mark that the current dispatch was refused because an earlier one still runs. */
export function withInProgressRefused(detail: unknown): Record<string, unknown> {
  return { ...detailRecord(detail), inProgressRefused: true };
}

export function detailWithPhase(
  phase: UpgradePhase,
  detail: unknown,
): StepDetail {
  const record = detailRecord(detail);
  const out: StepDetail = { phase };
  if (typeof record.progressDetail === "string") {
    out.progressDetail = record.progressDetail;
  }
  const history = readDispatchHistory(detail);
  if (history.priorRequestIds.length > 0) {
    out.priorRequestIds = history.priorRequestIds;
  }
  if (history.inProgressRefused) out.inProgressRefused = true;
  return out;
}

export type ClientUpdateBlockError =
  | "updates_managed"
  | "control_plane_upgrade_required"
  | "upgrade_gate_unavailable";

export type ClientUpdateBlock =
  | { blocked: false; useCoordinator: boolean }
  | {
    blocked: true;
    error: ClientUpdateBlockError;
  };

/**
 * Hard gate for `POST /servers/:id/update` and `POST /servers/updates`.
 * Workers always refuses. The legacy per-server updater runs only in explicit
 * development mode. Everywhere else a missing target or a failed gate read
 * fails closed, and a shut fleet gate refuses until the control plane is
 * on target.
 */
export function clientUpdateBlock(input: {
  runtime: UpgradeRuntime;
  development: boolean;
  targetCommitKnown: boolean;
  gateOpen: boolean;
}): ClientUpdateBlock {
  if (input.runtime === "workers") {
    return { blocked: true, error: "updates_managed" };
  }
  if (input.development) {
    return { blocked: false, useCoordinator: false };
  }
  if (!input.targetCommitKnown) {
    return { blocked: true, error: "upgrade_gate_unavailable" };
  }
  if (!input.gateOpen) {
    return { blocked: true, error: "control_plane_upgrade_required" };
  }
  return { blocked: false, useCoordinator: true };
}

export function clientUpdateBlockStatus(
  error: ClientUpdateBlockError,
): 409 | 503 {
  if (error === "upgrade_gate_unavailable") return 503;
  return 409;
}

export function clientUpdateBlockReason(error: ClientUpdateBlockError): string {
  if (error === "updates_managed") {
    return "Daemon updates on TurboPanel High Availability run from Admin → Updates.";
  }
  if (error === "upgrade_gate_unavailable") {
    return "TurboPanel could not confirm that this control plane is ready for server updates.";
  }
  return "Update this control plane from Admin → Updates before updating other servers.";
}
