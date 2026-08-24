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
  const assigned = assignSiteListenPorts(
    sites,
    new Map([['site', 9090]]),
  )
  assertEquals(assigned[0]?.listenPort, 9090)
})

test('emptyContainerComposeYaml is a valid empty services document', () => {
  assertEquals(emptyContainerComposeYaml(), 'services: {}\n')
})

test('allocateSiteListenPort throws when the range is exhausted', () => {
  const used = new Set<number>()
  for (let port = 18_080; port < 18_080 + 920; port++) {
    used.add(port)
  }
  assertThrows(
    () => allocateSiteListenPort('site', used),
    Error,
    'No free site listen port',
  )
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
