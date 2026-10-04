import { assertEquals } from '@std/assert'
import {
  DEPLOY_INTEGER_LIMITS,
  parseDeployOptions,
  parseDeployStrategyInput,
  parseMigrationStatusInput,
  resolveDeployOptions,
  settleDeployOptions,
  stampNewEnvironmentDeployOptions,
  validateDeployOptions,
} from './deploy-options.ts'

const test = Deno.test.bind(Deno)

test('resolveDeployOptions defaults: existing environments stay inplace, migrations unknown, old generation retired at once', () => {
  assertEquals(resolveDeployOptions(null), {
    deployStrategy: 'inplace',
    migrations: 'unknown',
    drainSeconds: 30,
    healthTimeoutSeconds: 120,
    rollbackWindowMinutes: 0,
  })
  assertEquals(resolveDeployOptions({ compose: { version: 1 } }).deployStrategy, 'inplace')
})

test('resolveDeployOptions: environment beats project beats default for tuning knobs', () => {
  const resolved = resolveDeployOptions(
    { deployStrategy: 'bluegreen', migrations: 'compatible', drainSeconds: 5 },
    { drainSeconds: 99, healthTimeoutSeconds: 60, rollbackWindowMinutes: 10 }
  )
  assertEquals(resolved.deployStrategy, 'bluegreen')
  assertEquals(resolved.migrations, 'compatible')
  assertEquals(resolved.drainSeconds, 5)
  assertEquals(resolved.healthTimeoutSeconds, 60)
  assertEquals(resolved.rollbackWindowMinutes, 10)
})

test('resolveDeployOptions ignores a project-level strategy and migration status', () => {
  const resolved = resolveDeployOptions(null, { deployStrategy: 'bluegreen', migrations: 'none' })
  assertEquals(resolved.deployStrategy, 'inplace')
  assertEquals(resolved.migrations, 'unknown')
})

test('parseDeployOptions drops invalid and out-of-range values instead of throwing', () => {
  assertEquals(parseDeployOptions('nope'), {})
  assertEquals(parseDeployOptions([]), {})
  assertEquals(
    parseDeployOptions({
      deployStrategy: 'rolling',
      migrations: 'maybe',
      drainSeconds: -1,
      healthTimeoutSeconds: 1.5,
      rollbackWindowMinutes: 1441,
    }),
    {}
  )
  assertEquals(parseDeployOptions({ deployStrategy: 'sequential', drainSeconds: 0 }), {
    deployStrategy: 'sequential',
    drainSeconds: 0,
  })
})

test('input parsers accept exactly the listed values', () => {
  for (const value of ['inplace', 'sequential', 'bluegreen'] as const) {
    assertEquals(parseDeployStrategyInput(value), { ok: true, value })
  }
  for (const value of ['none', 'compatible', 'breaking', 'unknown'] as const) {
    assertEquals(parseMigrationStatusInput(value), { ok: true, value })
  }
  for (const value of ['', 'Sequential', 'blue-green', 1, null, undefined, {}]) {
    assertEquals(parseDeployStrategyInput(value), { ok: false })
    assertEquals(parseMigrationStatusInput(value), { ok: false })
  }
})

test('validateDeployOptions accepts valid environment settings and null clears', () => {
  const options = {
    compose: {},
    deployStrategy: 'bluegreen',
    migrations: null,
    rollbackWindowMinutes: 10,
  }
  assertEquals(validateDeployOptions(options, 'environment'), { ok: true })
  // Validation never mutates; clearing is settleDeployOptions' job.
  assertEquals(options.migrations, null)
})

test('validateDeployOptions refuses invalid values with a reason naming the key', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ deployStrategy: 'rolling' }, 'deployStrategy must be one of inplace, sequential, bluegreen'],
    [{ migrations: 'maybe' }, 'migrations must be one of none, compatible, breaking, unknown'],
    [{ drainSeconds: -1 }, 'drainSeconds must be an integer from 0 to 3600'],
    [{ drainSeconds: 1.5 }, 'drainSeconds must be an integer from 0 to 3600'],
    [{ drainSeconds: '5' }, 'drainSeconds must be an integer from 0 to 3600'],
    [{ healthTimeoutSeconds: 9 }, 'healthTimeoutSeconds must be an integer from 10 to 3600'],
    [{ rollbackWindowMinutes: 1441 }, 'rollbackWindowMinutes must be an integer from 0 to 1440'],
  ]
  for (const [options, reason] of cases) {
    assertEquals(validateDeployOptions(options, 'environment'), { ok: false, reason })
  }
})

test('validateDeployOptions accepts the limits themselves', () => {
  for (const [key, limit] of Object.entries(DEPLOY_INTEGER_LIMITS)) {
    assertEquals(validateDeployOptions({ [key]: limit.min }, 'environment'), { ok: true })
    assertEquals(validateDeployOptions({ [key]: limit.max }, 'environment'), { ok: true })
  }
})

test('validateDeployOptions refuses environment-only keys on a project', () => {
  assertEquals(validateDeployOptions({ deployStrategy: 'sequential' }, 'project'), {
    ok: false,
    reason: 'deployStrategy can only be set on an environment',
  })
  assertEquals(validateDeployOptions({ migrations: 'none' }, 'project'), {
    ok: false,
    reason: 'migrations can only be set on an environment',
  })
  assertEquals(validateDeployOptions({ rollbackWindowMinutes: 10 }, 'project'), { ok: true })
})

test('settleDeployOptions keeps stored keys the body omits, replaces named ones, clears null', () => {
  const stored = { deployStrategy: 'sequential', migrations: 'none', drainSeconds: 10, compose: 1 }
  const settled = settleDeployOptions(stored, { compose: 2, migrations: 'breaking' }, 'environment')
  assertEquals(settled, {
    compose: 2,
    migrations: 'breaking',
    deployStrategy: 'sequential',
    drainSeconds: 10,
  })
  assertEquals(settleDeployOptions(stored, { compose: 2, deployStrategy: null }, 'environment'), {
    compose: 2,
    migrations: 'none',
    drainSeconds: 10,
  })
  // Input is untouched.
  assertEquals(Object.keys(stored).length, 4)
})

test('settleDeployOptions on a project only carries tuning keys', () => {
  const stored = {
    rollbackWindowMinutes: 5,
    deployStrategy: 'bluegreen',
    containerNaming: 'custom',
  }
  assertEquals(settleDeployOptions(stored, { compose: 1 }, 'project'), {
    compose: 1,
    rollbackWindowMinutes: 5,
  })
})

test('settleDeployOptions with nothing stored drops nulls and tolerates junk', () => {
  assertEquals(settleDeployOptions(null, { deployStrategy: null, compose: 1 }, 'environment'), {
    compose: 1,
  })
  assertEquals(settleDeployOptions('junk', { compose: 1 }, 'environment'), { compose: 1 })
})

test('stampNewEnvironmentDeployOptions defaults a new environment to sequential', () => {
  assertEquals(stampNewEnvironmentDeployOptions(null), { deployStrategy: 'sequential' })
  assertEquals(stampNewEnvironmentDeployOptions({ compose: 1 }), {
    compose: 1,
    deployStrategy: 'sequential',
  })
})

test('stampNewEnvironmentDeployOptions keeps a strategy the caller chose and does not mutate', () => {
  const chosen = { deployStrategy: 'inplace' }
  assertEquals(stampNewEnvironmentDeployOptions(chosen), { deployStrategy: 'inplace' })
  const base = { compose: 1 }
  stampNewEnvironmentDeployOptions(base)
  assertEquals(base, { compose: 1 })
})
