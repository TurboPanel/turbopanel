/**
 * The firewall rule for tunnel peers: HTTPS from the exact addresses the route
 * table names, nothing else, and a change of the table makes the server
 * preview its firewall again.
 */
import { assertEquals } from '@std/assert'
import { deriveFirewall, type FirewallDeriveInput } from '../firewall/derive.ts'
import { DEFAULT_FIREWALL_ORG_POLICY } from '../firewall/policy.ts'
import { commandMayChangeFirewallPreview } from '../firewall/preview.ts'
import { TUNNEL_PEER_COMMENT, tunnelPeerExposures } from './peer-exposure.ts'

const test = Deno.test.bind(Deno)

function derive(peers: string[]) {
  const input: FirewallDeriveInput = {
    policy: DEFAULT_FIREWALL_ORG_POLICY,
    sshPortHint: 22,
    coLocated: false,
    controlPlaneTcpPorts: [],
    exposures: tunnelPeerExposures(peers),
    edicts: [],
    sources: { servers: [], datacenter: ['10.0.0.0/24'], fabric: [] },
  }
  return deriveFirewall(input)
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

test('the exposure copies its addresses', () => {
  const peers = ['10.0.0.10']
  const [exposure] = tunnelPeerExposures(peers)
  peers.push('10.0.0.99')
  assertEquals(exposure?.sources, ['10.0.0.10'])
})

test('a successful forwarding table makes the server preview its firewall again', () => {
  assertEquals(commandMayChangeFirewallPreview('server.tunnel.routes'), true)
})
