import { assertEquals } from '@std/assert'
import { BLUEGREEN_UNAVAILABLE_REASON, planDeployEngine } from './deploy-engine.ts'

/** Jest/Mocha-shaped alias so Sonar sees real tests (see health-gate tests in turbopaneld). */
const test = Deno.test.bind(Deno)

const WEB = { services: { web: { image: 'nginx:alpine' } } }
const WITH_DB = {
  services: {
    web: { image: 'nginx:alpine' },
    db: { image: 'postgres:17', volumes: ['pgdata:/var/lib/postgresql/data'] },
  },
}

function plan(
  environmentOptions: unknown,
  composeData: Record<string, unknown> = WEB,
  override?: Parameters<typeof planDeployEngine>[0]['override']
) {
  return planDeployEngine({ environmentOptions, projectOptions: undefined, composeData, override })
}

test('an environment with no strategy stays inplace and sends nothing extra', () => {
  const result = plan({})
  assertEquals(result.effectiveStrategy, 'inplace')
  assertEquals(result.payload, {})
  assertEquals(result.fallbackReasons, [])
})

test('sequential sends the strategy, migration status and the 120 s default gate', () => {
  const result = plan({ deployStrategy: 'sequential' })
  assertEquals(result.effectiveStrategy, 'sequential')
  assertEquals(result.payload, {
    deployStrategy: 'sequential',
    migrations: 'unknown',
    healthTimeoutSeconds: 120,
  })
})

test('the environment health timeout and migration status are forwarded', () => {
  const result = plan({
    deployStrategy: 'sequential',
    healthTimeoutSeconds: 45,
    migrations: 'breaking',
  })
  assertEquals(result.payload.healthTimeoutSeconds, 45)
  assertEquals(result.payload.migrations, 'breaking')
})

test('stateful services with a writable volume are kept running during the stop', () => {
  const result = plan({ deployStrategy: 'sequential' }, WITH_DB)
  assertEquals(result.payload.keepRunningServices, ['db'])
})

test('a per-deploy override beats the stored setting, both ways', () => {
  assertEquals(
    plan({ deployStrategy: 'sequential' }, WEB, { strategy: 'inplace' }).effectiveStrategy,
    'inplace'
  )
  assertEquals(plan({}, WEB, { strategy: 'sequential' }).effectiveStrategy, 'sequential')
})

test('blue-green is never sent to the daemon: it runs sequential and says why', () => {
  const clear = plan({ deployStrategy: 'bluegreen', migrations: 'compatible' })
  assertEquals(clear.requested, 'bluegreen')
  assertEquals(clear.effectiveStrategy, 'sequential')
  assertEquals(clear.payload.deployStrategy, 'sequential')
  assertEquals(clear.fallbackReasons, [BLUEGREEN_UNAVAILABLE_REASON])

  const refused = plan({ deployStrategy: 'bluegreen' })
  assertEquals(
    refused.fallbackReasons.map((reason) => reason.code),
    ['migration_unknown', 'bluegreen_unavailable']
  )
})
