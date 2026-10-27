import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import {
  CUSTOM_NODE_APP_MODE_FEATURE,
  nodeAppNeedingCustomModeFeature,
  withCustomNodeAppModes,
} from './deploy-node-app-mode-gate.ts'
import { mapPrepareErrorResponse } from './deploy-routes-helpers.ts'
import { DAEMON_WIRE_FEATURES } from '../../lib/version-wire.ts'

const test = Deno.test.bind(Deno)
const db = {} as Db

const staging = { composeServiceName: 'api', appMode: 'staging' }
const production = { composeServiceName: 'web', appMode: 'production' }
const development = { composeServiceName: 'admin', appMode: 'development' }
const unset = { composeServiceName: 'docs' }

test('the feature string is in the panel wire list', () => {
  assertEquals(
    (DAEMON_WIRE_FEATURES as readonly string[]).includes(CUSTOM_NODE_APP_MODE_FEATURE),
    true
  )
})

test('a custom mode is refused for a daemon without the feature', () => {
  assertEquals(nodeAppNeedingCustomModeFeature([production, staging], []), {
    kind: 'node_app_mode_feature_missing',
    composeServiceName: 'api',
    appMode: 'staging',
  })
  assertEquals(
    nodeAppNeedingCustomModeFeature([staging], ['deno-native-apps-v1']) !== undefined,
    true
  )
})

test('a custom mode is allowed for a daemon with the feature', () => {
  assertEquals(
    nodeAppNeedingCustomModeFeature([staging], [CUSTOM_NODE_APP_MODE_FEATURE]),
    undefined
  )
})

test('production, development and no mode are never refused', () => {
  assertEquals(nodeAppNeedingCustomModeFeature([production, development, unset], []), undefined)
})

test('the daemon is looked up only when an app has a custom mode', async () => {
  let lookups = 0
  const load = () => {
    lookups++
    return Promise.resolve([] as readonly string[])
  }
  assertEquals(await withCustomNodeAppModes(db, 's1', [production, development, unset], load), {
    ok: true,
  })
  assertEquals(lookups, 0)
  const refused = await withCustomNodeAppModes(db, 's1', [staging], load)
  assertEquals('kind' in refused && refused.kind, 'node_app_mode_feature_missing')
  assertEquals(lookups, 1)
  assertEquals(
    await withCustomNodeAppModes(db, 's1', [staging], () =>
      Promise.resolve([CUSTOM_NODE_APP_MODE_FEATURE])
    ),
    { ok: true }
  )
})

test('the refusal is a 422 in plain words that names the app and says to update', () => {
  const response = mapPrepareErrorResponse({
    kind: 'node_app_mode_feature_missing',
    composeServiceName: 'api',
    appMode: 'staging',
  })
  assertEquals(response.status, 422)
  const body = response.body as { error: string; message: string; appMode: string }
  assertEquals(body.error, 'node_app_mode_feature_missing')
  assertEquals(body.appMode, 'staging')
  assertEquals(body.message.includes('App "api"'), true)
  assertEquals(body.message.includes('"staging"'), true)
  assertEquals(body.message.includes('Update the daemon on this server'), true)
})
