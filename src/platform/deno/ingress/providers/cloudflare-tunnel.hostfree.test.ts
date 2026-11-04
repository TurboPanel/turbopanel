import { assert, assertEquals } from '@std/assert'
import type { Db } from '../../../../db/connection.ts'
import type { InstanceHostnameRecord } from '../../../../features/install/instance-hostnames.ts'
import type { IngressAccountRecord } from '../accounts.ts'
import {
  createFakeCloudflare,
  type FakeCloudflare,
  type FakeCloudflareOptions,
} from '../cloudflare/fake-cloudflare.test.support.ts'
import {
  buildPanelIngress,
  originCertVerifiable,
  PANEL_RULES_VERSION,
  readTunnelState,
  tunnelName,
  tunnelPhase,
  tunnelRulesStale,
} from '../cloudflare/tunnel-config.ts'
import type { HostnameWithState, IngressContext } from '../provider.ts'
import { applyHostname } from '../registry.ts'
import { cloudflareTunnelProvider, routesName } from './cloudflare-tunnel.ts'

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

function harness(
  options: {
    gateOpen?: boolean
    selfCheck?: boolean
    refuse?: FakeCloudflareOptions['refuse']
  } = {}
): Harness {
  const cf = createFakeCloudflare({ token: TOKEN, refuse: options.refuse })
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
        gate: () =>
          Promise.resolve({
            open: options.gateOpen ?? true,
            waiting: [],
            remoteServers: 0,
            forcedClosed: false,
          }),
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
        noTLSVerify: true,
      },
    },
    {
      hostname: 'b.example.com',
      service: 'https://127.0.0.1:8443',
      originRequest: {
        originServerName: 'b.example.com',
        noTLSVerify: true,
      },
    },
    { service: 'http_status:404' },
  ])
})

test('buildPanelIngress verifies the origin only for names with a live public pair', () => {
  const rules = buildPanelIngress(
    ['a.example.com', 'b.example.com'],
    [],
    [],
    new Set(['a.example.com'])
  )
  assertEquals(rules[0]?.originRequest?.noTLSVerify, false)
  assertEquals(rules[1]?.originRequest?.noTLSVerify, true)
})

