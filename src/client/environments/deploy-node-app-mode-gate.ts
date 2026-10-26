/**
 * An app whose application mode is neither `production` nor `development`
 * (`x-turbopanel.appMode: staging`, ...) only goes to a daemon that advertises
 * `custom-node-app-mode-v1`. An older daemon would refuse the whole
 * environment deploy at parse time, so the panel refuses first, naming the
 * app, and nothing is sent.
 */
import type { Db } from '../../db/connection.ts'
import { getServerDaemonStateByServerId } from '../../features/servers/server-identity-db.ts'
import { CUSTOM_NODE_APP_MODE_FEATURE } from '../../lib/version-wire.ts'

export { CUSTOM_NODE_APP_MODE_FEATURE }

export type NodeAppModeFeatureError = {
  kind: 'node_app_mode_feature_missing'
  composeServiceName: string
  appMode: string
}

type NodeAppModeGateApp = { composeServiceName: string; appMode?: string }

/** The modes every daemon has always taken. */
const MAIN_APP_MODES: ReadonlySet<string> = new Set(['production', 'development'])

function firstCustomModeApp(
  apps: readonly NodeAppModeGateApp[]
): (NodeAppModeGateApp & { appMode: string }) | undefined {
  for (const app of apps) {
    if (app.appMode !== undefined && !MAIN_APP_MODES.has(app.appMode)) {
      return { ...app, appMode: app.appMode }
    }
  }
  return undefined
}

/** Pure check: the first app with a custom mode, when the daemon lacks the feature. */
export function nodeAppNeedingCustomModeFeature(
  apps: readonly NodeAppModeGateApp[],
  features: readonly string[]
): NodeAppModeFeatureError | undefined {
  if (features.includes(CUSTOM_NODE_APP_MODE_FEATURE)) return undefined
  const app = firstCustomModeApp(apps)
  return app
    ? {
        kind: 'node_app_mode_feature_missing',
        composeServiceName: app.composeServiceName,
        appMode: app.appMode,
      }
    : undefined
}

/** Looks the daemon up only when an app in the deploy has a custom mode. */
export async function withCustomNodeAppModes(
  db: Db,
  serverId: string,
  apps: readonly NodeAppModeGateApp[],
  loadFeatures: (db: Db, serverId: string) => Promise<readonly string[]> = loadDaemonFeatures
): Promise<NodeAppModeFeatureError | { ok: true }> {
  if (firstCustomModeApp(apps) === undefined) return { ok: true }
  return nodeAppNeedingCustomModeFeature(apps, await loadFeatures(db, serverId)) ?? { ok: true }
}

async function loadDaemonFeatures(db: Db, serverId: string): Promise<readonly string[]> {
  const state = await getServerDaemonStateByServerId(db, serverId)
  return state?.projection?.features ?? []
}
