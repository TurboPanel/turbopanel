/**
 * Host-free coverage for daemon peer-address resolution.
 *
 * Two things are asserted here that the product depends on:
 * 1. `CF-Connecting-IP` is honoured through a trusted local connector and
 *    ignored from a daemon that dialled the proxy over the network.
 * 2. A loopback wire address — a co-located reverse proxy, or the forwarded
 *    port every development Vagrant guest uses — never becomes the server's
 *    displayed address while the daemon reports interfaces of its own.
 */

import { assertEquals } from '@std/assert'
import {
  DEFAULT_TRUSTED_PROXY_CIDRS,
  DIRECT_ATTACH_SENTINEL,
  isTrustedProxyAddress,
  parseTrustedProxyCidrs,
  resolvePeerAddress,
  resolveServerAddress,
} from './peer-address.ts'
import type { ServerReportedIp } from '../server-addresses.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const LAN_IPS: ServerReportedIp[] = [
  { address: '10.20.0.7', version: 4, scope: 'private', interface: 'eth1' },
  {
    address: '192.168.1.50',
    version: 4,
    scope: 'private',
    interface: 'eth0',
    preferred: true,
  },
]

test('parseTrustedProxyCidrs falls back to loopback and drops junk', () => {
  assertEquals(parseTrustedProxyCidrs(undefined), [
    ...DEFAULT_TRUSTED_PROXY_CIDRS,
  ])
  assertEquals(parseTrustedProxyCidrs('   '), [...DEFAULT_TRUSTED_PROXY_CIDRS])
  assertEquals(parseTrustedProxyCidrs('not-a-cidr,203.0.113.0/24'), [
    '203.0.113.0/24',
  ])
  // Every entry invalid must not widen trust to "anything".
  assertEquals(parseTrustedProxyCidrs('nonsense,1.2.3.4'), [
    ...DEFAULT_TRUSTED_PROXY_CIDRS,
  ])
})

test('isTrustedProxyAddress covers loopback in both families', () => {
  assertEquals(isTrustedProxyAddress('127.0.0.1'), true)
  assertEquals(isTrustedProxyAddress('127.1.2.3'), true)
  assertEquals(isTrustedProxyAddress('::1'), true)
  assertEquals(isTrustedProxyAddress('192.168.1.50'), false)
  assertEquals(isTrustedProxyAddress('garbage'), false)
})

test('workers resolution uses CF-Connecting-IP only', () => {
  assertEquals(
    resolvePeerAddress(
      { cfConnectingIp: '203.0.113.9', realIp: '10.0.0.1' },
      { runtime: 'workers' },
    ),
    { address: '203.0.113.9', source: 'cloudflare' },
  )
  assertEquals(
    resolvePeerAddress({ realIp: '10.0.0.1' }, { runtime: 'workers' }),
    null,
  )
})

test('a cloudflare tunnel beside the instance reports the daemon address', () => {
  // cloudflared runs on the instance host, so Caddy sees 127.0.0.1 and the
  // daemon's real address arrives only in CF-Connecting-IP.
  assertEquals(
    resolvePeerAddress({
      realIp: '127.0.0.1',
      cfConnectingIp: '198.51.100.22',
    }, { runtime: 'deno' }),
    { address: '198.51.100.22', source: 'cloudflare' },
  )
})

test('a daemon dialling the proxy directly cannot forge its address', () => {
  // X-Real-IP is Caddy's own socket peer and is not loopback, so the
  // client-supplied forwarding headers are ignored entirely.
  assertEquals(
    resolvePeerAddress({
      realIp: '198.51.100.22',
      cfConnectingIp: '203.0.113.1',
      forwardedFor: '203.0.113.2',
    }, { runtime: 'deno' }),
    { address: '198.51.100.22', source: 'direct' },
  )
})

test('X-Forwarded-For is read only through a trusted peer', () => {
  assertEquals(
    resolvePeerAddress({
      realIp: '127.0.0.1',
      forwardedFor: '198.51.100.22, 10.0.0.9',
    }, { runtime: 'deno' }),
    { address: '198.51.100.22', source: 'forwarded' },
  )
})

test('a widened trusted-proxy list covers a connector on another host', () => {
  const trustedProxyCidrs = parseTrustedProxyCidrs('10.9.0.0/24')
  assertEquals(
    resolvePeerAddress({
      realIp: '10.9.0.5',
      cfConnectingIp: '198.51.100.22',
    }, { runtime: 'deno', trustedProxyCidrs }),
    { address: '198.51.100.22', source: 'cloudflare' },
  )
  // The loopback default is replaced, not extended.
  assertEquals(
    resolvePeerAddress({
      realIp: '127.0.0.1',
      cfConnectingIp: '198.51.100.22',
    }, { runtime: 'deno', trustedProxyCidrs }),
    { address: '127.0.0.1', source: 'direct' },
  )
})

