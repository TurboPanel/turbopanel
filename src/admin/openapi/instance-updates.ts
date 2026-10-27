import { ADMIN_API_PREFIX } from '../../app/surfaces.ts'

const cookieSecurity = [{ cookieAuth: [] }] as const

/** A route that used to start, retry or cancel an update by hand. */
function retired(summary: string) {
  return {
    post: {
      tags: ['Instance'],
      summary,
      description:
        'Retired: updates are automatic. Always answers 410 `updates_automatic` with a ' +
        '`message`; the only control is `POST /instance/updates/pause` / `resume`.',
      security: [...cookieSecurity],
      responses: {
        '401': { description: 'Unauthorized' },
        '403': { description: 'Forbidden — requires admin or superadmin role' },
        '410': { description: '`updates_automatic`' },
      },
    },
  }
}

/** Pause and Resume answer with the same pause fields as the status read. */
function pauseRoute(summary: string, description: string) {
  return {
    post: {
      tags: ['Instance'],
      summary,
      description,
      security: [...cookieSecurity],
      responses: {
        '200': { description: '`{ ok: true, updatesPaused, pausedAt, pausedBy }`' },
        '401': { description: 'Unauthorized' },
        '403': { description: 'Forbidden — requires admin or superadmin role' },
      },
    },
  }
}

/**
 * Control-plane and co-located daemon versions, the automatic-update status,
 * Pause / Resume, the batch size, and the read-only run and history routes.
 * The UI package target is reported on the control-plane unit and installed
 * by the same upgrade.
 */
