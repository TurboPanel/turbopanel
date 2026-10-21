import { assertEquals } from '@std/assert'
import type { ServerReportedIp } from '../../contracts/server-addresses.ts'
import {
  type ClientAddressDatacenterPin,
  type ClientAddressEntry,
  clientAddressCertificateNames,
  clientAddressNeeded,
  type ClientAddressFacts,
  clientEndpointsForListener,
  detectedPublicAddresses,
  hostHasIpv6,
  mainClientAddressHost,
  mainDatabaseListeners,
  parseClientAddressesBody,
  parseClientAddressOptions,
  resolveClientAddresses,
} from './client-addresses-pure.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const DC_A = '0190a000-0000-7000-8000-00000000000a'
const DC_B = '0190a000-0000-7000-8000-00000000000b'

function facts(overrides: Partial<ClientAddressFacts> = {}): ClientAddressFacts {
  return {
    linuxHostname: 'omega',
    saved: [],
    publicIp: { v4: null, v6: null },
    reportedIps: [],
    pins: [],
    ...overrides,
  }
}

function entry(overrides: Partial<ClientAddressEntry>): ClientAddressEntry {
  return {
    scope: 'public',
    datacenterId: null,
    hostname: null,
    addressV4: null,
    addressV6: null,
    ports: {},
    primary: false,
    ...overrides,
  }
}

function pin(overrides: Partial<ClientAddressDatacenterPin>): ClientAddressDatacenterPin {
  return {
    datacenterId: DC_A,
    datacenterName: 'Ashburn',
    addressPreference: 'ipv4',
    priority: 100,
    v4: '10.0.0.5',
    v6: null,
    ...overrides,
  }
}

function reported(address: string, extra: Partial<ServerReportedIp> = {}): ServerReportedIp {
  return {
    address,
    version: address.includes(':') ? 6 : 4,
    scope: 'public',
    interface: 'eth0',
    ...extra,
  }
}

test('a one-word Linux hostname never becomes a host clients dial', () => {
  const resolved = resolveClientAddresses(facts())
  assertEquals(resolved.entries.length, 1)
  assertEquals(resolved.entries[0]!.host, null)
  assertEquals(mainClientAddressHost(resolved), null)
  assertEquals(clientEndpointsForListener(resolved, 'postgres', 15432), [])
  assertEquals(clientAddressNeeded(true, []), true)
  assertEquals(clientAddressNeeded(false, []), false)
})

test('a Linux hostname with a dot is the last resort for the public side', () => {
  const resolved = resolveClientAddresses(facts({ linuxHostname: 'omega.example.net' }))
  assertEquals(resolved.entries[0]!.host, 'omega.example.net')
  assertEquals(resolved.entries[0]!.hostSource, 'linux-hostname')
  // An address still wins over it.
  const withIp = resolveClientAddresses(
    facts({ linuxHostname: 'omega.example.net', publicIp: { v4: '198.51.100.4', v6: null } })
  )
  assertEquals(withIp.entries[0]!.host, '198.51.100.4')
})

test('public precedence: operator entry, then public ip row, then reported address', () => {
  const reportedIps = [reported('203.0.113.9'), reported('2001:db8::9')]
  const detectedOnly = resolveClientAddresses(facts({ reportedIps }))
  assertEquals(detectedOnly.entries[0]!.effectiveV4, '203.0.113.9')
  assertEquals(detectedOnly.entries[0]!.effectiveV4Source, 'reported')
  assertEquals(detectedOnly.entries[0]!.effectiveV6Source, 'reported')
  // IPv4 first for an address-only host.
  assertEquals(detectedOnly.entries[0]!.host, '203.0.113.9')

  const withRow = resolveClientAddresses(
    facts({ reportedIps, publicIp: { v4: '198.51.100.4', v6: null } })
  )
  assertEquals(withRow.entries[0]!.effectiveV4, '198.51.100.4')
  assertEquals(withRow.entries[0]!.effectiveV4Source, 'ip')
  // A family with no row still falls back to detection.
  assertEquals(withRow.entries[0]!.effectiveV6, '2001:db8::9')

  const withEntry = resolveClientAddresses(
    facts({
      reportedIps,
      publicIp: { v4: '198.51.100.4', v6: null },
      saved: [entry({ hostname: 'omega.example.com', addressV4: '192.0.2.77' })],
    })
  )
  const pub = withEntry.entries[0]!
  assertEquals(pub.saved, true)
  assertEquals(pub.effectiveV4, '192.0.2.77')
  assertEquals(pub.effectiveV4Source, 'entry')
  assertEquals(pub.host, 'omega.example.com')
  assertEquals(pub.hostSource, 'hostname')
})

test('detection drops CGNAT, link-local, private, mesh and down interfaces', () => {
  assertEquals(
    detectedPublicAddresses([
      reported('100.64.1.2'),
      reported('fe80::1'),
      reported('10.250.0.4', { interface: 'tp0' }),
      reported('203.0.113.50', { interface: 'tp0' }),
      reported('203.0.113.60', { interface: 'wg0' }),
      reported('203.0.113.70', { link: 'down' }),
      reported('192.168.1.10', { scope: 'private' }),
    ]),
    { v4: null, v6: null }
  )
  // The default-route interface wins.
  assertEquals(
    detectedPublicAddresses([
      reported('203.0.113.1', { interface: 'eth1' }),
      reported('203.0.113.2', { interface: 'eth0', preferred: true }),
    ]).v4,
    '203.0.113.2'
  )
})

