import { assertEquals, assertStringIncludes } from '@std/assert'
import { bridgeUdpReplyWarnings, hostNetworkWarnings } from './deploy-prepare.ts'

const test = Deno.test.bind(Deno)

test('a bridge-published UDP 69 warns with the working options', () => {
  const warnings = bridgeUdpReplyWarnings({ tftp: { image: 'x', ports: ['69:69/udp'] } })
  assertEquals(warnings.length, 1)
  assertEquals(warnings[0]?.code, 'bridge_udp_reply_port')
  assertStringIncludes(warnings[0]?.message ?? '', 'network_mode: host')
  assertStringIncludes(warnings[0]?.message ?? '', 'macvlan')
  assertEquals(warnings[0]?.details, { composeServiceName: 'tftp', protocol: 'TFTP', port: 69 })
})

test('TFTP is found in the other spellings of a published port', () => {
  for (const entry of [
    '0.0.0.0:69:69/udp',
    '6969:69/udp',
    '[::]:69:69/UDP',
    { target: 69, published: 69, protocol: 'udp' },
    { target: 69, published: 6969, protocol: 'udp' },
  ]) {
    assertEquals(bridgeUdpReplyWarnings({ t: { ports: [entry] } }).length, 1, JSON.stringify(entry))
  }
})

test('TCP 69, other UDP ports and bare container ports do not warn', () => {
  assertEquals(
    bridgeUdpReplyWarnings({
      a: { ports: ['69:69', '69:69/tcp', '5353:5353/udp', '70/udp'] },
      b: { ports: [{ target: 69, published: 69 }] },
      c: {},
    }),
    []
  )
})

test('host networking and LAN networks do not warn about the bridge', () => {
  assertEquals(bridgeUdpReplyWarnings({ t: { network_mode: 'host', ports: ['69:69/udp'] } }), [])
  assertEquals(
    bridgeUdpReplyWarnings(
      { t: { networks: ['lan'], ports: ['69:69/udp'] } },
      { lan: { driver: 'macvlan' } }
    ),
    []
  )
  assertEquals(
    bridgeUdpReplyWarnings(
      { t: { networks: ['lan', 'back'], ports: ['69:69/udp'] } },
      { lan: { driver: 'macvlan' }, back: {} }
    ).length,
    1
  )
})

test('host networking is reported as outside the port checks', () => {
  const warnings = hostNetworkWarnings({
    tftp: { network_mode: 'host' },
    web: { ports: ['8080:80'] },
    shared: { network_mode: 'service:tftp' },
  })
  assertEquals(warnings.length, 1)
  assertEquals(warnings[0]?.code, 'host_network_unchecked')
  assertEquals(warnings[0]?.details, { composeServiceName: 'tftp' })
  assertStringIncludes(warnings[0]?.message ?? '', '80, 443')
})
