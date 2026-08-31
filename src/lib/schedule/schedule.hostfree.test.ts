import { assertEquals } from '@std/assert'
import type { ComposeDocument } from '../compose/types.ts'
import {
  interpretServiceSchedule,
  resolveReplicaPolicy,
} from './interpret.ts'
import {
  localReplicaCounts,
  planEnvironmentSchedule,
  type FleetServer,
  type PlannedService,
} from './planner.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('resolveReplicaPolicy prefers deploy.replicas over instances', () => {
  assertEquals(
    resolveReplicaPolicy({ deploy: { replicas: 3 } }, 2),
    { mode: 'replicated', replicas: 3 },
  )
  assertEquals(
    resolveReplicaPolicy({ deploy: { mode: 'global' } }, 9),
    { mode: 'global', replicas: 1 },
  )
  assertEquals(resolveReplicaPolicy({}, 4), { mode: 'replicated', replicas: 4 })
  assertEquals(resolveReplicaPolicy({}, 0), { mode: 'replicated', replicas: 1 })
})

test('interpretServiceSchedule reads constraints, spread, ports, and colocation', () => {
  const spec = interpretServiceSchedule(
    'web',
    {
      image: 'nginx',
      ports: ['8080:80', { published: 443, target: 443 }],
      network_mode: 'service:lb',
      deploy: {
        replicas: 2,
        placement: {
          constraints: ['node.labels.role == web', 'node.labels.disk != hdd'],
          preferences: [{ spread: 'node.labels.datacenter' }],
        },
      },
    },
    1,
  )
  assertEquals(spec.replicas, 2)
  assertEquals(spec.constraints, [
    { key: 'role', op: 'eq', value: 'web' },
    { key: 'disk', op: 'neq', value: 'hdd' },
  ])
  assertEquals(spec.spreadKeys, ['datacenter'])
  assertEquals(spec.publishedHostPorts, [443, 8080])
  assertEquals(spec.colocateWith, ['lb'])
})

const alpha: FleetServer = {
  id: 'server-a',
  connected: true,
  labels: { role: 'web', datacenter: 'east' },
}
const bravo: FleetServer = {
  id: 'server-b',
  connected: true,
  labels: { role: 'web', datacenter: 'west' },
}
const charlie: FleetServer = {
  id: 'server-c',
  connected: false,
  labels: { role: 'web' },
}

function webService(replicas: number): PlannedService {
  return {
    serviceId: 'svc-web',
    spec: {
      composeServiceName: 'web',
      mode: 'replicated',
      replicas,
      constraints: [],
      spreadKeys: [],
      publishedHostPorts: [],
      colocateWith: [],
      maxReplicasPerNode: null,
    },
  }
}

/** Merged document standing in for one the deploy path would have parsed. */
function composeDoc(data: Record<string, unknown>): ComposeDocument {
  return { version: 1, data, presentation: { keyOrder: [], comments: {} } }
}

test('planEnvironmentSchedule keeps a one-server plan without TurboFabric', () => {
  const plan = planEnvironmentSchedule({
    pinServerId: null,
    defaultServerId: 'server-a',
    fabricEnabled: false,
    servers: [alpha, bravo, charlie],
    services: [webService(2)],
    existingTasks: [],
    storagePins: new Map(),
  })
  assertEquals(plan.ok, true)
  if (!plan.ok) return
  assertEquals(plan.serverIds, ['server-a'])
  assertEquals(plan.slots.length, 2)
  assertEquals(plan.slots.every((task) => task.serverId === 'server-a'), true)
})

function spreadWebService(): PlannedService {
  return {
    serviceId: 'svc-web',
    spec: {
      composeServiceName: 'web',
      mode: 'replicated',
      replicas: 2,
      constraints: [],
      spreadKeys: ['datacenter'],
      publishedHostPorts: [8080],
      colocateWith: [],
      maxReplicasPerNode: null,
    },
  }
}

test('planEnvironmentSchedule requires TurboFabric to span an overlay network', () => {
  const plan = planEnvironmentSchedule({
    pinServerId: null,
    defaultServerId: null,
    fabricEnabled: false,
    servers: [alpha, bravo],
    services: [spreadWebService()],
    existingTasks: [],
    storagePins: new Map(),
    document: composeDoc({
      services: { web: { networks: ['app'] } },
      networks: { app: { driver: 'overlay' } },
    }),
  })
  assertEquals(plan.ok, false)
  if (plan.ok) return
  assertEquals(plan.error, 'turbofabric_required')
})

test('planEnvironmentSchedule spans hosts without TurboFabric for bridge/default networks', () => {
  // Identical placement; the document simply never asked for a network that
  // reaches beyond one engine, so each host gets its own local bridge.
  const plan = planEnvironmentSchedule({
    pinServerId: null,
    defaultServerId: null,
    fabricEnabled: false,
    servers: [alpha, bravo],
    services: [spreadWebService()],
    existingTasks: [],
    storagePins: new Map(),
    document: composeDoc({
      services: { web: { networks: ['app'] } },
      networks: { app: { driver: 'bridge' } },
    }),
  })
  assertEquals(plan.ok, true)
  if (!plan.ok) return
  assertEquals(plan.serverIds, ['server-a', 'server-b'])
})

