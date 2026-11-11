import { assertEquals } from '@std/assert'
import type { EnvironmentDeployHosting } from '../../contracts/commands/schemas.ts'
import type { ResolvedVariableMap } from '../../features/variables/resolve-inherited.ts'
import {
  applyDeliveryToMap,
  type CacheDelivery,
  deliveryRowsFor,
  EMPTY_CACHE_DELIVERY,
  withCacheHostingEnv,
} from './deploy-caches.ts'
import {
  CACHE_A,
  cacheRowFixture,
  deriveTestSecrets,
} from '../../features/caches/fixtures.test.support.ts'

const test = Deno.test.bind(Deno)

async function delivery(): Promise<CacheDelivery> {
  const secrets = await deriveTestSecrets()
  const row = await cacheRowFixture(secrets)
  return {
    rows: new Map([[CACHE_A, row]]),
    consumers: new Map([['web', [CACHE_A]]]),
    helperVars: new Map([['worker', { TURBOPANEL_HELPER_SEARCH_PORT: '18101' }]]),
  }
}

test('rows are the service caches in delivery order; a stranger gets none', async () => {
  const d = await delivery()
  assertEquals(deliveryRowsFor(d, 'web').length, 1)
  assertEquals(deliveryRowsFor(d, 'other').length, 0)
  assertEquals(deliveryRowsFor(EMPTY_CACHE_DELIVERY, 'web').length, 0)
})

test('a consumer map gets cache entries; a helper consumer gets plain helper entries', async () => {
  const secrets = await deriveTestSecrets()
  const d = await delivery()
  const web: ResolvedVariableMap = new Map()
  await applyDeliveryToMap(secrets, d, 'web', web, [])
  assertEquals(web.get('REDIS_USERNAME')?.value, 'app')
  const worker: ResolvedVariableMap = new Map()
  await applyDeliveryToMap(secrets, d, 'worker', worker, [])
  assertEquals(worker.get('TURBOPANEL_HELPER_SEARCH_PORT')?.value, '18101')
  assertEquals(worker.get('TURBOPANEL_HELPER_SEARCH_PORT')?.isSecret, false)
  assertEquals(worker.has('REDIS_HOST'), false)
})

function hosting(name: string, web?: EnvironmentDeployHosting['web']): EnvironmentDeployHosting {
  return {
    hostingId: `hosting-${name}`,
    serviceId: `service-${name}`,
    composeServiceName: name,
    hostnames: [],
    ...(web ? { web } : {}),
  } as EnvironmentDeployHosting
}

test('hosting web environments get the entries before sealing, others pass through untouched', async () => {
  const secrets = await deriveTestSecrets()
  const d = await delivery()
  const row = d.rows.get(CACHE_A)
  const [withCache, untouched] = await withCacheHostingEnv(
    [hosting('web', { env: { KEEP: '1' } }), hosting('other')],
    secrets,
    d
  )
  assertEquals(withCache?.web?.env?.KEEP, '1')
  assertEquals(withCache?.web?.env?.REDIS_USERNAME, 'app')
  assertEquals(withCache?.web?.env?.REDIS_PORT, '0')
  // The password stays a sealed envelope, under the secret names only.
  assertEquals(withCache?.web?.secretEnv?.REDIS_PASSWORD, row?.password)
  assertEquals(withCache?.web?.env?.REDIS_PASSWORD, undefined)
  assertEquals(untouched?.web, undefined)
})

test('a helper consumer hosting gets the plain helper variables', async () => {
  const secrets = await deriveTestSecrets()
  const [entry] = await withCacheHostingEnv([hosting('worker')], secrets, await delivery())
  assertEquals(entry?.web?.env?.TURBOPANEL_HELPER_SEARCH_PORT, '18101')
  assertEquals(entry?.web?.secretEnv, undefined)
})

test('a cache name replaces an inherited secret of the same name and says so', async () => {
  const secrets = await deriveTestSecrets()
  const warnings: Array<{ code: 'cache_variable_overrides'; key: string }> = []
  const [entry] = await withCacheHostingEnv(
    [hosting('web', { secretEnv: { REDIS_HOST: 'sealed-old' }, env: { REDIS_PORT: '1' } })],
    secrets,
    await delivery(),
    warnings
  )
  assertEquals(entry?.web?.secretEnv?.REDIS_HOST, undefined)
  assertEquals(entry?.web?.env?.REDIS_PORT, '0')
  assertEquals(warnings.map((warning) => warning.key).toSorted(), ['REDIS_HOST', 'REDIS_PORT'])
  assertEquals(entry?.web?.env?.REDIS_HOST?.startsWith('/run/turbopanel-cache-'), true)
})