export const INSTANCE_UPDATES_PATHS = {
  [`${ADMIN_API_PREFIX}/instance/updates`]: {
    get: {
      tags: ['Instance'],
      summary: 'Read control-plane and co-located daemon update status',
      description:
        'Returns the installed `INSTANCE_VERSION` and commit (the same ' +
        'values as `/api/health`), plus `label` (the installed build label, ' +
        'for example `0.1.3-canary.417`, when the installer recorded it), ' +
        "and the co-located daemon's reported " +
        'version, each beside the channel manifest target. The UI package ' +
        'target is included on the control-plane unit and is installed by ' +
        "the same upgrade. Each unit carries `updateAvailable`: the server's " +
        'rule (the target names a commit the host is not running, and ' +
        'installing it would not downgrade). Clients render it rather than ' +
        'comparing versions or commits themselves. The control-plane unit also ' +
        'carries `uiUpdateAvailable` (self-hosted only): pass `?consoleCommit=` ' +
        'with the commit the console bundle was built from, and it is true when ' +
        "the channel's UI build differs. The UI ships inside the control-plane " +
        'install. Updates are always automatic, so the body also carries: ' +
        '`automatic` (true), `updatesPaused`, `pausedAt` and `pausedBy` ' +
        '(`{ userId, email, name }` or null), `daemonsBehind` (a connected daemon ' +
        'is behind the target), `updateWaiting` (`daemonsBehind`, or on a ' +
        'self-hosted control plane its own or the UI update), `nextCheckAt` and ' +
        '`lastCheckAt` (the hourly check, at a minute of the hour drawn once per ' +
        'install; `lastCheckAt` also counts Check Now), `checkIntervalMinutes` (60, or ' +
        'less where `TURBOPANEL_UPGRADE_CHECK_MINUTES` is set on a test install) and ' +
        '`activeRunId`. Each is one `limit 1` read.',
      security: [...cookieSecurity],
      responses: {
        '200': { description: 'Installed versions and channel targets' },
        '401': { description: 'Unauthorized' },
        '403': { description: 'Forbidden — requires admin or superadmin role' },
      },
    },
  },
  [`${ADMIN_API_PREFIX}/instance/updates/settings`]: {
    get: {
      tags: ['Instance'],
      summary: 'Read the batch size for automatic updates',
      description:
        'Returns `{ batch }` (`{ mode: "count" | "percent", value }`): how many ' +
        'servers update together in one batch. The next batch starts on a later ' +
        'upgrade tick once every server in the current one has finished or ' +
        'failed. Settings belong to this environment. With nothing saved, ' +
        '`batch` is every server at once (100%) unless the environment sets ' +
        '`TURBOPANEL_UPGRADE_BATCH`. A row saved by an older control plane keeps ' +
        'its batch; its `autoUpdate` and maintenance window are ignored.',
      security: [...cookieSecurity],
      responses: {
        '200': { description: 'Current settings' },
        '401': { description: 'Unauthorized' },
        '403': { description: 'Forbidden — requires admin or superadmin role' },
      },
    },
    put: {
      tags: ['Instance'],
      summary: 'Save the batch size for automatic updates',
      description:
        'Takes `{ batch }` (an older console may also send `autoUpdate` and ' +
        '`maintenanceWindow`; they are ignored). `batch.mode` is `count` (1 to ' +
        '10000 servers) or `percent` (1 to 100 of the fleet, rounded up); ' +
        'values must be whole numbers. Anything else answers 400 ' +
        '`invalid_settings`.',
      security: [...cookieSecurity],
      responses: {
        '200': { description: 'Saved settings' },
        '400': { description: 'invalid_settings' },
        '401': { description: 'Unauthorized' },
        '403': { description: 'Forbidden — requires admin or superadmin role' },
      },
    },
  },
  [`${ADMIN_API_PREFIX}/instance/updates/pause`]: pauseRoute(
    'Pause all updates',
    'Stops new updates of the control plane, the UI and every daemon until Resume. A run in ' +
      'progress finishes the servers it is already updating; its other servers are `skipped` ' +
      '(`updates_paused`) and the run ends `cancelled` with `error` `updates_paused`. Pausing ' +
      'again keeps the first pause. Recorded in the activity log (`upgrade.pause`).'
  ),
  [`${ADMIN_API_PREFIX}/instance/updates/resume`]: pauseRoute(
    'Resume updates',
    'Lifts the pause; the next hourly check starts what is waiting. Recorded in the activity ' +
      'log (`upgrade.resume`) when a pause was in force.'
  ),
  [`${ADMIN_API_PREFIX}/instance/updates/instance`]: retired(
    'Retired: start the control-plane update by hand'
  ),
  [`${ADMIN_API_PREFIX}/instance/updates/preflight`]: retired('Retired: pre-flight an update'),
  [`${ADMIN_API_PREFIX}/instance/updates/runs`]: retired('Retired: start an update run'),
  [`${ADMIN_API_PREFIX}/instance/updates/check`]: {
    post: {
      tags: ['Instance'],
      summary: 'Check Now: look for the newest build',
      description:
        'A refresh only. Asks the release servers for the newest build (skipping the ' +
        'manifest cache), saves it, and answers the same body as `GET /instance/updates`. It ' +
        'never starts an update and never moves the schedule: the next scheduled check ' +
        'starts it. At most once a minute per install; sooner answers 429 `check_too_soon` ' +
        'with `retryAfterSeconds` and a `Retry-After` header.',
      security: [...cookieSecurity],
      responses: {
        '200': { description: 'The refreshed update status' },
        '401': { description: 'Unauthorized' },
        '403': { description: 'Forbidden — requires admin or superadmin role' },
        '429': { description: '`check_too_soon`' },
      },
    },
  },
  [`${ADMIN_API_PREFIX}/instance/updates/steps/{id}/retry`]: retired(
    'Retired: retry an update step (failed servers are retried automatically)'
  ),
  [`${ADMIN_API_PREFIX}/instance/updates/runs/{id}/cancel`]: retired(
    'Retired: cancel an update run (use Pause all updates)'
  ),
  [`${ADMIN_API_PREFIX}/instance/updates/run`]: {
    get: {
      tags: ['Instance'],
      summary: 'Read the active upgrade run, or the last finished one',
      description:
        '`{ ok: true, run, lastRun }`. `run` is the pending or running run with its steps, ' +
        'or null. When no run is active, `lastRun` is the most recent finished run (with its ' +
        "steps, `error`, and each step's `errorCode` / `errorMessage`) if it ended within the " +
        'last 24 hours, so a failure stays visible after the run stops being active; otherwise null. ' +
        'Every step carries `phase` `attempts` (dispatches so far) and a boolean `connected` (the host is linked now); only a `waiting` step with `attempts` 0 and `connected` false is skippable-offline. A fleet host ' +
        'offline when the update starts is `skipped` with `errorCode` `server_offline` at once; a host ' +
        'that drops during the run is skipped after 15 minutes counted from when the run first noticed it offline.',
      security: [...cookieSecurity],
      responses: {
        '200': { description: '`{ ok: true, run, lastRun }`' },
      },
    },
  },
  [`${ADMIN_API_PREFIX}/instance/updates/runs/{id}`]: {
    get: {
      tags: ['Instance'],
      summary: 'Read one upgrade run',
      security: [...cookieSecurity],
      responses: {
        '200': { description: 'The run and its steps' },
        '404': { description: '`upgrade_run_not_found`' },
      },
    },
  },
  [`${ADMIN_API_PREFIX}/instance/updates/history`]: {
    get: {
      tags: ['Instance'],
      summary: 'Page the update runs, newest first',
      description:
        '`{ ok, runs, total }`, one row per run. Query: `offset`, `limit` (1 to 100, default 50), ' +
        '`status` and `trigger`. Without `status` only finished runs are listed (the answer older ' +
        'consoles expect); `status=any` lists every run, `status=active` the pending or running one, ' +
        'or name one run status. `trigger` is `automatic` (source `auto`) or `manual` (sources ' +
        '`manual` and `server`). Each run carries `trigger` and `summary` ' +
        '`{ detail, total, updated, alreadyCurrent, skipped, failed, inProgress }`, counted per server ' +
        '(a server with several steps takes the worst outcome). `alreadyCurrent` is a host the run ' +
        'found already on the target and never sent anything to; it is never counted as updated. ' +
        "`detail` `pruned` means retention removed the run's steps: the totals come from the stored " +
        'step counts and `updated` / `alreadyCurrent` are null.',
      security: [...cookieSecurity],
      responses: {
        '200': { description: '`{ ok: true, runs, total }`' },
        '400': { description: '`invalid_filter` with the `field` it refused' },
      },
    },
  },
  [`${ADMIN_API_PREFIX}/instance/updates/runs/{id}/servers`]: {
    get: {
      tags: ['Instance'],
      summary: "Page one run's servers",
      description:
        '`{ ok, run, units, statusCounts, organizations, servers, total }`, one row per server; ' +
        'never every step of the run. Query: `offset`, `limit` (1 to 100), `sort` (`status` (default, ' +
        'failed first), `organization`, `server`, `started`, `finished`, `duration`, `attempts`), ' +
        '`dir` (`asc` default, `desc`), `status` (server outcome: `updated`, `already_current`, ' +
        '`skipped`, `failed`, `in_progress`), `organizationId`, `serverId` and `q` (server name, ' +
        'hostname or organization name contains it, or a server or organization id starts with it). ' +
        '`statusCounts` (`all` plus one per outcome) honours every filter but `status`, for quick ' +
        'filters. `organizations` lists up to 100 organizations in the run with their server count. ' +
        'Each server row has organization, datacenter, from/to version and commit, outcome, started, ' +
        'finished, duration, the reason of a failed or skipped component, attempts, `connected`, ' +
        '`lastHeartbeatAt` (read for the first 51 rows of this page only, null beyond) and `components` keyed by unit (`daemon`, ' +
        '`instance`), each with its own step status, outcome, versions, times and error. `run` is ' +
        'the history row of this run. Started and finished are null when they were not recorded.',
      security: [...cookieSecurity],
      responses: {
        '200': { description: 'One page of servers with counts' },
        '400': { description: '`invalid_filter` with the `field` it refused' },
        '404': { description: '`upgrade_run_not_found`' },
      },
    },
  },
  [`${ADMIN_API_PREFIX}/instance/updates/daemon`]: retired(
    'Retired: start the daemon update by hand'
  ),
}
