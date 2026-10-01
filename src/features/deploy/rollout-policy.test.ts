import { assertAlmostEquals, assertEquals } from '@std/assert'
import {
  DEFAULT_ROLLOUT_POLICY,
  parseComposeDurationSeconds,
  parseUpdateConfig,
  resolveRolloutPolicy,
} from './rollout-policy.ts'

const test = Deno.test.bind(Deno)

test('default rollout is one host at a time, halting on failure', () => {
  assertEquals(DEFAULT_ROLLOUT_POLICY.parallelism, 1)
  assertEquals(DEFAULT_ROLLOUT_POLICY.failureAction, 'halt')
  assertEquals(resolveRolloutPolicy(undefined), {
    policy: DEFAULT_ROLLOUT_POLICY,
    declaredBy: [],
    invalid: [],
  })
  assertEquals(resolveRolloutPolicy({ web: { image: 'x' } }).policy, DEFAULT_ROLLOUT_POLICY)
})

test('parseComposeDurationSeconds reads compose durations and bare seconds', () => {
  assertEquals(parseComposeDurationSeconds('10s'), 10)
  assertEquals(parseComposeDurationSeconds('1m30s'), 90)
  assertEquals(parseComposeDurationSeconds('1h2m3s'), 3723)
  assertAlmostEquals(parseComposeDurationSeconds('500ms') ?? 0, 0.5)
  assertEquals(parseComposeDurationSeconds(7), 7)
  assertEquals(parseComposeDurationSeconds(0), 0)
})

test('parseComposeDurationSeconds rejects everything else', () => {
  for (const value of ['', 'abc', '10', '10x', 's10', '1m 30s', -1, Number.NaN, null, {}, true]) {
    assertEquals(parseComposeDurationSeconds(value), null)
  }
})

test('parseUpdateConfig maps the swarm stanza', () => {
  assertEquals(
    parseUpdateConfig({
      parallelism: 2,
      delay: '10s',
      failure_action: 'continue',
      monitor: '1m',
      max_failure_ratio: 0.25,
      order: 'start-first',
    }),
    {
      ok: true,
      value: {
        parallelism: 2,
        delaySeconds: 10,
        failureAction: 'continue',
        monitorSeconds: 60,
        maxFailureRatio: 0.25,
        order: 'start-first',
      },
    }
  )
})

test('failure_action pause and rollback both halt the rollout', () => {
  for (const action of ['pause', 'rollback']) {
    assertEquals(parseUpdateConfig({ failure_action: action }), {
      ok: true,
      value: { failureAction: 'halt' },
    })
  }
})

test('parallelism 0 means every host at once', () => {
  assertEquals(parseUpdateConfig({ parallelism: 0 }), { ok: true, value: { parallelism: 0 } })
})

test('parseUpdateConfig reports every problem', () => {
  assertEquals(
    parseUpdateConfig({
      parallelism: -1,
      delay: 'soon',
      monitor: 'x',
      failure_action: 'explode',
      max_failure_ratio: 2,
      order: 'middle',
      bogus: 1,
    }),
    {
      ok: false,
      reasons: [
        'parallelism must be a non-negative integer',
        'delay must be a duration such as 10s or 1m30s',
        'monitor must be a duration such as 10s or 1m30s',
        'failure_action must be pause, continue or rollback',
        'max_failure_ratio must be a number from 0 to 1',
        'order must be stop-first or start-first',
        'update_config.bogus is not a known setting',
      ],
    }
  )
  for (const bad of [null, 'x', 3, []]) {
    assertEquals(parseUpdateConfig(bad), {
      ok: false,
      reasons: ['update_config must be a mapping'],
    })
  }
})

test('one service declaring update_config sets the policy over the defaults', () => {
  const result = resolveRolloutPolicy({
    web: { deploy: { update_config: { parallelism: 3, delay: '5s' } } },
    db: { image: 'x' },
  })
  assertEquals(result.declaredBy, ['web'])
  assertEquals(result.policy, { ...DEFAULT_ROLLOUT_POLICY, parallelism: 3, delaySeconds: 5 })
})

test('several services: the most conservative value of each field wins', () => {
  const result = resolveRolloutPolicy({
    a: {
      deploy: {
        update_config: {
          parallelism: 4,
          delay: '5s',
          monitor: '10s',
          failure_action: 'continue',
          max_failure_ratio: 0.5,
          order: 'start-first',
        },
      },
    },
    b: {
      deploy: {
        update_config: {
          parallelism: 2,
          delay: '30s',
          monitor: '2s',
          failure_action: 'pause',
          max_failure_ratio: 0.1,
          order: 'stop-first',
        },
      },
    },
  })
  assertEquals(result.declaredBy, ['a', 'b'])
  assertEquals(result.policy, {
    parallelism: 2,
    delaySeconds: 30,
    monitorSeconds: 10,
    failureAction: 'halt',
    maxFailureRatio: 0.1,
    order: 'stop-first',
  })
})

test('parallelism 0 loses to a finite value in either order', () => {
  const zeroFirst = resolveRolloutPolicy({
    a: { deploy: { update_config: { parallelism: 0 } } },
    b: { deploy: { update_config: { parallelism: 2 } } },
  })
  const zeroLast = resolveRolloutPolicy({
    a: { deploy: { update_config: { parallelism: 2 } } },
    b: { deploy: { update_config: { parallelism: 0 } } },
  })
  assertEquals(zeroFirst.policy.parallelism, 2)
  assertEquals(zeroLast.policy.parallelism, 2)
})

test('a continue-only environment continues; an invalid stanza is reported, not merged', () => {
  const result = resolveRolloutPolicy({
    a: { deploy: { update_config: { failure_action: 'continue' } } },
    bad: { deploy: { update_config: { parallelism: 'many' } } },
    notAMap: 'x',
  })
  assertEquals(result.policy.failureAction, 'continue')
  assertEquals(result.declaredBy, ['a'])
  assertEquals(result.invalid, [
    { service: 'bad', reasons: ['parallelism must be a non-negative integer'] },
  ])
})
