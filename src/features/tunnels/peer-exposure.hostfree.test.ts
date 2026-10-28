/**
 * The firewall rule for tunnel peers: HTTPS from the exact addresses the route
 * table names, nothing else, and a change of the table makes the server
 * preview its firewall again.
 */
import { assert, assertEquals } from '@std/assert'
import { deriveFirewall, type FirewallDeriveInput } from '../firewall/derive.ts'
import { DEFAULT_FIREWALL_ORG_POLICY } from '../firewall/policy.ts'
import { MAX_FIREWALL_RULE_ADDRESSES } from '../firewall/vocabulary.ts'
import { commandMayChangeFirewallPreview } from '../firewall/preview.ts'
import { TUNNEL_PEER_COMMENT, tunnelPeerExposures } from './peer-exposure.ts'

const test = Deno.test.bind(Deno)

function inputWith(peers: string[]): FirewallDeriveInput {
  return {
    policy: DEFAULT_FIREWALL_ORG_POLICY,
    sshPortHint: 22,
    coLocated: false,
    controlPlaneTcpPorts: [],
    exposures: tunnelPeerExposures(peers),
    edicts: [],
    sources: { servers: [], datacenter: ['10.0.0.0/24'], fabric: [] },
  }
}

function derive(peers: string[]) {
  return deriveFirewall(inputWith(peers))
}

test('no inbound peers means no rule', () => {
  assertEquals(tunnelPeerExposures([]), [])
  assertEquals(derive([]).rules, [])
})

test('peers get HTTPS only, from their exact addresses and never the whole datacenter', () => {
  const { rules } = derive(['10.0.0.10', 'fd00::10'])
  assertEquals(rules.length, 1)
  const rule = rules[0]!
  assertEquals([rule.action, rule.scope, rule.proto, rule.ports], ['accept', 'host', 'tcp', '443'])
  assertEquals(rule.sources, ['10.0.0.10/32', 'fd00::10/128'])
  assertEquals(rule.comment, TUNNEL_PEER_COMMENT)
})

test('a range is never turned into a rule, only bare addresses are', () => {
  assertEquals(tunnelPeerExposures(['10.0.0.0/24']), [])
  assertEquals(derive(['10.0.0.0/24', 'not-an-address']).rules, [])
  const [exposure] = tunnelPeerExposures(['10.0.0.5/24', '10.0.0.6'])
  assertEquals(exposure?.sources, ['10.0.0.6'])
})

test('too many peers: the rule is left out with a note, never cut short or widened', () => {
  const many = Array.from(
    { length: MAX_FIREWALL_RULE_ADDRESSES + 1 },
    (_, i) => `10.1.${i >> 8}.${i & 255}`
  )
  const derivation = derive(many)
  assertEquals(derivation.rules, [])
  assert(derivation.notes.some((note) => note.includes(TUNNEL_PEER_COMMENT)))
})

test('only 443/tcp is ever opened: no 80, no 443/udp, no wider source', () => {
  const { rules } = derive(['10.0.0.10'])
  assertEquals(
    rules.map((r) => [r.proto, r.ports]),
    [['tcp', '443']]
  )
  assert(!rules.some((r) => r.sources.includes('any') || r.sources.includes('10.0.0.0/24')))
})

test('the exposure copies its addresses', () => {
  const peers = ['10.0.0.10']
  const [exposure] = tunnelPeerExposures(peers)
  peers.push('10.0.0.99')
  assertEquals(exposure?.sources, ['10.0.0.10'])
})

test('a successful forwarding table makes the server preview its firewall again', () => {
  assertEquals(commandMayChangeFirewallPreview('server.tunnel.routes'), true)
})