test('originCertVerifiable is true only for an issued ACME pair', () => {
  assertEquals(originCertVerifiable({ source: 'acme-dns-01', status: 'ready' }), true)
  assertEquals(originCertVerifiable({ source: 'acme-http-01', status: 'ready' }), true)
  assertEquals(originCertVerifiable({ source: 'acme-dns-01', status: 'pending' }), false)
  assertEquals(originCertVerifiable({ source: 'acme-dns-01', status: 'expired' }), false)
  assertEquals(originCertVerifiable({ source: 'uploaded', status: 'ready' }), false)
  assertEquals(originCertVerifiable({ source: 'platform-ca', status: 'ready' }), false)
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

test('apply verifies the origin once a public pair is live and records it', async () => {
  const live = { ...hostname('h1', 'panel.example.com'), source: 'acme-dns-01' as const }
  const h = harness()
  const result = await applyHostname(h.ctx(live))
  assert(result.ok)
  assertEquals(result.state.originVerified, true)
  const config = h.cf.configurations.get(h.cf.tunnels[0]!.id) as {
    config: { ingress: { originRequest?: { noTLSVerify?: boolean } }[] }
  }
  assertEquals(config.config.ingress[0]?.originRequest?.noTLSVerify, false)

  const pending = { ...live, status: 'pending' as const }
  const again = await applyHostname(harness().ctx(pending))
  assert(again.ok)
  assertEquals(again.state.originVerified, false)
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

test('a refused Connect step is named in the error', async () => {
  const cases: [string, RegExp, string][] = [
    ['POST', /cfd_tunnel$/, 'Creating the tunnel failed'],
    ['GET', /cfd_tunnel\?is_deleted=false&name=/, 'Finding the tunnel failed'],
    ['GET', /\/configurations$/, 'Reading the tunnel routes failed'],
    ['PUT', /\/configurations$/, 'Writing the tunnel routes failed'],
    ['GET', /dns_records\?name=/, 'Reading the DNS records failed'],
    ['POST', /dns_records$/, 'Creating the DNS record failed'],
    ['GET', /\/token$/, 'Getting the connector token failed'],
  ]
  for (const [method, path, label] of cases) {
    const h = harness({ refuse: [{ method, path, message: 'Authentication error' }] })
    const result = await applyHostname(h.ctx(hostname('h1', 'panel.example.com')))
    assertEquals(result.ok ? null : { cause: result.cause, detail: result.detail }, {
      cause: 'scope-missing',
      detail: `${label}: Cloudflare refused the request (403): Authentication error`,
    })
    assertEquals(h.pushed, [])
  }
})

test('replacing an existing record names its step when refused', async () => {
  const h = harness({
    refuse: [{ method: 'PUT', path: /dns_records\/rec-a$/, message: 'Authentication error' }],
  })
  h.cf.records.set('zone-1', [
    { id: 'rec-a', type: 'A', name: 'panel.example.com', content: '192.0.2.1' },
  ])
  const row = hostname('h1', 'panel.example.com')
  const result = await applyHostname({ ...h.ctx(row), replaceExisting: true })
  assertEquals(
    result.ok ? '' : result.detail,
    'Replacing the DNS record failed: Cloudflare refused the request (403): Authentication error'
  )
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

test('a dashboard-made tunnel behind the name is adopted, its other rules kept, and never deleted', async () => {
  const h = harness()
  const id = '6f0c3c1e-1111-4222-8333-944455556666'
  h.cf.tunnels.push({
    id,
    name: 'made-in-dashboard',
    status: 'healthy',
    connections: [{}, {}, {}, {}],
  })
  h.cf.configurations.set(id, {
    config: {
      ingress: [
        { hostname: 'panel.example.com', service: 'https://localhost:8443' },
        { hostname: 'other.example.com', service: 'http://localhost:3000' },
        { service: 'http_status:404' },
      ],
    },
  })
  h.cf.records.set('zone-1', [
    {
      id: 'rec-cname',
      type: 'CNAME',
      name: 'panel.example.com',
      content: `${id}.cfargotunnel.com`,
    },
  ])
  const result = await applyHostname(h.ctx(hostname('h1', 'panel.example.com')))
  assert(result.ok)
  assertEquals(result.state.tunnelId, id)
  assertEquals(result.state.adopted, true)
  assertEquals(result.state.createdRecord, false)
  assertEquals(h.cf.tunnels.length, 1)
  const config = h.cf.configurations.get(id) as {
    config: { ingress: { hostname?: string; service: string }[] }
  }
  assertEquals(
    config.config.ingress.map((rule) => [rule.hostname, rule.service]),
    [
      ['other.example.com', 'http://localhost:3000'],
      ['panel.example.com', 'https://127.0.0.1:8443'],
      [undefined, 'http_status:404'],
    ]
  )

  await cloudflareTunnelProvider.remove(h.ctx(hostname('h1', 'panel.example.com', result.state)))
  assertEquals(h.cf.tunnels.length, 1)
  assertEquals(h.cf.records.get('zone-1')?.length, 1)
  assertEquals(h.pushed.includes(''), false)
  const after = h.cf.configurations.get(id) as { config: { ingress: { hostname?: string }[] } }
  assertEquals(
    after.config.ingress.map((rule) => rule.hostname),
    ['other.example.com', undefined]
  )
})

test('an adopted tunnel keeps its own catch-all and its other configuration members', async () => {
  const h = harness()
  const id = '6f0c3c1e-1111-4222-8333-944455557777'
  h.cf.tunnels.push({ id, name: 'made-in-dashboard', status: 'healthy', connections: [] })
  h.cf.configurations.set(id, {
    config: {
      'warp-routing': { enabled: true },
      ingress: [{ service: 'http://localhost:9000' }],
    },
  })
  h.cf.records.set('zone-1', [
    {
      id: 'rec-cname',
      type: 'CNAME',
      name: 'panel.example.com',
      content: `${id}.cfargotunnel.com`,
    },
  ])
  const result = await applyHostname(h.ctx(hostname('h1', 'panel.example.com')))
  assert(result.ok)
  const config = h.cf.configurations.get(id) as {
    config: { 'warp-routing'?: unknown; ingress: { hostname?: string; service: string }[] }
  }
  assertEquals(config.config['warp-routing'], { enabled: true })
  assertEquals(
    config.config.ingress.map((rule) => [rule.hostname, rule.service]),
    [
      ['panel.example.com', 'https://127.0.0.1:8443'],
      [undefined, 'http://localhost:9000'],
    ]
  )
  await cloudflareTunnelProvider.remove(h.ctx(hostname('h1', 'panel.example.com', result.state)))
  const after = h.cf.configurations.get(id) as { config: { ingress: { service: string }[] } }
  assertEquals(
    after.config.ingress.map((rule) => rule.service),
    ['http://localhost:9000']
  )
})

function dashboardTunnel(h: Harness, id: string, extra: Record<string, unknown> = {}): void {
  h.cf.tunnels.push({ id, name: 'made-in-dashboard', status: 'healthy', connections: [], ...extra })
  h.cf.records.set('zone-1', [
    {
      id: 'rec-cname',
      type: 'CNAME',
      name: 'panel.example.com',
      content: `${id}.cfargotunnel.com`,
    },
  ])
}

test('a remotely managed tunnel with no configuration yet gets only our rule', async () => {
  const h = harness()
  const id = '6f0c3c1e-1111-4222-8333-944455558888'
  dashboardTunnel(h, id, { config_src: 'cloudflare' })
  const result = await applyHostname(h.ctx(hostname('h1', 'panel.example.com')))
  assert(result.ok)
  assert(h.cf.log.includes(`GET /accounts/acct-1/cfd_tunnel/${id}/configurations`))
  const config = h.cf.configurations.get(id) as {
    config: Record<string, unknown> & { ingress: { hostname?: string; service: string }[] }
  }
  assertEquals(Object.keys(config.config), ['ingress'])
  assertEquals(
    config.config.ingress.map((rule) => [rule.hostname, rule.service]),
    [
      ['panel.example.com', 'https://127.0.0.1:8443'],
      [undefined, 'http_status:404'],
    ]
  )
  assertEquals(h.pushed, [`run-token-for-${id}`])

  // Applying again (the tick) and removing read the same missing configuration without failing.
  const row = hostname('h1', 'panel.example.com', result.state)
  h.cf.configurations.delete(id)
  const again = await applyHostname(h.ctx(row))
  assert(again.ok)
  h.cf.configurations.delete(id)
  await cloudflareTunnelProvider.remove(h.ctx(row))
  assertEquals((h.cf.configurations.get(id) as { config: { ingress: unknown[] } }).config.ingress, [
    { service: 'http_status:404' },
  ])
})

test('a locally managed tunnel is refused before anything is written', async () => {
  for (const extra of [{ config_src: 'local' }, { remote_config: false }]) {
    const h = harness()
    const id = '6f0c3c1e-1111-4222-8333-944455559999'
    dashboardTunnel(h, id, extra)
    const result = await applyHostname(h.ctx(hostname('h1', 'panel.example.com')))
    assertEquals(result.ok ? null : { cause: result.cause, detail: result.detail }, {
      cause: 'tunnel-locally-managed',
      detail:
        'This tunnel is managed by a configuration file on its connector, so the control plane cannot add routes to it. In Cloudflare, open this tunnel and migrate it to dashboard management, then connect again.',
    })
    assertEquals(
      h.cf.log.filter((line) => !line.startsWith('GET ')),
      [],
      JSON.stringify(extra)
    )
    assertEquals(h.cf.configurations.has(id), false)
    assertEquals(h.pushed, [])
  }
})

test('an applied tunnel is read again on each apply and refused once it turns locally managed', async () => {
  const h = harness()
  const first = await applyHostname(h.ctx(hostname('h1', 'panel.example.com')))
  assert(first.ok)
  const row = hostname('h1', 'panel.example.com', first.state)
  h.cf.tunnels[0]!.config_src = 'local'
  const writes = h.cf.log.filter((line) => !line.startsWith('GET ')).length
  const again = await applyHostname(h.ctx(row))
  assertEquals(again.ok ? '' : again.cause, 'tunnel-locally-managed')
  assertEquals(h.cf.log.filter((line) => !line.startsWith('GET ')).length, writes)
})

test('a name with no account reads its state from the connector (pasted run token)', async () => {
  const h = harness()
  const row = { ...hostname('h1', 'panel.example.com'), ingressId: null }
  const withRoutes = (routed: string[] | null) => {
    const ctx = h.ctx(row)
    return {
      ...ctx,
      deps: { ...ctx.deps!, account: null, connectorHostnames: () => Promise.resolve(routed) },
    }
  }
  const routed = await cloudflareTunnelProvider.status(withRoutes(['panel.example.com']))
  assertEquals(routed.phase, 'healthy')
  assertEquals(routed.facts?.routedByConnector, true)
  const missing = await cloudflareTunnelProvider.status(withRoutes(['other.example.com']))
  assertEquals(missing.phase, 'not-applied')
  assert(missing.detail)
  assertEquals((await cloudflareTunnelProvider.status(withRoutes(null))).phase, 'not-applied')
  // Nothing reaches Cloudflare: there is no account to ask.
  assertEquals(h.cf.log.length, 0)
})

test('a routed wildcard covers exactly one label', () => {
  assertEquals(routesName(['*.example.com'], 'panel.example.com'), true)
  assertEquals(routesName(['*.example.com'], 'a.b.example.com'), false)
  assertEquals(routesName(['*.example.com'], 'example.com'), false)
  assertEquals(routesName(['panel.example.com'], 'panel.example.com'), true)
  assertEquals(routesName([], 'panel.example.com'), false)
})

test('rules written in an older shape are applied again, so a fix reaches tunnels already set up', () => {
  const before = readTunnelState({ tunnelId: 't1', accountId: 'a1', originVerified: false })
  assertEquals(before?.rulesVersion, 1)
  assertEquals(tunnelRulesStale(before!, false), true)
  const current = { ...before!, rulesVersion: PANEL_RULES_VERSION }
  assertEquals(tunnelRulesStale(current, false), false)
  // A certificate that changed under the rule still makes it stale.
  assertEquals(tunnelRulesStale(current, true), true)
})

test('the panel route lets the visitor Host through, so the edge-port redirect cannot loop', () => {
  const [rule] = buildPanelIngress(['panel.example.com'])
  assertEquals(rule?.originRequest?.httpHostHeader, undefined)
  assertEquals(rule?.originRequest?.originServerName, 'panel.example.com')
})
