import { assertEquals, assertThrows } from '@std/assert'
import {
  allocateTraditionalWebListenPort,
  assignTraditionalWebListenPorts,
  emptyContainerComposeYaml,
  isSafeTraditionalWebRoot,
  splitTraditionalWebServices,
} from './traditional-web.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('isSafeTraditionalWebRoot rejects traversal and absolute paths', () => {
  assertEquals(isSafeTraditionalWebRoot('public'), true)
  assertEquals(isSafeTraditionalWebRoot('www/html'), true)
  assertEquals(isSafeTraditionalWebRoot('/var/www'), false)
  assertEquals(isSafeTraditionalWebRoot('../etc'), false)
  assertEquals(isSafeTraditionalWebRoot(''), false)
})

test('allocateTraditionalWebListenPort prefers hosting targetPort when free', () => {
  const used = new Set<number>()
  assertEquals(allocateTraditionalWebListenPort('site', used, 8080), 8080)
  assertEquals(used.has(8080), true)
  // Second call with same preferred falls back to hash range.
  const second = allocateTraditionalWebListenPort('site', used, 8080)
  assertEquals(second >= 18_080 && second <= 18_999, true)
  assertEquals(second !== 8080, true)
})

test('splitTraditionalWebServices partitions container vs traditional-web', () => {
  const result = splitTraditionalWebServices({
    api: { image: 'node:22' },
    site: {
      'x-turbopanel': {
        serviceKind: 'traditional-web',
        engine: 'nginx',
        root: 'www',
      },
    },
    legacy: {
      'x-turbopanel': {
        serviceKind: 'traditional-web',
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

test('splitTraditionalWebServices accepts openlitespeed', () => {
  const result = splitTraditionalWebServices({
    ols: {
      'x-turbopanel': {
        serviceKind: 'traditional-web',
        engine: 'openlitespeed',
      },
    },
  })
  assertEquals(result.sites.length, 1)
  assertEquals(result.sites[0]?.engine, 'openlitespeed')
})

test('assignTraditionalWebListenPorts reassigns from preferred map', () => {
  const sites = splitTraditionalWebServices({
    site: {
      'x-turbopanel': { serviceKind: 'traditional-web', engine: 'nginx' },
    },
  }).sites
  const assigned = assignTraditionalWebListenPorts(
    sites,
    new Map([['site', 9090]]),
  )
  assertEquals(assigned[0]?.listenPort, 9090)
})

test('emptyContainerComposeYaml is a valid empty services document', () => {
  assertEquals(emptyContainerComposeYaml(), 'services: {}\n')
})

test('allocateTraditionalWebListenPort throws when the range is exhausted', () => {
  const used = new Set<number>()
  for (let port = 18_080; port < 18_080 + 920; port++) {
    used.add(port)
  }
  assertThrows(
    () => allocateTraditionalWebListenPort('site', used),
    Error,
    'No free traditional-web listen port',
  )
})

test('splitTraditionalWebServices skips services missing engine and defaults unsafe root', () => {
  const result = splitTraditionalWebServices({
    broken: {
      'x-turbopanel': { serviceKind: 'traditional-web' },
    },
    unsafe: {
      'x-turbopanel': {
        serviceKind: 'traditional-web',
        engine: 'nginx',
        root: '../etc',
      },
    },
  })
  assertEquals(Object.keys(result.containerServices), [])
  assertEquals(result.sites.length, 1)
  assertEquals(result.sites[0]?.composeServiceName, 'unsafe')
  assertEquals(result.sites[0]?.root, 'public')
})