test('planEnvironmentSchedule spans hosts without TurboFabric when no networks are declared', () => {
  // No `networks:` block at all — the implicit `default` is not overlay, so the
  // plan is two ordinary single-host bridges rather than a fabric request.
  const plan = planEnvironmentSchedule({
    pinServerId: null,
    defaultServerId: null,
    fabricEnabled: false,
    servers: [alpha, bravo],
    services: [spreadWebService()],
    existingTasks: [],
    storagePins: new Map(),
    document: composeDoc({ services: { web: {} } }),
  })
  assertEquals(plan.ok, true)
  if (!plan.ok) return
  assertEquals(plan.serverIds, ['server-a', 'server-b'])
})

test('planEnvironmentSchedule pin path never requires TurboFabric', () => {
  const plan = planEnvironmentSchedule({
    pinServerId: 'server-a',
    defaultServerId: null,
    fabricEnabled: false,
    servers: [alpha, bravo],
    services: [webService(3)],
    existingTasks: [],
    storagePins: new Map(),
  })
  assertEquals(plan.ok, true)
  if (!plan.ok) return
  assertEquals(plan.serverIds, ['server-a'])
})

test('planEnvironmentSchedule is sticky on (service, slot)', () => {
  const plan = planEnvironmentSchedule({
    pinServerId: null,
    defaultServerId: 'server-a',
    fabricEnabled: true,
    servers: [alpha, bravo],
    services: [webService(1)],
    existingTasks: [{ serviceId: 'svc-web', slot: 0, serverId: 'server-b' }],
    storagePins: new Map(),
  })
  assertEquals(plan.ok, true)
  if (!plan.ok) return
  assertEquals(plan.slots[0]?.serverId, 'server-b')
})

test('planEnvironmentSchedule rejects host-port over-packing', () => {
  const plan = planEnvironmentSchedule({
    pinServerId: 'server-a',
    defaultServerId: null,
    fabricEnabled: false,
    servers: [alpha],
    services: [{
      serviceId: 'svc-web',
      spec: {
        composeServiceName: 'web',
        mode: 'replicated',
        replicas: 2,
        constraints: [],
        spreadKeys: [],
        publishedHostPorts: [80],
        colocateWith: [],
        maxReplicasPerNode: null,
      },
    }],
    existingTasks: [],
    storagePins: new Map(),
  })
  assertEquals(plan.ok, false)
  if (plan.ok) return
  assertEquals(plan.error, 'host_port_conflict')
})

test('localReplicaCounts groups slots for one server', () => {
  const counts = localReplicaCounts(
    [
      { serviceId: 'svc-web', serverId: 'server-a', slot: 0 },
      { serviceId: 'svc-web', serverId: 'server-a', slot: 1 },
      { serviceId: 'svc-web', serverId: 'server-b', slot: 2 },
    ],
    new Map([['svc-web', 'web']]),
    'server-a',
  )
  assertEquals([...counts.entries()], [['web', 2]])
})

test('planEnvironmentSchedule places on a disconnected pin', () => {
  const plan = planEnvironmentSchedule({
    pinServerId: 'server-c',
    defaultServerId: null,
    fabricEnabled: false,
    servers: [alpha, charlie],
    services: [webService(1)],
    existingTasks: [],
    storagePins: new Map(),
  })
  assertEquals(plan.ok, true)
  if (!plan.ok) return
  assertEquals(plan.serverIds, ['server-c'])
})

test('planEnvironmentSchedule empty services still targets the pin', () => {
  const plan = planEnvironmentSchedule({
    pinServerId: 'server-a',
    defaultServerId: null,
    fabricEnabled: false,
    servers: [alpha],
    services: [],
    existingTasks: [],
    storagePins: new Map(),
  })
  assertEquals(plan.ok, true)
  if (!plan.ok) return
  assertEquals(plan.serverIds, ['server-a'])
  assertEquals(plan.slots, [])
})

/**
 * The compose key all the way through: `deploy.placement.max_replicas_per_node`
 * parsed by `interpretServiceSchedule` and enforced by the planner, rather than
 * parsed and then ignored — which is what it was before.
 */
test('max_replicas_per_node spreads a service the planner would otherwise pack', () => {
  const spec = interpretServiceSchedule(
    'web',
    { deploy: { replicas: 2, placement: { max_replicas_per_node: 1 } } },
    1,
  )
  assertEquals(spec.maxReplicasPerNode, 1)

  const plan = planEnvironmentSchedule({
    pinServerId: null,
    defaultServerId: 'server-a',
    fabricEnabled: true,
    servers: [alpha, bravo],
    services: [{ serviceId: 'svc-web', spec }],
    existingTasks: [],
    storagePins: new Map(),
  })
  assertEquals(plan.ok, true)
  if (!plan.ok) return
  assertEquals(plan.serverIds, ['server-a', 'server-b'])
})

test('max_replicas_per_node the fleet cannot satisfy is its own refusal', () => {
  const plan = planEnvironmentSchedule({
    pinServerId: 'server-a',
    defaultServerId: null,
    fabricEnabled: false,
    servers: [alpha, bravo],
    services: [{
      serviceId: 'svc-web',
      spec: interpretServiceSchedule(
        'web',
        { deploy: { replicas: 2, placement: { max_replicas_per_node: 1 } } },
        1,
      ),
    }],
    existingTasks: [],
    storagePins: new Map(),
  })
  assertEquals(plan.ok, false)
  if (plan.ok) return
  // The pin leaves exactly one eligible host, so two replicas at one per node
  // is arithmetic, not a constraint or a port.
  assertEquals(plan.error, 'max_replicas_per_node_exceeded')
})
