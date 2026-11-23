import { assertEquals, assertStringIncludes } from '@std/assert'
import { assertComposeDocument } from '../../features/compose/index.ts'
import {
  bridgeUdpReplyWarnings,
  hostNetworkWarnings,
  serviceNetworkWarnings,
} from './deploy-prepare.ts'

const test = Deno.test.bind(Deno)

const warns = (entry: unknown, networks: Record<string, unknown> = {}, extra = {}) =>
  bridgeUdpReplyWarnings({ t: { ports: [entry], ...extra } }, networks).length

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
    '69:69/udp ',
    '69:69/ udp',
    { target: 69, published: 69, protocol: 'udp' },
    { target: 69, published: 6969, protocol: 'udp' },
    { target: 69, published: 69, protocol: ' udp ' },
  ]) {
    assertEquals(warns(entry), 1, JSON.stringify(entry))
  }
})

test('a port range that covers 69 warns', () => {
  for (const entry of [
    '60-70:60-70/udp',
    '0.0.0.0:69-70:69-70/udp',
    '69-70/udp',
    '7000-7001:60-70/udp',
    { target: '60-70', published: '60-70', protocol: 'udp' },
  ]) {
    assertEquals(warns(entry), 1, JSON.stringify(entry))
  }
  assertEquals(warns('70-80:70-80/udp'), 0)
})

test('TCP 69, other UDP ports and bare container ports do not warn', () => {
  for (const entry of [
    '69:69',
    '69:69/tcp',
    '5353:5353/udp',
    '70/udp',
    { target: 69, published: 69 },
  ]) {
    assertEquals(warns(entry), 0, JSON.stringify(entry))
  }
  assertEquals(bridgeUdpReplyWarnings({ c: {} }), [])
})

test('host networking and LAN networks do not warn about the bridge', () => {
  assertEquals(warns('69:69/udp', {}, { network_mode: 'host' }), 0)
  assertEquals(warns('69:69/udp', { lan: { driver: 'macvlan' } }, { networks: ['lan'] }), 0)
  assertEquals(warns('69:69/udp', { lan: { driver: 'ipvlan' } }, { networks: { lan: {} } }), 0)
  assertEquals(
    warns('69:69/udp', { lan: { driver: 'macvlan' }, back: {} }, { networks: ['lan', 'back'] }),
    1
  )
})

test('a LAN or undeclared-driver default network does not warn, a bridge one does', () => {
  assertEquals(warns('69:69/udp', { default: { driver: 'macvlan' } }), 0)
  assertEquals(warns('69:69/udp', { default: { external: true, name: 'lan' } }), 0)
  assertEquals(warns('69:69/udp', { default: { driver: 'bridge' } }), 1)
  assertEquals(warns('69:69/udp', { default: { driver: 'macvlan' } }, { networks: ['x'] }), 1)
})

test('an external network with no driver is not assumed to be a bridge', () => {
  assertEquals(warns('69:69/udp', { lan: { external: true } }, { networks: ['lan'] }), 0)
  assertEquals(
    warns('69:69/udp', { lan: { external: true, driver: 'bridge' } }, { networks: ['lan'] }),
    1
  )
})

test('host networking warns only when ports: entries are listed', () => {
  const warnings = hostNetworkWarnings({
    tftp: { network_mode: 'host', ports: ['69:69/udp'] },
    samba: { network_mode: 'host' },
    empty: { network_mode: 'host', ports: [] },
    web: { ports: ['8080:80'] },
    shared: { network_mode: 'service:tftp', ports: ['1:1'] },
  })
  assertEquals(warnings.length, 1)
  assertEquals(warnings[0]?.code, 'host_network_unchecked')
  assertEquals(warnings[0]?.details, { composeServiceName: 'tftp' })
  assertStringIncludes(warnings[0]?.message ?? '', 'Docker ignores the ports: entries')
  assertEquals((warnings[0]?.message ?? '').includes('not checked'), false)
})

test('the prepare warning list carries the network warnings with the reserved-port one', () => {
  const document = assertComposeDocument({
    version: 1,
    data: {
      services: {
        tftp: { image: 'x', ports: ['69:69/udp'] },
        edge: { image: 'x', ports: ['443:443'] },
        phone: { image: 'x', network_mode: 'host', ports: ['5060:5060/udp'] },
      },
    },
    presentation: { keyOrder: ['services'], comments: {} },
  })
  assertEquals(
    serviceNetworkWarnings(document).map((warning) => warning.code),
    ['reserved_host_port', 'bridge_udp_reply_port', 'host_network_unchecked']
  )
})
