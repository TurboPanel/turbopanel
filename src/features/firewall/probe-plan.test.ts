import { assertEquals } from '@std/assert'
import type { DerivedExposure, EdictFact, FirewallDeriveInput } from './derive.ts'
import { DEFAULT_FIREWALL_ORG_POLICY } from './policy.ts'
import { MAX_PUBLIC_PROBE_PORTS, planProbePorts } from './probe-plan.ts'

const test = Deno.test.bind(Deno)

function input(overrides: Partial<FirewallDeriveInput> = {}): FirewallDeriveInput {
  return {
    policy: { ...DEFAULT_FIREWALL_ORG_POLICY },
    sshPortHint: 22,
    coLocated: false,
    controlPlaneTcpPorts: [8443],
    exposures: [],
    edicts: [],
    sources: { servers: [], datacenter: [], fabric: [] },
    ...overrides,
  }
}

function exposure(ports: string, overrides: Partial<DerivedExposure> = {}): DerivedExposure {
  return {
    source: 'hosting',
    scope: 'host',
    proto: 'tcp',
    ports,
    reach: 'public',
    comment: `Hosting ${ports}`,
    ...overrides,
  }
}

function edict(overrides: Partial<EdictFact>): EdictFact {
  return {
    id: 'e1',
    scope: 'host',
    action: 'drop',
    proto: 'tcp',
    ports: '443',
    sourceKind: 'any',
    sourceAddresses: [],
    label: 'Block',
    ...overrides,
  }
}

test('a plain server is checked at its SSH port only, and that port gates', () => {
  const plan = planProbePorts(input({ sshPortHint: 2222 }))
  assertEquals(plan.ports, [{ port: 2222, role: 'invariant', reason: 'SSH' }])
  assertEquals(plan.notes, [])
})

test('the panel host also gets the control plane port, as an invariant', () => {
  const plan = planProbePorts(input({ coLocated: true, controlPlaneTcpPorts: [8443, 80] }))
  assertEquals(
    plan.ports.map((port) => [port.port, port.role]),
    [
      [22, 'invariant'],
      [8443, 'invariant'],
      [80, 'invariant'],
    ]
  )
  const elsewhere = planProbePorts(input({ coLocated: false, controlPlaneTcpPorts: [8443] }))
  assertEquals(
    elsewhere.ports.map((port) => port.port),
    [22]
  )
})

test('limiting SSH to some addresses makes SSH informational, not gating', () => {
  const plan = planProbePorts(
    input({ policy: { ...DEFAULT_FIREWALL_ORG_POLICY, sshSources: ['198.51.100.0/24'] } })
  )
  assertEquals(plan.ports[0], { port: 22, role: 'informational', reason: 'SSH' })
  assertEquals(plan.notes.length, 1)
})

test('only single tcp ports opened to everyone are checked, once each', () => {
  const plan = planProbePorts(
    input({
      exposures: [
        exposure('443'),
        exposure('443'),
        exposure('80'),
        exposure('443', { proto: 'udp' }),
        exposure('5432', { reach: 'datacenter' }),
        exposure('6000-6010'),
        exposure('9000', { destination: '10.0.0.5' }),
        exposure('22'),
      ],
    })
  )
  assertEquals(
    plan.ports.map((port) => [port.port, port.role]),
    [
      [22, 'invariant'],
      [443, 'public'],
      [80, 'public'],
    ]
  )
})

test('a port a typed block or reject rule covers is not checked, with a note', () => {
  const plan = planProbePorts(
    input({
      exposures: [exposure('443'), exposure('8080'), exposure('9090'), exposure('3000')],
      edicts: [
        edict({ ports: '443' }),
        edict({ id: 'e2', action: 'reject', ports: '8000-8100' }),
        edict({ id: 'e3', action: 'drop', proto: 'any', ports: null }),
        edict({ id: 'e4', action: 'accept', ports: '3000' }),
      ],
    })
  )
  assertEquals(
    plan.ports.map((port) => port.port),
    [22]
  )
  assertEquals(plan.notes.length, 4)
})

test('a udp-only block does not stop a tcp port from being checked', () => {
  const plan = planProbePorts(
    input({ exposures: [exposure('443')], edicts: [edict({ proto: 'udp', ports: '443' })] })
  )
  assertEquals(
    plan.ports.map((port) => port.port),
    [22, 443]
  )
})

test('at most MAX_PUBLIC_PROBE_PORTS public ports are checked; the rest are reported', () => {
  const ports = Array.from({ length: MAX_PUBLIC_PROBE_PORTS + 3 }, (_, i) => String(3000 + i))
  const plan = planProbePorts(input({ exposures: ports.map((port) => exposure(port)) }))
  assertEquals(plan.ports.length, 1 + MAX_PUBLIC_PROBE_PORTS)
  assertEquals(plan.notes, ['3 more public port(s) are not checked'])
})

test('with no SSH hint the check uses port 22', () => {
  assertEquals(planProbePorts(input({ sshPortHint: null })).ports[0]?.port, 22)
})
