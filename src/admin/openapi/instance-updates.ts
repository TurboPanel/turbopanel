import { ADMIN_API_PREFIX } from '../../app/surfaces.ts'

const cookieSecurity = [{ cookieAuth: [] }] as const

/**
 * Control-plane and co-located daemon versions, plus the two upgrade
 * dispatches. The UI package target is reported on the control-plane unit
 * and installed by the same upgrade.
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
        'install, so a run started with `consoleCommit` in the body reinstalls it.',
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
      summary: 'Read the managed-upgrade settings',
      description:
        'Returns `autoUpdate`, the maintenance window and `batch` ' +
        '(`{ mode: "count" | "percent", value }`): how many servers update ' +
        'together in one batch. The next batch starts on a later upgrade tick ' +
        '(15 minutes by default) once every server in the current one has ' +
        'finished or failed. Settings belong to this environment. With nothing ' +
        'saved, `batch` is one server at a time unless the environment sets ' +
        '`TURBOPANEL_UPGRADE_BATCH` (for example the testing fleet).',
      security: [...cookieSecurity],
      responses: {
        '200': { description: 'Current settings' },
        '401': { description: 'Unauthorized' },
        '403': { description: 'Forbidden — requires admin or superadmin role' },
      },
    },
    put: {
      tags: ['Instance'],
      summary: 'Save the managed-upgrade settings',
      description:
        'Replaces the whole settings object. `batch.mode` is `count` (1 to ' +
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
  [`${ADMIN_API_PREFIX}/instance/updates/instance`]: {
    post: {
      tags: ['Instance'],
      summary: 'Start the guarded upgrade from the legacy control-plane action',
      description:
        'Starts the same managed run as `POST /instance/updates/runs`. ' +
        'Workers answers 422. A channel other than canary, rc, or release ' +
        'answers 422. No connected co-located daemon answers 503. Pre-flight ' +
        'failure answers 409.',
      security: [...cookieSecurity],
      responses: {
        '202': { description: '`{ ok: true, dispatched: true }`' },
        '401': { description: 'Unauthorized' },
        '403': { description: 'Forbidden — requires admin or superadmin role' },
        '422': { description: 'Not applicable on this runtime or channel' },
        '503': { description: 'No connected co-located daemon' },
      },
    },
  },
  [`${ADMIN_API_PREFIX}/instance/updates/preflight`]: {
    post: {
      tags: ['Instance'],
      summary: 'Pre-flight a managed upgrade',
      security: [...cookieSecurity],
      responses: {
        '200': { description: 'Checks, blockers, and the recovery command' },
      },
    },
  },
  [`${ADMIN_API_PREFIX}/instance/updates/runs`]: {
    post: {
      tags: ['Instance'],
      summary: 'Start a managed upgrade run',
      security: [...cookieSecurity],
      responses: {
        '202': { description: '`{ ok: true, dispatched: true, runId }`' },
        '409': { description: 'Pre-flight failed or a run is already active' },
      },
    },
  },
  [`${ADMIN_API_PREFIX}/instance/updates/run`]: {
    get: {
      tags: ['Instance'],
      summary: 'Read the active upgrade run, or the last finished one',
      description:
        '`{ ok: true, run, lastRun }`. `run` is the pending or running run with its steps, ' +
        'or null. When no run is active, `lastRun` is the most recent finished run (with its ' +
        "steps, `error`, and each step's `errorCode` / `errorMessage`) if it ended within the " +
        'last 24 hours, so a failure stays visible after the run stops being active; otherwise null.',
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
  [`${ADMIN_API_PREFIX}/instance/updates/daemon`]: {
    post: {
      tags: ['Instance'],
      summary: 'Start the guarded upgrade from the legacy daemon action',
      description:
        'Starts the same managed run as `POST /instance/updates/runs`. ' +
        'On self-hosted, no connected co-located daemon answers 503.',
      security: [...cookieSecurity],
      responses: {
        '202': { description: '`{ ok: true, dispatched: true }`' },
        '401': { description: 'Unauthorized' },
        '403': { description: 'Forbidden — requires admin or superadmin role' },
        '503': { description: 'No connected co-located daemon' },
      },
    },
  },
}
