import { assert, assertEquals } from '@std/assert'
import type { Db } from '../../../../db/connection.ts'
import type { InstanceHostnameRecord } from '../../../../features/install/instance-hostnames.ts'
import type { IngressAccountRecord } from '../accounts.ts'
import {
  createFakeCloudflare,
  type FakeCloudflare,
} from '../cloudflare/fake-cloudflare.test.support.ts'
import { buildPanelIngress, tunnelName, tunnelPhase } from '../cloudflare/tunnel-config.ts'
import type { HostnameWithState, IngressContext } from '../provider.ts'
import { applyHostname } from '../registry.ts'
import { cloudflareTunnelProvider } from './cloudflare-tunnel.ts'

const test = Deno.test.bind(Deno)

const TOKEN = 'cfut_fixtureTokenValue0123456789abcdef'
const NOW = new Date('2026-11-01T00:00:00.000Z')

const ACCOUNT: IngressAccountRecord = {
  id: 'ingress-1',
  provider: 'cloudflare',
  label: 'Fixture',
  accountId: 'acct-1',
  zoneIds: ['zone-1'],
  scopes: {
    tunnels: true,
    dns: true,
    checkedAt: NOW.toISOString(),
    zones: [{ id: 'zone-1', name: 'example.com' }],
    expiresOn: null,
  },
  lastVerifiedAt: NOW.toISOString(),
  lastError: null,
  createdAt: NOW.toISOString(),
}

function hostname(
  id: string,
  host: string,
  providerState: Record<string, unknown> | null = null
): HostnameWithState {
  const record: InstanceHostnameRecord = {
    id,
    host: `https://${host}:8443`,
    source: 'platform-ca',
    uploadedCertId: null,
    status: 'ready',
    notAfter: null,
    acmeLastAttemptAt: null,
    acmeLastError: null,
    mode: 'cloudflare-tunnel',
    publicPort: 8443,
    isPrimary: false,
    isDaemonDial: true,
    ingressId: ACCOUNT.id,
  }
  return { ...record, providerState }
}

type Harness = {
  cf: FakeCloudflare
  pushed: string[]
  ctx: (row: HostnameWithState, rows?: HostnameWithState[]) => IngressContext
}

function harness(options: { gateOpen?: boolean; selfCheck?: boolean } = {}): Harness {
  const cf = createFakeCloudflare({ token: TOKEN })
  const pushed: string[] = []
  const edgeFetch: typeof fetch = (input, init) => {
    if (String(input).startsWith('https://panel.example.com')) {
      return Promise.resolve(
        new Response('{}', { headers: { 'x-turbopanel-signature': 'kid:sig' } })
      )
    }
    return cf.fetch(input, init)
  }
  return {
    cf,
    pushed,
    ctx: (row, rows = [row]) => ({
      hostname: row,
      deps: {
        db: {} as Db,
        now: () => NOW,
        fetch: edgeFetch,
        gate: {
          open: options.gateOpen ?? true,
          confirmedAt: null,
          confirmedBy: null,
          forcedClosed: false,
        },
        colocatedDaemonConnected: () => Promise.resolve(true),
        pushRunToken: (token) => {
          pushed.push(token)
          return Promise.resolve({ ok: true })
        },
        account: ACCOUNT,
        openToken: () => Promise.resolve(TOKEN),
        hostnames: rows,
        instanceId: 'abcdefghijklmnop',
        isOwnIdentity: () => Promise.resolve(options.selfCheck ?? true),
      },
    }),
  }
}

test('buildPanelIngress sends every name to the loopback listener with a catch-all last', () => {
  assertEquals(buildPanelIngress(['B.example.com', 'a.example.com', 'b.example.com']), [
    {
      hostname: 'a.example.com',
      service: 'https://127.0.0.1:8443',
      originRequest: {
        originServerName: 'a.example.com',
        httpHostHeader: 'a.example.com',
        noTLSVerify: true,
      },
    },
    {
      hostname: 'b.example.com',
      service: 'https://127.0.0.1:8443',
      originRequest: {
        originServerName: 'b.example.com',
        httpHostHeader: 'b.example.com',
        noTLSVerify: true,
      },
    },
    { service: 'http_status:404' },
  ])
})

test('apply creates the tunnel, the proxied CNAME and pushes the run token', async () => {
  const h = harness()
  const result = await applyHostname(h.ctx(hostname('h1', 'panel.example.com')))
  assert(result.ok)
  assertEquals(
    h.cf.tunnels.map((t) => t.name),
    [tunnelName('abcdefghijklmnop')]
  )
  const [record] = h.cf.records.get('zone-1') ?? []
  assertEquals(record?.type, 'CNAME')
  assertEquals(record?.content, `${h.cf.tunnels[0]!.id}.cfargotunnel.com`)
  assertEquals(record?.proxied, true)
  assertEquals(h.pushed, [`run-token-for-${h.cf.tunnels[0]!.id}`])
  assertEquals(JSON.stringify(result.state).includes('run-token'), false)
})

