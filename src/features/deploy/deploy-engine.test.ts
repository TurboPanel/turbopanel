import { assertEquals } from '@std/assert'
import { BLUEGREEN_UNAVAILABLE_REASON, planDeployEngine, rolloutSummary } from './deploy-engine.ts'

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

test('rollout parallelism: sequential reads update_config, default one at a time', () => {
  assertEquals(plan({ deployStrategy: 'sequential' }).rolloutParallelism, 1)
  const wide = {
    services: { web: { image: 'nginx', deploy: { update_config: { parallelism: 3 } } } },
  }
  assertEquals(plan({ deployStrategy: 'sequential' }, wide).rolloutParallelism, 3)
  const all = {
    services: { web: { image: 'nginx', deploy: { update_config: { parallelism: 0 } } } },
  }
  assertEquals(plan({ deployStrategy: 'sequential' }, all).rolloutParallelism, 0)
})

test('rollout parallelism: bluegreen runs as sequential and rolls; inplace keeps all-at-once', () => {
  assertEquals(plan({ deployStrategy: 'bluegreen' }).rolloutParallelism, 1)
  assertEquals(plan({}).rolloutParallelism, 0)
})

test('rolloutSummary counts the batches a deploy delivers in order', () => {
  const sequential = plan({ deployStrategy: 'sequential' })
  assertEquals(rolloutSummary(sequential, 3), { parallelism: 1, batches: 3 })
  assertEquals(rolloutSummary(sequential, 0), { parallelism: 1, batches: 0 })
  assertEquals(rolloutSummary(plan({}), 3), { parallelism: 0, batches: 1 })
})

test('an inplace deploy warns that update_config.parallelism is ignored', () => {
  const rolled = {
    services: {
      web: { image: 'nginx:alpine', deploy: { update_config: { parallelism: 2 } } },
      worker: { image: 'busybox' },
    },
  }
  const inplace = plan({}, rolled)
  assertEquals(
    inplace.rolloutWarnings.map((issue) => [issue.level, issue.path, issue.blocking]),
    [['warning', 'services.web.deploy.update_config.parallelism', false]]
  )
  assertEquals(rolloutSummary(inplace, 3).warnings?.length, 1)
  // Sequential reads it, so there is nothing to warn about.
  const sequential = plan({ deployStrategy: 'sequential' }, rolled)
  assertEquals(sequential.rolloutWarnings, [])
  assertEquals(rolloutSummary(sequential, 3), { parallelism: 2, batches: 2 })
  assertEquals(plan({}).rolloutWarnings, [])
})
