import { assertEquals } from '@std/assert'
import { applyServiceOptionsToComposeDocument } from './apply-service-options.ts'
import { type ComposeDocument, emptyComposeDocument } from './types.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const VPN_SERVICE_UUID = '01a025f1-850c-705d-a7c2-1833d01cda00'
const QBIT_SERVICE_UUID = '01a025f1-850c-705d-a7c2-1833d01cda01'

function assertServiceRecord(
  value: unknown,
  name: string
): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`expected service record for ${name}`)
  }
}

function vpnPairDocument(qbittorrentMode: string): ComposeDocument {
  const doc = emptyComposeDocument()
  doc.data.services = {
    vpn: {
      build: { context: './vpn' },
      cap_add: ['NET_ADMIN'],
      sysctls: { 'net.ipv4.conf.all.src_valid_mark': 1 },
      ports: ['8080:8080'],
    },
    qbittorrent: {
      image: 'lscr.io/linuxserver/qbittorrent:latest',
      network_mode: qbittorrentMode,
    },
  }
  return doc
}

test("a service that shares another's network gets no networks or alias", () => {
  const result = applyServiceOptionsToComposeDocument(
    vpnPairDocument('service:vpn'),
    new Map(),
    new Map([
      ['vpn', VPN_SERVICE_UUID],
      ['qbittorrent', QBIT_SERVICE_UUID],
    ])
  )
  const services = result.document.data.services as Record<string, unknown>
  const vpn = services.vpn
  const qbit = services.qbittorrent
  assertServiceRecord(vpn, 'vpn')
  assertServiceRecord(qbit, 'qbittorrent')
  // The container is still renamed; only the network wiring is skipped.
  assertEquals(qbit.container_name, QBIT_SERVICE_UUID)
  assertEquals(qbit.network_mode, 'service:vpn')
  assertEquals(qbit.networks, undefined)
  // The service that owns the namespace keeps its alias.
  assertEquals(vpn.networks, { default: { aliases: ['vpn'] } })
})

test('host, none and container network modes get no networks or alias', () => {
  for (const mode of ['host', 'none', 'container:other']) {
    const result = applyServiceOptionsToComposeDocument(
      vpnPairDocument(mode),
      new Map(),
      new Map([['qbittorrent', QBIT_SERVICE_UUID]])
    )
    const qbit = (result.document.data.services as Record<string, unknown>).qbittorrent
    assertServiceRecord(qbit, 'qbittorrent')
    assertEquals(qbit.container_name, QBIT_SERVICE_UUID)
    assertEquals(qbit.networks, undefined)
  }
})
