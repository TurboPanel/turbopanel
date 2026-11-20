import { assertEquals } from '@std/assert'
import { parseNetworkMode, redirectNetworkModeNames } from './network-mode.ts'
import { compileRuntimeComposeDocument } from './compile-runtime.ts'
import type { ComposeDocument } from './types.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SERVICES = {
  vpn: { image: 'vpn' },
  qbittorrent: { image: 'qbt', network_mode: 'service:vpn' },
  tools: { image: 'tools', network_mode: 'container:external' },
  edge: { image: 'edge', network_mode: 'host' },
  plain: { image: 'plain' },
}

test('parseNetworkMode reads the four forms', () => {
  assertEquals(parseNetworkMode('service:vpn'), { kind: 'service', target: 'vpn' })
  assertEquals(parseNetworkMode('container:x'), { kind: 'container', target: 'x' })
  assertEquals(parseNetworkMode('host'), { kind: 'host' })
  assertEquals(parseNetworkMode('none'), { kind: 'none' })
  assertEquals(parseNetworkMode('bridge'), undefined)
  assertEquals(parseNetworkMode(undefined), undefined)
})

test('a service:x binding moves to x; container, host and none drop it', () => {
  assertEquals(
    redirectNetworkModeNames(['qbittorrent', 'tools', 'edge', 'plain'], SERVICES).sort(),
    ['plain', 'vpn']
  )
  assertEquals(redirectNetworkModeNames(['vpn', 'qbittorrent'], SERVICES), ['vpn'])
})

test('managed ingress extra_hosts go to the target of a service:x service', () => {
  const doc: ComposeDocument = {
    version: 1,
    data: { services: SERVICES },
    presentation: { keyOrder: ['services'], comments: {} },
  }
  const compiled = compileRuntimeComposeDocument(doc, {
    managedIngressHostsByService: new Map([
      ['qbittorrent', [{ name: 'db.example.net', address: '192.0.2.10' }]],
      ['tools', [{ name: 'db.example.net', address: '192.0.2.10' }]],
    ]),
  })
  const services = compiled.data.services as Record<string, Record<string, unknown>>
  assertEquals(services.qbittorrent?.extra_hosts, undefined)
  assertEquals(services.tools?.extra_hosts, undefined)
  assertEquals(services.vpn?.extra_hosts, ['db.example.net:192.0.2.10'])
})
