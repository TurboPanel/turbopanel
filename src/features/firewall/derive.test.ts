import { assertEquals } from '@std/assert'
import { deriveFirewall, type FirewallDeriveInput } from './derive.ts'
import { DEFAULT_FIREWALL_ORG_POLICY } from './policy.ts'

const test = Deno.test.bind(Deno)

function input(overrides: Partial<FirewallDeriveInput> = {}): FirewallDeriveInput {
  return {
    policy: DEFAULT_FIREWALL_ORG_POLICY,
    sshPortHint: 22,
    coLocated: false,
    controlPlaneTcpPorts: [],
    exposures: [],
    edicts: [],
    sources: { servers: [], datacenter: [], fabric: [] },
    ...overrides,
  }
}

test('an empty server derives no rules and passes the ssh hint through', () => {
  const derivation = deriveFirewall(input())
  assertEquals(derivation.rules, [])
  assertEquals(derivation.sshPorts, [22])
  assertEquals(derivation.controlPlane, undefined)
})

test('the control plane ports are sent only for the co-located host', () => {
  assertEquals(deriveFirewall(input({ controlPlaneTcpPorts: [8443] })).controlPlane, undefined)
  assertEquals(
    deriveFirewall(input({ coLocated: true, controlPlaneTcpPorts: [80, 8443, 80] })).controlPlane,
    { tcpPorts: [80, 8443] }
  )
})

test('golden: hosting, a published compose port and the fabric port', () => {
  const derivation = deriveFirewall(
    input({
      exposures: [
        {
          source: 'hosting',
          scope: 'host',
          proto: 'tcp',
          ports: '443',
          reach: 'public',
          comment: 'Hosting 443',
        },
        {
          source: 'compose',
          scope: 'published',
          proto: 'tcp',
          ports: '8080',
          reach: 'public',
          comment: 'App web',
        },
        {
          source: 'fabric',
          scope: 'host',
          proto: 'udp',
          ports: '51820',
          reach: 'public',
          comment: 'TurboFabric',
        },
      ],
    })
  )
  assertEquals(
    derivation.rules.map((rule) => [rule.id, rule.scope, rule.proto, rule.ports, rule.sources]),
    [
      ['d:compose:tcp:8080:public', 'published', 'tcp', '8080', ['any']],
      ['d:fabric:udp:51820:public', 'host', 'udp', '51820', ['any']],
      ['d:hosting:tcp:443:public', 'host', 'tcp', '443', ['any']],
    ]
  )
  assertEquals(
    derivation.rules.every((rule) => rule.origin === 'derived'),
    true
  )
  assertEquals(
    derivation.rules.every((rule) => rule.action === 'accept'),
    true
  )
})

test('duplicate exposures collapse into one rule', () => {
  const exposure = {
    source: 'compose',
    scope: 'published' as const,
    proto: 'tcp' as const,
    ports: '8080',
    reach: 'public' as const,
    comment: 'App web',
  }
  assertEquals(deriveFirewall(input({ exposures: [exposure, exposure] })).rules.length, 1)
})

test('a bound address becomes a destination', () => {
  const derivation = deriveFirewall(
    input({
      exposures: [
        {
          source: 'compose',
          scope: 'published',
          proto: 'tcp',
          ports: '8080',
          reach: 'public',
          comment: 'App web',
          destination: '203.0.113.5',
        },
      ],
    })
  )
  assertEquals(derivation.rules[0].destinations, ['203.0.113.5'])
})

test('the high availability ports reach only the organization servers', () => {
  const exposure = {
    source: 'ha',
    scope: 'published' as const,
    proto: 'tcp' as const,
    ports: '33001',
    reach: 'servers' as const,
    comment: 'HA Raft',
  }
  const derivation = deriveFirewall(
    input({
      exposures: [exposure],
      sources: { servers: ['198.51.100.2', '198.51.100.1'], datacenter: [], fabric: [] },
    })
  )
  assertEquals(derivation.rules[0].sources, ['198.51.100.1', '198.51.100.2'])
})

test('an unresolved narrowing is skipped with a note, never widened to anyone', () => {
  const derivation = deriveFirewall(
    input({
      exposures: [
        {
          source: 'ha',
          scope: 'published',
          proto: 'tcp',
          ports: '33001',
          reach: 'servers',
          comment: 'HA Raft',
        },
      ],
      edicts: [
        {
          id: 'e1',
          scope: 'host',
          action: 'accept',
          proto: 'tcp',
          ports: '5432',
          sourceKind: 'datacenter',
          sourceAddresses: [],
          label: 'Postgres',
        },
      ],
    })
  )
  assertEquals(derivation.rules, [])
  assertEquals(derivation.notes.length >= 2, true)
})

test('operator rules keep their action, ports and source words', () => {
  const derivation = deriveFirewall(
    input({
      edicts: [
        {
          id: 'e1',
          scope: 'host',
          action: 'drop',
          proto: 'tcp',
          ports: '23',
          sourceKind: 'addresses',
          sourceAddresses: ['203.0.113.7', 'not an address'],
          label: 'No telnet',
        },
        {
          id: 'e2',
          scope: 'published',
          action: 'accept',
          proto: 'any',
          ports: null,
          sourceKind: 'fabric',
          sourceAddresses: [],
          label: 'Fabric',
        },
      ],
      sources: { servers: [], datacenter: [], fabric: ['10.99.0.0/16'] },
    })
  )
  assertEquals(derivation.rules[0].id, 'u:e1')
  assertEquals(derivation.rules[0].origin, 'user')
  assertEquals(derivation.rules[0].action, 'drop')
  assertEquals(derivation.rules[0].sources, ['203.0.113.7/32'])
  assertEquals(derivation.rules[1].sources, ['10.99.0.0/16'])
  assertEquals(derivation.rules[1].ports, undefined)
})

test('an organization ssh restriction is reported as not yet sent', () => {
  const derivation = deriveFirewall(
    input({ policy: { ...DEFAULT_FIREWALL_ORG_POLICY, sshSources: ['10.0.0.0/8'] } })
  )
  assertEquals(derivation.notes.length, 1)
})
