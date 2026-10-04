import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import {
  SITE_ENGINE_NGINX_APACHE_FEATURE,
  siteNeedingEngineFeature,
  withSiteEngineFeature,
} from './deploy-site-engine-gate.ts'
import { mapPrepareErrorResponse } from './deploy-routes-helpers.ts'
import { DAEMON_WIRE_FEATURES } from '../../lib/version-wire.ts'

const test = Deno.test.bind(Deno)
const db = {} as Db

const paired = { composeServiceName: 'blog', engine: 'nginx+apache' as const, backendPort: 19100 }
const plain = { composeServiceName: 'docs', engine: 'nginx' as const }

test('the feature string is in the panel wire list', () => {
  assertEquals(
    (DAEMON_WIRE_FEATURES as readonly string[]).includes(SITE_ENGINE_NGINX_APACHE_FEATURE),
    true
  )
})

test('refuses nginx+apache or backendPort for a daemon without the feature', () => {
  assertEquals(siteNeedingEngineFeature([plain, paired], []), {
    kind: 'site_engine_feature_missing',
    composeServiceName: 'blog',
  })
  assertEquals(
    siteNeedingEngineFeature([{ ...plain, backendPort: 19101 }], ['managed-upgrade-v1']),
    { kind: 'site_engine_feature_missing', composeServiceName: 'docs' }
  )
})

test('allows them when the daemon lists the feature, and plain sites always', () => {
  assertEquals(siteNeedingEngineFeature([paired], [SITE_ENGINE_NGINX_APACHE_FEATURE]), undefined)
  assertEquals(siteNeedingEngineFeature([plain], []), undefined)
})

test('looks the daemon up only when a site needs the feature', async () => {
  let lookups = 0
  const load = () => {
    lookups++
    return Promise.resolve([] as readonly string[])
  }
  assertEquals(await withSiteEngineFeature(db, 's1', [plain], load), { ok: true })
  assertEquals(lookups, 0)
  assertEquals('kind' in (await withSiteEngineFeature(db, 's1', [paired], load)), true)
  assertEquals(lookups, 1)
})

test('the refusal is a 422 in plain words', () => {
  const mapped = mapPrepareErrorResponse({
    kind: 'site_engine_feature_missing',
    composeServiceName: 'blog',
  })
  assertEquals(mapped.status, 422)
  assertEquals((mapped.body as { error: string }).error, 'site_engine_feature_missing')
  assertEquals(String((mapped.body as { message: string }).message).includes('too old'), true)
})
