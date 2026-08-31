import { assertEquals } from '@std/assert'
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
    maxReplicasPerNode: null,
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
    maxReplicasPerNode: null,
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

test('interpretServiceSchedule reads placement.max_replicas_per_node', () => {
  assertEquals(
    interpretServiceSchedule('web', {
      deploy: { replicas: 4, placement: { max_replicas_per_node: 2 } },
    }, 1).maxReplicasPerNode,
    2,
  )
  // Compose allows the string form.
  assertEquals(
    interpretServiceSchedule('web', {
      deploy: { placement: { max_replicas_per_node: '3' } },
    }, 1).maxReplicasPerNode,
    3,
  )
  // "Place nowhere" is not a cap an author can have meant, so it reads as
  // absent rather than becoming a refusal this module has no voice for.
  for (const value of [0, -1, 'two', 1.5, null]) {
    assertEquals(
      interpretServiceSchedule('web', {
        deploy: { placement: { max_replicas_per_node: value } },
      }, 1).maxReplicasPerNode,
      null,
    )
  }
  assertEquals(
    interpretServiceSchedule('web', { deploy: {} }, 1).maxReplicasPerNode,
    null,
  )
})

test('resources.reservations is not a scheduler input at all', () => {
  // Refused at deploy time by `../compose/field-policy.ts` rather than read
  // here and ignored by the planner — the platform has no per-host capacity
  // inventory to admit a reservation against. Nothing on the spec carries it,
  // so a future capacity-aware pass cannot mistake a parsed-and-unused value
  // for one something acts on.
  const spec = interpretServiceSchedule('web', {
    deploy: {
      resources: {
        limits: { cpus: '2' },
        reservations: { cpus: '0.5', memory: '512M' },
      },
    },
  }, 1)
  assertEquals('reservations' in spec, false)
})