test('datacenter sides come from pins, honour the preference, and skip left datacenters', () => {
  const resolved = resolveClientAddresses(
    facts({
      pins: [
        pin({
          datacenterId: DC_B,
          datacenterName: 'Zurich',
          priority: 50,
          addressPreference: 'ipv6',
          v4: '10.1.0.5',
          v6: 'fd00::5',
        }),
        pin({}),
      ],
      saved: [
        entry({ scope: 'datacenter', datacenterId: DC_A, hostname: 'omega.dc1.example.com' }),
        // The server no longer belongs to this one: never advertised.
        entry({
          scope: 'datacenter',
          datacenterId: '0190a000-0000-7000-8000-0000000000ff',
          hostname: 'gone.example.com',
        }),
      ],
    })
  )
  assertEquals(
    resolved.entries.map((e) => [e.label, e.host, e.effectiveV4Source]),
    [
      ['Public', null, null],
      ['Zurich', 'fd00::5', 'pin'],
      ['Ashburn', 'omega.dc1.example.com', 'pin'],
    ]
  )
})

test('endpoints: primary first, port overrides, null means not reachable', () => {
  const resolved = resolveClientAddresses(
    facts({
      publicIp: { v4: '198.51.100.4', v6: null },
      pins: [pin({})],
      saved: [
        entry({ hostname: 'db.example.com', ports: { postgres: 25432, mysql: null } }),
        entry({ scope: 'datacenter', datacenterId: DC_A, primary: true }),
      ],
    })
  )
  assertEquals(clientEndpointsForListener(resolved, 'postgres', 15432), [
    {
      label: 'Ashburn',
      scope: 'datacenter',
      datacenterId: DC_A,
      host: '10.0.0.5',
      port: 15432,
      primary: true,
    },
    {
      label: 'Public',
      scope: 'public',
      datacenterId: null,
      host: 'db.example.com',
      port: 25432,
      primary: false,
    },
  ])
  assertEquals(
    clientEndpointsForListener(resolved, 'mysql', 13306).map((e) => [e.label, e.primary]),
    [['Ashburn', true]]
  )
})

test('with no primary marked the public side is main, else the first datacenter', () => {
  const both = resolveClientAddresses(
    facts({ publicIp: { v4: '198.51.100.4', v6: null }, pins: [pin({})] })
  )
  assertEquals(clientEndpointsForListener(both, 'postgres', 15432)[0]!.label, 'Public')
  assertEquals(mainClientAddressHost(both), '198.51.100.4')
  const dcOnly = resolveClientAddresses(facts({ pins: [pin({})] }))
  assertEquals(clientEndpointsForListener(dcOnly, 'postgres', 15432)[0]!.label, 'Ashburn')
  // A primary that cannot reach the port hands over to the public side.
  const unreachable = resolveClientAddresses(
    facts({
      publicIp: { v4: '198.51.100.4', v6: null },
      pins: [pin({})],
      saved: [
        entry({
          scope: 'datacenter',
          datacenterId: DC_A,
          primary: true,
          ports: { postgres: null },
        }),
      ],
    })
  )
  assertEquals(
    clientEndpointsForListener(unreachable, 'postgres', 15432).map((e) => [e.label, e.primary]),
    [['Public', true]]
  )
})

test('certificate names: Linux hostname always, entries only while external access is on', () => {
  const resolved = resolveClientAddresses(
    facts({
      linuxHostname: 'omega',
      publicIp: { v4: '198.51.100.4', v6: '2001:db8::4' },
      pins: [pin({})],
      saved: [entry({ hostname: 'omega.example.com', addressV4: '192.0.2.77' })],
    })
  )
  assertEquals(clientAddressCertificateNames(resolved, false), {
    dnsNames: ['omega'],
    ipAddresses: [],
  })
  assertEquals(clientAddressCertificateNames(resolved, true), {
    dnsNames: ['omega', 'omega.example.com'],
    ipAddresses: ['192.0.2.77', '2001:db8::4', '10.0.0.5'],
  })
})

