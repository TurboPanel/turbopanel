/**
 * Host-free decisions the upgrade coordinator applies. No DB, no clock, no
 * cell. Ordering and gating stay in `planner.ts` / `run.ts` / `transitions.ts`.
 */
import type { UpdateProgressStage } from '../../contracts/cell-protocol.ts'
import { installScriptUrlForChannel } from '../install/daemon-install-command.ts'
import {
  readRestartNote,
  readRestartPending,
  readServerSnapshot,
  type RestartPending,
} from './restart-report.ts'
import type { UpgradeStepStatus } from './vocabulary.ts'

/** Wire feature a co-located daemon must advertise before a control-plane install. */
export const MANAGED_UPGRADE_FEATURE = 'managed-upgrade-v1'

/**
 * Production path of the daemon's `ORCHESTRATE_HELPER`
 * (`turbopaneld` `src/orchestration/assets.ts`). Operators run this absolute
 * path when the panel is down; a bare `tp-orchestrate` is not on `PATH`.
 */
export const MANAGED_ORCHESTRATE_HELPER =
  '/opt/turbopanel/share/orchestration/scripts/tp-orchestrate'

const UPGRADE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/

/** True when `upgradeId` is one path segment the rollback playbook will accept. */
export function isUpgradeRunId(upgradeId: string): boolean {
  return UPGRADE_ID_RE.test(upgradeId)
}

/**
 * Backup directory the rollback playbook reads for this attempt
 * (`turbopanel_backup_dir` default `/backup`): the `panel` folder of the backup root.
 */
export function controlPlaneBackupPath(upgradeId: string): string {
  const id = isUpgradeRunId(upgradeId) ? upgradeId : '<upgrade id>'
  return `/backup/panel/${id}`
}

/** Rollback command the preflight sheet copies. `upgradeId` is one path segment. */
export function controlPlaneRollbackCommand(upgradeId: string): string {
  const id = isUpgradeRunId(upgradeId) ? upgradeId : '<upgrade id>'
  return `sudo -n ${MANAGED_ORCHESTRATE_HELPER} playbook -i localhost, -c local -e turbopanel_upgrade_id=${id} instance-rollback.yml`
}

/** A copied rollback command that names a real attempt, not a placeholder id. */
export function isRunnableRollbackCommand(command: string): boolean {
  if (command.includes('pending') || command.includes('<upgrade id>')) {
    return false
  }
  return /turbopanel_upgrade_id=[A-Za-z0-9][A-Za-z0-9._-]{0,80}(?:\s|$)/.test(command)
}

/**
 * First transition onto this release: daemon package only, pinned manifest,
 * no control-plane install. On a host that already runs the control plane,
 * `run.sh` takes this through `daemon-colocated-refresh.yml` so socket-mode
 * `daemon.env`, shared ownership, and instance ordering stay put. It does
 * not run the remote-node `daemon-install.yml` playbook. The operator takes
 * a backup first when managed backup is not available yet.
 */
export function daemonOnlyUpdateCommand(manifestUrl: string | null, channel?: string): string {
  const pin = manifestUrl?.trim() ? manifestUrl.trim() : '<pinned daemon manifest url>'
  return `curl -fsSL ${installScriptUrlForChannel(
    channel
  )} | TURBOPANEL_DAEMON_ONLY=1 TURBOPANEL_MANIFEST_URL=${pin} sh`
}

/** Map a fire-and-forget progress stage onto a `stage` status. */
export function stepStatusForProgressStage(stage: UpdateProgressStage): UpgradeStepStatus {
  if (stage === 'rolled-back') return 'rolled_back'
  return stage
}

export function isProgressTerminal(status: UpgradeStepStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'rolled_back'
}

/** Earlier dispatch ids a step remembers; one per retry is plenty. */
export const MAX_PRIOR_REQUEST_IDS = 5

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
  priorRequestIds: string[]
  inProgressRefused: boolean
}

