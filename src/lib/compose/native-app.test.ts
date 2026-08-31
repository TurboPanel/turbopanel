import { assertEquals } from '@std/assert'
import {
  assignNativeAppListenPorts,
  splitNativeAppServices,
} from './native-app.ts'
import {
  assignSiteListenPorts,
  splitSiteServices,
} from './site.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SOURCE_ID = '11111111-2222-3333-4444-555555555555'

function nodeService(extra: Record<string, unknown> = {}) {
  return {
    'x-turbopanel': {
      serviceKind: 'node',
      source: { sourceId: SOURCE_ID },
      ...extra,
    },
  }
}

test('splitNativeAppServices pulls node services out of the container map', () => {
  const { containerServices, apps } = splitNativeAppServices({
    api: { image: 'node:24' },
    web: nodeService({ framework: 'next', nodeVersion: '24.17.0' }),
  })

  assertEquals(Object.keys(containerServices), ['api'])
  assertEquals(apps.length, 1)
  assertEquals(apps[0]?.composeServiceName, 'web')
  assertEquals(apps[0]?.framework, 'next')
  assertEquals(apps[0]?.nodeVersion, '24.17.0')
})

test('splitNativeAppServices defaults framework to auto', () => {
  const { apps } = splitNativeAppServices({ web: nodeService() })
  assertEquals(apps[0]?.framework, 'auto')
})

test('splitNativeAppServices carries appMode, enabled, and startupFile', () => {
  const { apps } = splitNativeAppServices({
    web: nodeService({
      appMode: 'development',
      enabled: false,
      startupFile: 'app.js',
    }),
  })

  // A disabled app is still emitted — dropping it would make reconcile tear
  // the unit down and strand the release.
  assertEquals(apps.length, 1)
  assertEquals(apps[0]?.appMode, 'development')
  assertEquals(apps[0]?.enabled, false)
  assertEquals(apps[0]?.startupFile, 'app.js')
})

test('undeclared node app settings stay absent on the split spec', () => {
  const { apps } = splitNativeAppServices({ web: nodeService() })
  assertEquals(apps.length, 1)
  assertEquals('appMode' in (apps[0] ?? {}), false)
  assertEquals('enabled' in (apps[0] ?? {}), false)
  assertEquals('startupFile' in (apps[0] ?? {}), false)
})

test('a node service with no source is dropped rather than left for Docker', () => {
  // Validation rejects this document; if one slips through, an image-less
  // service handed to `compose up` would fail the whole deploy.
  const { containerServices, apps } = splitNativeAppServices({
    web: { 'x-turbopanel': { serviceKind: 'node' } },
  })
  assertEquals(Object.keys(containerServices), [])
  assertEquals(apps, [])
})

test('site and native apps never share a loopback port', () => {
  const services: Record<string, unknown> = {
    site: {
      'x-turbopanel': { serviceKind: 'site', engine: 'nginx' },
    },
    web: nodeService(),
    worker: nodeService(),
  }

  const used = new Set<number>()
  const split = splitSiteServices(services, new Map(), used)
  const native = splitNativeAppServices(split.containerServices, used)

  const ports = [
    ...split.sites.map((site) => site.listenPort),
    ...native.apps.map((app) => app.listenPort),
  ]
  assertEquals(ports.length, 3)
  assertEquals(new Set(ports).size, 3)
})

test('re-assignment keeps the two lanes disjoint when a hosting pins a port', () => {
  const used = new Set<number>()
  const sites = assignSiteListenPorts(
    [{
      composeServiceName: 'site',
      engine: 'nginx',
      root: 'public',
      listenPort: 0,
    }],
    new Map([['site', 18100]]),
    used,
  )
  const apps = assignNativeAppListenPorts(
    [{ composeServiceName: 'web', framework: 'auto' as const, listenPort: 0 }],
    // A native app asking for the port the site already took must be moved,
    // not silently given a duplicate.
    new Map([['web', 18100]]),
    used,
  )

  assertEquals(sites[0]?.listenPort, 18100)
  assertEquals(apps[0]?.listenPort === 18100, false)
})