test('apply adopts a tunnel that already has our name', async () => {
  const h = harness()
  h.cf.tunnels.push({
    id: 'tun-existing',
    name: tunnelName('abcdefghijklmnop'),
    status: 'healthy',
    connections: [],
  })
  const result = await applyHostname(h.ctx(hostname('h1', 'panel.example.com')))
  assert(result.ok)
  assertEquals(h.cf.tunnels.length, 1)
  assertEquals(
    h.cf.log.some((line) => line.startsWith('POST /accounts/acct-1/cfd_tunnel')),
    false
  )
  assertEquals(result.state.tunnelId, 'tun-existing')
})

test('apply refuses a name that already has another DNS record, unless asked to replace it', async () => {
  const h = harness()
  h.cf.records.set('zone-1', [
    { id: 'rec-a', type: 'A', name: 'panel.example.com', content: '192.0.2.1' },
  ])
  const row = hostname('h1', 'panel.example.com')
  const refused = await applyHostname(h.ctx(row))
  assertEquals(refused.ok ? '' : refused.cause, 'dns-conflict')
  const replaced = await applyHostname({ ...h.ctx(row), replaceExisting: true })
  assert(replaced.ok)
  assertEquals(h.cf.records.get('zone-1')?.[0]?.type, 'CNAME')
})

test('apply stays refused while the edge gate is shut', async () => {
  const h = harness({ gateOpen: false })
  const result = await applyHostname(h.ctx(hostname('h1', 'panel.example.com')))
  assertEquals(result.ok ? '' : result.cause, 'gate-closed')
  assertEquals(h.cf.log.length, 0)
})

test('tunnel phase: four connections is healthy, two is degraded, none after the grace is failed', () => {
  const four = { status: 'healthy' as const, connections: [{}, {}, {}, {}] }
  assertEquals(tunnelPhase(four, NOW.toISOString(), NOW).phase, 'healthy')
  assertEquals(
    tunnelPhase({ status: 'degraded', connections: [{}, {}] }, NOW.toISOString(), NOW).phase,
    'degraded'
  )
  const later = new Date(NOW.getTime() + 3 * 60_000)
  assertEquals(
    tunnelPhase({ status: 'inactive', connections: [] }, NOW.toISOString(), later).phase,
    'failed'
  )
  assertEquals(
    tunnelPhase({ status: 'inactive', connections: [] }, NOW.toISOString(), NOW).phase,
    'applying'
  )
})

test('status reads health and checks itself through the edge', async () => {
  const h = harness({ selfCheck: false })
  const applied = await applyHostname(h.ctx(hostname('h1', 'panel.example.com')))
  assert(applied.ok)
  h.cf.tunnels[0]!.status = 'healthy'
  h.cf.tunnels[0]!.connections = [{}, {}, {}, {}]
  const row = hostname('h1', 'panel.example.com', applied.state)
  const status = await cloudflareTunnelProvider.status(h.ctx(row))
  assertEquals(status.phase, 'degraded')
  assertEquals(status.cause, 'edge-unreachable')
})

test('remove of the last name deletes its record and the tunnel and stops the connector', async () => {
  const h = harness()
  const applied = await applyHostname(h.ctx(hostname('h1', 'panel.example.com')))
  assert(applied.ok)
  await cloudflareTunnelProvider.remove(h.ctx(hostname('h1', 'panel.example.com', applied.state)))
  assertEquals(h.cf.tunnels.length, 0)
  assertEquals(h.cf.records.get('zone-1'), [])
  assertEquals(h.pushed.at(-1), '')
})

test('remove of one of two names keeps the tunnel with the other name', async () => {
  const h = harness()
  const first = await applyHostname(h.ctx(hostname('h1', 'panel.example.com')))
  assert(first.ok)
  const one = hostname('h1', 'panel.example.com', first.state)
  const second = await applyHostname(
    h.ctx(hostname('h2', 'admin.example.com'), [one, hostname('h2', 'admin.example.com')])
  )
  assert(second.ok)
  const two = hostname('h2', 'admin.example.com', second.state)
  await cloudflareTunnelProvider.remove(h.ctx(one, [one, two]))
  assertEquals(h.cf.tunnels.length, 1)
  const config = h.cf.configurations.get(h.cf.tunnels[0]!.id) as {
    config: { ingress: { hostname?: string }[] }
  }
  assertEquals(
    config.config.ingress.map((rule) => rule.hostname),
    ['admin.example.com', undefined]
  )
})
