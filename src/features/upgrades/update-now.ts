/**
 * Update Now (`POST /instance/updates/now`): how the coordinator's answer is
 * said over HTTP. Host-free; the route and its tests share it.
 */
import {
  UPGRADE_DEVELOPMENT,
  UPGRADE_PAUSED,
  UPGRADE_RELEASE_UNREACHABLE,
  UPGRADE_TOO_SOON,
  UPGRADE_RUN_ACTIVE,
  UPGRADE_RUN_ACTIVE_MESSAGE,
  type UpgradeUpdateNowResult,
} from './coordinator.ts'

/** Machine codes the route answers; clients branch on these, never the sentence. */
export const UPDATE_NOW_ERRORS = {
  runActive: 'run_active',
  paused: 'paused',
  development: 'development',
  blocked: 'update_blocked',
  releaseUnreachable: 'release_unreachable',
  /** The same code Check Now answers when pressed again within a minute. */
  tooSoon: 'check_too_soon',
} as const

export type UpdateNowAnswer =
  | { status: 202; body: { ok: true; runId: string } }
  | { status: 200; body: { ok: true; upToDate: true } }
  | {
      status: 403 | 409 | 429 | 503
      body: {
        ok: false
        error: (typeof UPDATE_NOW_ERRORS)[keyof typeof UPDATE_NOW_ERRORS]
        message: string
        activeRunId?: string
        blockers?: string[]
        retryAfterSeconds?: number
      }
    }

export const UPDATE_NOW_PAUSED_MESSAGE = 'Updates are paused. Resume updates to update now.'

export const UPDATE_NOW_DEVELOPMENT_MESSAGE =
  'A development install updates with Build and Push Daemon.'

export const UPDATE_NOW_UNREACHABLE_MESSAGE =
  'The release server could not be reached. Try again in a few minutes.'

/**
 * 202 with the run, 200 when nothing needs work, otherwise a code: 403, 409,
 * 429 (`retryAfterSeconds`, read by the route) or 503.
 */
export function updateNowAnswer(
  result: UpgradeUpdateNowResult,
  retryAfterSeconds = 60
): UpdateNowAnswer {
  if (result.ok) {
    return 'runId' in result
      ? { status: 202, body: { ok: true, runId: result.runId } }
      : { status: 200, body: { ok: true, upToDate: true } }
  }
  switch (result.error) {
    case UPGRADE_RUN_ACTIVE:
      return {
        status: 409,
        body: {
          ok: false,
          error: UPDATE_NOW_ERRORS.runActive,
          message: UPGRADE_RUN_ACTIVE_MESSAGE,
          ...(result.activeRunId ? { activeRunId: result.activeRunId } : {}),
        },
      }
    case UPGRADE_PAUSED:
      return {
        status: 409,
        body: { ok: false, error: UPDATE_NOW_ERRORS.paused, message: UPDATE_NOW_PAUSED_MESSAGE },
      }
    case UPGRADE_TOO_SOON: {
      const wait = Math.max(1, Math.ceil(retryAfterSeconds))
      return {
        status: 429,
        body: {
          ok: false,
          error: UPDATE_NOW_ERRORS.tooSoon,
          message: `Pressed a moment ago. Try again in ${wait} second${wait === 1 ? '' : 's'}.`,
          retryAfterSeconds: wait,
        },
      }
    }
    case UPGRADE_RELEASE_UNREACHABLE:
      return {
        status: 503,
        body: {
          ok: false,
          error: UPDATE_NOW_ERRORS.releaseUnreachable,
          message: UPDATE_NOW_UNREACHABLE_MESSAGE,
        },
      }
    case UPGRADE_DEVELOPMENT:
      return {
        status: 403,
        body: {
          ok: false,
          error: UPDATE_NOW_ERRORS.development,
          message: UPDATE_NOW_DEVELOPMENT_MESSAGE,
        },
      }
    default: {
      // A preflight blocker (a sentence) or a retry backoff: say the first one.
      const blockers = result.blockers?.length ? result.blockers : [result.error]
      return {
        status: 409,
        body: {
          ok: false,
          error: UPDATE_NOW_ERRORS.blocked,
          message: blockers[0] ?? result.error,
          blockers,
        },
      }
    }
  }
}