export type StepDetail = {
  /** Name and hostname of the server when the step was planned, for a server that is later renamed or deleted. */
  serverName?: string
  serverHostname?: string
  /** The host reported a failed daemon restart; held until it reconnects or the window ends. */
  restartPending?: RestartPending
  /** The host came back on the target after a reported restart error. */
  restartNote?: string
  progressDetail?: string
  priorRequestIds?: string[]
  inProgressRefused?: boolean
  /**
   * The control-plane step exists only to move the UI bundle (the binary is
   * already current), so the daemon's result — not the commit — settles it.
   */
  uiRefresh?: boolean
}

function detailRecord(detail: unknown): Record<string, unknown> {
  return typeof detail === 'object' && detail !== null && !Array.isArray(detail)
    ? (detail as Record<string, unknown>)
    : {}
}

export function readDispatchHistory(detail: unknown): StepDispatchHistory {
  const record = detailRecord(detail)
  const ids = Array.isArray(record.priorRequestIds)
    ? record.priorRequestIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : []
  return {
    priorRequestIds: ids.slice(-MAX_PRIOR_REQUEST_IDS),
    inProgressRefused: record.inProgressRefused === true,
  }
}

/**
 * Record a superseded dispatch id before a step is dispatched again. A new
 * dispatch is a new try, so a restart hold or note left by the last one goes.
 */
export function withSupersededRequest(
  detail: unknown,
  requestId: string | null
): Record<string, unknown> {
  const history = readDispatchHistory(detail)
  const ids =
    requestId && !history.priorRequestIds.includes(requestId)
      ? [...history.priorRequestIds, requestId].slice(-MAX_PRIOR_REQUEST_IDS)
      : history.priorRequestIds
  const rest = { ...detailRecord(detail) }
  delete rest.restartPending
  delete rest.restartNote
  return {
    ...rest,
    priorRequestIds: ids,
    inProgressRefused: false,
  }
}

/** Mark that the current dispatch was refused because an earlier one still runs. */
export function withInProgressRefused(detail: unknown): Record<string, unknown> {
  return { ...detailRecord(detail), inProgressRefused: true }
}

/** The detail a step stores: only the keys that survive (the phase has its own column). */
export function stepDetail(detail: unknown): StepDetail {
  const record = detailRecord(detail)
  const out: StepDetail = {}
  if (typeof record.progressDetail === 'string') {
    out.progressDetail = record.progressDetail
  }
  const history = readDispatchHistory(detail)
  if (history.priorRequestIds.length > 0) {
    out.priorRequestIds = history.priorRequestIds
  }
  if (history.inProgressRefused) out.inProgressRefused = true
  if (uiRefreshFromDetail(detail)) out.uiRefresh = true
  const pending = readRestartPending(detail)
  if (pending) out.restartPending = pending
  const note = readRestartNote(detail)
  if (note) out.restartNote = note
  return { ...out, ...readServerSnapshot(detail) }
}

/** Whether a step was opened only to refresh the UI bundle. */
export function uiRefreshFromDetail(detail: unknown): boolean {
  return detailRecord(detail).uiRefresh === true
}

/**
 * Why a server is never updated remotely, as the machine code clients branch
 * on (`updateBlockedCode`; `updateBlockedReason` carries the sentence). Only
 * the control plane's own host is: it updates in the platform phase.
 */
export type ServerUpdateBlockedCode = 'colocated_with_instance'

/**
 * Machine code for every retired manual-update route (HTTP 410), admin and
 * client alike. Updates are automatic; the only control is Pause All Updates
 * in Admin > Updates.
 */
export const UPDATES_AUTOMATIC_ERROR = 'updates_automatic'

export const UPDATES_AUTOMATIC_MESSAGE =
  'Updates are automatic and cannot be started, retried or cancelled by hand. An administrator can use Pause All Updates in Admin > Updates.'

/** The body every retired manual-update route answers with HTTP 410. */
export function updatesAutomaticBody(): { ok: false; error: string; message: string } {
  return { ok: false, error: UPDATES_AUTOMATIC_ERROR, message: UPDATES_AUTOMATIC_MESSAGE }
}