test('a loopback forwarding header never shadows the real peer', () => {
  // Caddy synthesizes X-Forwarded-For: 127.0.0.1 for a loopback peer, which is
  // every LAN daemon in development (Vagrant forwards the port over SSH).
  assertEquals(
    resolvePeerAddress({
      realIp: '127.0.0.1',
      forwardedFor: '127.0.0.1',
    }, { runtime: 'deno' }),
    { address: '127.0.0.1', source: 'direct' },
  )
  // A misconfigured connector claiming loopback must not win either.
  assertEquals(
    resolvePeerAddress({
      realIp: '127.0.0.1',
      cfConnectingIp: '127.0.0.1',
      forwardedFor: '198.51.100.22',
    }, { runtime: 'deno' }),
    { address: '198.51.100.22', source: 'forwarded' },
  )
  assertEquals(
    resolvePeerAddress({ cfConnectingIp: '::1' }, { runtime: 'workers' }),
    null,
  )
})

test('no forwarding header at all means a local Unix socket dial', () => {
  assertEquals(resolvePeerAddress({}, { runtime: 'deno' }), null)
})

test('IPv4-mapped and bracketed wire forms normalize to one address', () => {
  assertEquals(
    resolvePeerAddress({ realIp: '::ffff:198.51.100.22' }, {
      runtime: 'deno',
    }),
    { address: '198.51.100.22', source: 'direct' },
  )
  assertEquals(
    resolvePeerAddress({ realIp: '[2001:db8::5]' }, { runtime: 'deno' }),
    { address: '2001:db8::5', source: 'direct' },
  )
})

test('resolveServerAddress keeps a public observed address', () => {
  assertEquals(
    resolveServerAddress({ remoteAddress: '203.0.113.9', ips: LAN_IPS }),
    { address: '203.0.113.9', source: 'observed', scope: 'public' },
  )
})

test('resolveServerAddress confirms an observed LAN address the daemon reports', () => {
  assertEquals(
    resolveServerAddress({ remoteAddress: '10.20.0.7', ips: LAN_IPS }),
    {
      address: '10.20.0.7',
      source: 'observed',
      scope: 'private',
      interface: 'eth1',
      confirmed: true,
    },
  )
})

test('a loopback wire address falls back to the default-route interface', () => {
  // The development case: Vagrant forwards the port, so every server connects
  // from 127.0.0.1 and the old code showed that for all of them.
  assertEquals(
    resolveServerAddress({ remoteAddress: '127.0.0.1', ips: LAN_IPS }),
    {
      address: '192.168.1.50',
      source: 'interface',
      scope: 'private',
      interface: 'eth0',
    },
  )
})

test('a public interface address outranks a private one', () => {
  assertEquals(
    resolveServerAddress({
      remoteAddress: '127.0.0.1',
      ips: [
        ...LAN_IPS,
        {
          address: '203.0.113.40',
          version: 4,
          scope: 'public',
          interface: 'eth2',
        },
      ],
    }),
    {
      address: '203.0.113.40',
      source: 'interface',
      scope: 'public',
      interface: 'eth2',
    },
  )
})

test('an unmatched private wire address survives as a last resort', () => {
  // Host behind NAT we cannot see past, and it has reported nothing yet.
  assertEquals(
    resolveServerAddress({ remoteAddress: '10.0.2.2', ips: [] }),
    { address: '10.0.2.2', source: 'observed', scope: 'private' },
  )
})

test('a loopback wire address with nothing reported resolves to nothing', () => {
  assertEquals(resolveServerAddress({ remoteAddress: '127.0.0.1' }), null)
  assertEquals(resolveServerAddress({ remoteAddress: '' }), null)
  assertEquals(resolveServerAddress({}), null)
})

test('a co-located daemon is reported as local, not as an address', () => {
  assertEquals(
    resolveServerAddress({
      remoteAddress: DIRECT_ATTACH_SENTINEL,
      ips: LAN_IPS,
    }),
    {
      address: DIRECT_ATTACH_SENTINEL,
      source: 'local',
      scope: 'private',
    },
  )
})

test('an offline server still resolves its last reported interface', () => {
  assertEquals(
    resolveServerAddress({ remoteAddress: null, ips: LAN_IPS }),
    {
      address: '192.168.1.50',
      source: 'interface',
      scope: 'private',
      interface: 'eth0',
    },
  )
})