test('PUT validation: shapes, single-label names, families, ports, duplicates, primary', () => {
  const members = new Set([DC_A])
  const ok = parseClientAddressesBody(
    {
      addresses: [
        {
          scope: 'public',
          hostname: ' Omega.Example.COM. ',
          addressV4: '192.0.2.77',
          ports: { postgres: 25432, mysql: null },
          primary: true,
        },
        { scope: 'datacenter', datacenterId: DC_A, addressV6: '' },
      ],
    },
    members
  )
  assertEquals(ok, [
    entry({
      hostname: 'omega.example.com',
      addressV4: '192.0.2.77',
      ports: { postgres: 25432, mysql: null },
      primary: true,
    }),
    entry({ scope: 'datacenter', datacenterId: DC_A }),
  ])
  const errorOf = (addresses: unknown) => {
    const result = parseClientAddressesBody({ addresses }, members)
    return 'error' in result ? result.error : 'ok'
  }
  assertEquals(errorOf([{ scope: 'public', hostname: 'omega' }]), 'address_hostname_single_label')
  assertEquals(
    errorOf([{ scope: 'public', hostname: 'bad_name.example.com' }]),
    'address_hostname_invalid'
  )
  assertEquals(errorOf([{ scope: 'public', hostname: '1.2.3.4' }]), 'address_hostname_invalid')
  assertEquals(errorOf([{ scope: 'public', addressV4: '2001:db8::1' }]), 'address_v4_invalid')
  assertEquals(errorOf([{ scope: 'public', addressV4: '192.0.2.0/24' }]), 'address_v4_invalid')
  assertEquals(errorOf([{ scope: 'public', addressV4: '127.0.0.1' }]), 'address_v4_invalid')
  assertEquals(errorOf([{ scope: 'public', addressV6: '192.0.2.1' }]), 'address_v6_invalid')
  assertEquals(errorOf([{ scope: 'public', ports: { postgres: 0 } }]), 'address_ports_invalid')
  assertEquals(errorOf([{ scope: 'public', ports: { ssh: 22 } }]), 'address_ports_invalid')
  assertEquals(errorOf([{ scope: 'public' }, { scope: 'public' }]), 'address_duplicate')
  assertEquals(
    errorOf([{ scope: 'datacenter', datacenterId: DC_B }]),
    'address_datacenter_not_member'
  )
  assertEquals(errorOf([{ scope: 'public', datacenterId: DC_A }]), 'address_scope_invalid')
  assertEquals(errorOf([{ scope: 'mesh' }]), 'address_scope_invalid')
  assertEquals(
    errorOf([
      { scope: 'public', primary: true },
      { scope: 'datacenter', datacenterId: DC_A, primary: true },
    ]),
    'address_primary_multiple'
  )
  assertEquals(errorOf('nope'), 'invalid_addresses')
  assertEquals(errorOf([]), 'ok')
})

test('stored options read back as the ports map', () => {
  assertEquals(parseClientAddressOptions({ ports: { postgres: 25432, mysql: null, other: 1 } }), {
    ports: { postgres: 25432, mysql: null },
  })
  assertEquals(parseClientAddressOptions(null), { ports: {} })
  assertEquals(parseClientAddressOptions({ ports: { postgres: 'x' } }), { ports: {} })
})

test('mainDatabaseListeners follows the endpoint port rules per engine', () => {
  const resolved = resolveClientAddresses(
    facts({
      publicIp: { v4: '198.51.100.4', v6: null },
      pins: [pin({})],
      saved: [entry({ ports: { mysql: null } })],
    })
  )
  const main = mainDatabaseListeners(resolved)
  assertEquals(
    resolved.entries.map((e) => [e.label, main.get(e)]),
    [
      ['Public', ['postgres']],
      ['Ashburn', ['mysql']],
    ]
  )
  const none = mainDatabaseListeners(resolveClientAddresses(facts()))
  assertEquals([...none.values()], [[]])
})

test('hostHasIpv6 needs a live IPv6 address the daemon read from the kernel', () => {
  assertEquals(hostHasIpv6([]), false)
  assertEquals(hostHasIpv6([reported('203.0.113.7')]), false)
  assertEquals(hostHasIpv6([reported('::1'), reported('fe80::1', { scope: 'private' })]), false)
  // A link that is down, a mesh tunnel or a Docker bridge says nothing about the host's own IPv6.
  assertEquals(hostHasIpv6([reported('2001:db8::4', { link: 'down' })]), false)
  assertEquals(hostHasIpv6([reported('fd00::7', { scope: 'private', interface: 'tp0' })]), false)
  assertEquals(hostHasIpv6([reported('fd00::8', { scope: 'private', interface: 'wg0' })]), false)
  assertEquals(
    hostHasIpv6([reported('fd00:dead::1', { scope: 'private', interface: 'docker0' })]),
    false
  )
  assertEquals(
    hostHasIpv6([reported('fd00:beef::1', { scope: 'private', interface: 'br-1a2b' })]),
    false
  )

  assertEquals(hostHasIpv6([reported('2001:db8::4')]), true)
  assertEquals(hostHasIpv6([reported('2001:db8::4', { link: 'up' })]), true)
  assertEquals(hostHasIpv6([reported('fd98::1', { scope: 'private', interface: 'enp1s0' })]), true)
})

test('hostHasIpv6 ignores stored ip rows, datacenter pins and address overrides', () => {
  // What an operator typed does not prove the kernel runs IPv6.
  const stored = facts({
    publicIp: { v4: null, v6: '2001:db8::5' },
    pins: [pin({ v6: 'fd00::5' })],
    saved: [entry({ addressV6: '2001:db8::99' })],
  })
  assertEquals(hostHasIpv6(stored.reportedIps), false)
})
