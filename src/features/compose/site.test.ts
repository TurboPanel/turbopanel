import { assertEquals, assertThrows } from '@std/assert'
import {
  allocateSiteListenPort,
  assignSiteListenPorts,
  emptyContainerComposeYaml,
  isSafeSiteRoot,
  splitSiteServices,
} from './site.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('isSafeSiteRoot rejects traversal and absolute paths', () => {
  assertEquals(isSafeSiteRoot('public'), true)
  assertEquals(isSafeSiteRoot('www/html'), true)
  assertEquals(isSafeSiteRoot('/var/www'), false)
  assertEquals(isSafeSiteRoot('../etc'), false)
  assertEquals(isSafeSiteRoot(''), false)
})

test('allocateSiteListenPort prefers hosting targetPort when free', () => {
  const used = new Set<number>()
  assertEquals(allocateSiteListenPort('site', used, 8080), 8080)
  assertEquals(used.has(8080), true)
  // Second call with same preferred falls back to hash range.
  const second = allocateSiteListenPort('site', used, 8080)
  assertEquals(second >= 18_080 && second <= 18_999, true)
  assertEquals(second !== 8080, true)
})

test('allocateSiteListenPort gives the same service name different ports per environment key', () => {
  const first = allocateSiteListenPort('site', new Set(), undefined, 'env-a')
  const second = allocateSiteListenPort('site', new Set(), undefined, 'env-b')
  assertEquals(first !== second, true)
  // Stable for the same key.
  assertEquals(allocateSiteListenPort('site', new Set(), undefined, 'env-a'), first)
})

test('splitSiteServices partitions container vs site', () => {
  const result = splitSiteServices({
    api: { image: 'node:22' },
    site: {
      'x-turbopanel': {
        serviceKind: 'site',
        engine: 'nginx',
        root: 'www',
      },
    },
    legacy: {
      'x-turbopanel': {
        serviceKind: 'site',
        engine: 'apache',
      },
    },
  })

  assertEquals(Object.keys(result.containerServices), ['api'])
  assertEquals(result.sites.length, 2)
  assertEquals(result.sites[0]?.composeServiceName, 'legacy')
  assertEquals(result.sites[0]?.engine, 'apache')
  assertEquals(result.sites[1]?.composeServiceName, 'site')
  assertEquals(result.sites[1]?.root, 'www')
})

test('splitSiteServices accepts openlitespeed', () => {
  const result = splitSiteServices({
    ols: {
      'x-turbopanel': {
        serviceKind: 'site',
        engine: 'openlitespeed',
      },
    },
  })
  assertEquals(result.sites.length, 1)
  assertEquals(result.sites[0]?.engine, 'openlitespeed')
})

test('assignSiteListenPorts reassigns from preferred map', () => {
  const sites = splitSiteServices({
    site: {
      'x-turbopanel': { serviceKind: 'site', engine: 'nginx' },
    },
  }).sites
  const assigned = assignSiteListenPorts(sites, new Map([['site', 9090]]))
  assertEquals(assigned[0]?.listenPort, 9090)
})

test("nginx+apache sites get Apache's own port from the same ledger", () => {
  const used = new Set<number>()
  const { sites } = splitSiteServices(
    {
      plain: { 'x-turbopanel': { serviceKind: 'site', engine: 'nginx' } },
      wp: { 'x-turbopanel': { serviceKind: 'site', engine: 'nginx+apache' } },
    },
    new Map(),
    used
  )
  const wp = sites.find((site) => site.composeServiceName === 'wp')
  const plain = sites.find((site) => site.composeServiceName === 'plain')
  assertEquals(wp?.engine, 'nginx+apache')
  assertEquals(typeof wp?.backendPort, 'number')
  assertEquals(plain?.backendPort, undefined)
  const ports = sites.flatMap((site) => [site.listenPort, site.backendPort])
  const allocated = ports.filter((port) => port !== undefined)
  assertEquals(new Set(allocated).size, 3)
  for (const port of allocated) assertEquals(used.has(port as number), true)

  // Reassigned after hosting targetPorts are known: preferred listen ports win,
  // backends are allocated after them, and nothing collides.
  const assigned = assignSiteListenPorts(
    sites,
    new Map([
      ['plain', 9090],
      ['wp', 9091],
    ])
  )
  const reWp = assigned.find((site) => site.composeServiceName === 'wp')
  assertEquals(reWp?.listenPort, 9091)
  assertEquals(reWp?.backendPort !== undefined && ![9090, 9091].includes(reWp.backendPort), true)
  assertEquals(assigned.find((site) => site.composeServiceName === 'plain')?.backendPort, undefined)
})

