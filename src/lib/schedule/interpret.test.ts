import { assertEquals } from 'jsr:@std/assert'
import {
  interpretComposeSchedule,
  interpretServiceSchedule,
  resolveReplicaPolicy,
} from './interpret.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('resolveReplicaPolicy prefers deploy.replicas then instances then 1', () => {
  assertEquals(resolveReplicaPolicy({ deploy: { replicas: 3 } }, 9), {
    mode: 'replicated',
    replicas: 3,
  })
  assertEquals(resolveReplicaPolicy({ deploy: { replicas: '2' } }, 9), {
    mode: 'replicated',
    replicas: 2,
  })
  assertEquals(resolveReplicaPolicy({}, 4), { mode: 'replicated', replicas: 4 })
  assertEquals(resolveReplicaPolicy({}, 0), { mode: 'replicated', replicas: 1 })
  assertEquals(resolveReplicaPolicy({ deploy: { mode: 'global', replicas: 99 } }, 4), {
    mode: 'global',
    replicas: 1,
  })
})

test('interpretServiceSchedule parses constraints, spreads, ports, and colocation', () => {
  const spec = interpretServiceSchedule(
    'web',
    {
      deploy: {
        replicas: 2,
        placement: {
          constraints: [
            'node.labels.zone == east',
            'node.labels.tier != canary',
            'not-a-constraint',
            12,
          ],
          preferences: [
            { spread: 'node.labels.zone' },
            { spread: 'node.labels.' },
            { spread: 'hostname' },
            'skip',
          ],
        },
      },
      ports: [
        8080,
        '8443:443',
        { published: 9000 },
        'bad-range',
        '70000',
        '80-90:80',
      ],
      network_mode: 'service:db',
      pid: 'service:db',
      ipc: 'service:cache',
    },
    1,
  )

  assertEquals(spec, {
    composeServiceName: 'web',
    mode: 'replicated',
    replicas: 2,
    constraints: [
      { key: 'zone', op: 'eq', value: 'east' },
      { key: 'tier', op: 'neq', value: 'canary' },
    ],
    spreadKeys: ['zone'],
    publishedHostPorts: [8080, 8443, 9000],
    colocateWith: ['db', 'cache'],
  })
})

test('interpretServiceSchedule defaults when deploy is absent or non-object', () => {
  assertEquals(interpretServiceSchedule('api', { image: 'nginx' }, 5), {
    composeServiceName: 'api',
    mode: 'replicated',
    replicas: 5,
    constraints: [],
    spreadKeys: [],
    publishedHostPorts: [],
    colocateWith: [],
  })
  assertEquals(
    interpretServiceSchedule('api', { deploy: 'nope' }, 1).replicas,
    1,
  )
})

test('interpretComposeSchedule skips non-object services and uses per-name instances', () => {
  const specs = interpretComposeSchedule(
    {
      web: { deploy: { replicas: 2 } },
      db: { image: 'postgres' },
      broken: 'string-service',
    },
    new Map([['db', 3]]),
  )
  assertEquals(specs.map((row) => [row.composeServiceName, row.replicas]), [
    ['web', 2],
    ['db', 3],
  ])
})
