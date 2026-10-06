import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import {
  DENO_NATIVE_APPS_FEATURE,
  denoAppNeedingFeature,
  denoAppWithUnsupportedVersion,
  withDenoNativeApps,
} from './deploy-deno-gate.ts'
import { mapPrepareErrorResponse } from './deploy-routes-helpers.ts'
import { nativeAppDenoVersionViews } from './deploy-prepare.ts'
import { DAEMON_WIRE_FEATURES } from '../../lib/version-wire.ts'

const test = Deno.test.bind(Deno)
const db = {} as Db

const deno = { composeServiceName: 'api', runtime: 'deno' as const }
const node = { composeServiceName: 'web' }

test('the feature string is in the panel wire list', () => {
  assertEquals((DAEMON_WIRE_FEATURES as readonly string[]).includes(DENO_NATIVE_APPS_FEATURE), true)
})

test('a Deno app is refused for a daemon without the feature; Node apps never are', () => {
  assertEquals(denoAppNeedingFeature([node, deno], []), {
    kind: 'deno_feature_missing',
    composeServiceName: 'api',
  })
  assertEquals(denoAppNeedingFeature([deno], ['managed-upgrade-v1']) !== undefined, true)
  assertEquals(denoAppNeedingFeature([deno], [DENO_NATIVE_APPS_FEATURE]), undefined)
  assertEquals(denoAppNeedingFeature([node], []), undefined)
})

test('a Deno series nothing here offers is refused, and every spelling of 2 is not', () => {
  assertEquals(denoAppWithUnsupportedVersion([{ ...deno, denoVersion: '3' }]), {
    kind: 'deno_version_unsupported',
    composeServiceName: 'api',
    requested: '3',
    supported: ['2'],
  })
  for (const denoVersion of [undefined, '2', '2.9', '2.9.7']) {
    assertEquals(denoAppWithUnsupportedVersion([{ ...deno, denoVersion }]), undefined)
  }
  // The version of a Node app is nobody's business here.
  assertEquals(denoAppWithUnsupportedVersion([{ ...node, denoVersion: '9' }]), undefined)
})

test('the daemon is looked up only when a Deno app is in the deploy, after the version check', async () => {
  let lookups = 0
  const load = () => {
    lookups++
    return Promise.resolve([] as readonly string[])
  }
  assertEquals(await withDenoNativeApps(db, 's1', [node], load), { ok: true })
  assertEquals(lookups, 0)
  const unsupported = await withDenoNativeApps(db, 's1', [{ ...deno, denoVersion: '3' }], load)
  assertEquals('kind' in unsupported && unsupported.kind, 'deno_version_unsupported')
  assertEquals(lookups, 0)
  assertEquals('kind' in (await withDenoNativeApps(db, 's1', [deno], load)), true)
  assertEquals(lookups, 1)
  assertEquals(
    await withDenoNativeApps(db, 's1', [deno], () => Promise.resolve([DENO_NATIVE_APPS_FEATURE])),
    { ok: true }
  )
})

test('both refusals are 422s in plain words', () => {
  const missing = mapPrepareErrorResponse({
    kind: 'deno_feature_missing',
    composeServiceName: 'api',
  })
  assertEquals(missing.status, 422)
  assertEquals((missing.body as { error: string }).error, 'deno_feature_missing')
  assertEquals(String((missing.body as { message: string }).message).includes('too old'), true)
  const unsupported = mapPrepareErrorResponse({
    kind: 'deno_version_unsupported',
    composeServiceName: 'api',
    requested: '3',
    supported: ['2'],
  })
  assertEquals(unsupported.status, 422)
  assertEquals((unsupported.body as { supported: string[] }).supported, ['2'])
  assertEquals(String((unsupported.body as { message: string }).message).includes('Deno 3'), true)
})

test('a database without the Deno migration is a 422 in plain words', () => {
  const mapped = mapPrepareErrorResponse({ kind: 'deno_migration_pending' })
  assertEquals(mapped.status, 422)
  assertEquals((mapped.body as { error: string }).error, 'deno_migration_pending')
  assertEquals(String((mapped.body as { message: string }).message).includes('migration'), true)
})

test('the preview lists each Deno app once with its series and where it came from', () => {
  assertEquals(
    nativeAppDenoVersionViews([
      { composeServiceName: 'web' },
      { composeServiceName: 'api', runtime: 'deno' },
      { composeServiceName: 'jobs', runtime: 'deno', denoVersion: '2.9.7' },
    ]),
    [
      { composeServiceName: 'api', denoVersion: '2', source: 'default' },
      { composeServiceName: 'jobs', denoVersion: '2', source: 'compose' },
    ]
  )
})