test("Apache's backend port sits in its own band, clear of every hashed listen port", () => {
  const services: Record<string, unknown> = {}
  for (let i = 0; i < 40; i++) {
    services[`wp${i}`] = { 'x-turbopanel': { serviceKind: 'site', engine: 'nginx+apache' } }
  }
  const sites = assignSiteListenPorts(
    splitSiteServices(services).sites,
    new Map(),
    new Set(),
    'env-a'
  )
  for (const site of sites) {
    // Another environment's hashed listenPort can never be handed out as a backend.
    assertEquals(site.listenPort >= 18_080 && site.listenPort <= 18_999, true)
    const backend = site.backendPort as number
    assertEquals(backend >= 19_100 && backend <= 19_799, true, String(backend))
  }
})

test('backend ports are stable per environment and differ between environments', () => {
  const services = {
    shop: { 'x-turbopanel': { serviceKind: 'site', engine: 'nginx+apache' } },
  }
  const backendFor = (environmentId: string) =>
    assignSiteListenPorts(splitSiteServices(services).sites, new Map(), new Set(), environmentId)[0]
      ?.backendPort
  // Same environment, fresh ledger (nothing is persisted): the same port.
  assertEquals(backendFor('env-staging'), backendFor('env-staging'))
  // Two environments deploying the same compose file on one server must not
  // derive the same port for the same service name.
  assertEquals(backendFor('env-staging') !== backendFor('env-production'), true)
})

test('emptyContainerComposeYaml is a valid empty services document', () => {
  assertEquals(emptyContainerComposeYaml(), 'services: {}\n')
})

test('allocateSiteListenPort throws when the range is exhausted', () => {
  const used = new Set<number>()
  for (let port = 18_080; port < 18_080 + 920; port++) {
    used.add(port)
  }
  assertThrows(() => allocateSiteListenPort('site', used), Error, 'No free site listen port')
})

test('splitSiteServices defaults a missing engine to caddy and an unsafe root to public', () => {
  const result = splitSiteServices({
    bare: {
      'x-turbopanel': { serviceKind: 'site' },
    },
    unsafe: {
      'x-turbopanel': {
        serviceKind: 'site',
        engine: 'nginx',
        root: '../etc',
      },
    },
  })
  assertEquals(Object.keys(result.containerServices), [])
  assertEquals(result.sites.length, 2)
  // This is the one place the default is applied, so the wire always carries
  // an explicit engine and the daemon never has to guess.
  const bare = result.sites.find((s) => s.composeServiceName === 'bare')
  assertEquals(bare?.engine, 'caddy')
  assertEquals(bare?.root, 'public')
  const unsafe = result.sites.find((s) => s.composeServiceName === 'unsafe')
  assertEquals(unsafe?.root, 'public')
})

test('splitSiteServices carries sourceKind through to the site spec', () => {
  const { sites } = splitSiteServices({
    blog: {
      'x-turbopanel': {
        serviceKind: 'site',
        root: 'public',
        sourceKind: 'managed-directory',
      },
    },
    app: { 'x-turbopanel': { serviceKind: 'site', root: 'public' } },
  })
  assertEquals(sites.length, 2)
  // Absent stays absent rather than being resolved to an explicit `release`:
  // the daemon reads an absent value the same way, and emitting it would churn
  // the wire for every site that never opted in.
  assertEquals(sites.find((s) => s.composeServiceName === 'app')?.sourceKind, undefined)
  assertEquals(sites.find((s) => s.composeServiceName === 'blog')?.sourceKind, 'managed-directory')
})

test('an unknown sourceKind is dropped rather than carried', () => {
  const { sites } = splitSiteServices({
    blog: {
      'x-turbopanel': {
        serviceKind: 'site',
        root: 'public',
        sourceKind: 'whatever',
      },
    },
  })
  // Falls back to the release lane, which is the safe default: it asserts a
  // tree rather than creating a principal-writable one.
  assertEquals(sites[0]?.sourceKind, undefined)
})
