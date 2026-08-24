import { assertEquals } from '@std/assert'
import {
  collectServiceTurbopanelValidationIssues,
  isNodeComposeService,
  isTraditionalWebComposeService,
  parseServiceTurbopanelExtension,
  readServiceTurbopanelExtension,
} from './service-kind.ts'
import { validateComposeDocument } from './validate.ts'
import { lintComposeYaml } from './lint.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parseServiceTurbopanelExtension accepts traditional-web with engine', () => {
  assertEquals(
    parseServiceTurbopanelExtension({
      serviceKind: 'traditional-web',
      engine: 'nginx',
    }),
    { serviceKind: 'traditional-web', engine: 'nginx' },
  )
})

test('parseServiceTurbopanelExtension accepts traditional-web root', () => {
  assertEquals(
    parseServiceTurbopanelExtension({
      serviceKind: 'traditional-web',
      engine: 'nginx',
      root: 'www',
    }),
    { serviceKind: 'traditional-web', engine: 'nginx', root: 'www' },
  )
})

test('collectServiceTurbopanelValidationIssues rejects unsafe root', () => {
  const issues = collectServiceTurbopanelValidationIssues({
    site: {
      'x-turbopanel': {
        serviceKind: 'traditional-web',
        engine: 'nginx',
        root: '../etc',
      },
    },
  })
  assertEquals(
    issues.some((issue) => issue.path === 'services.site.x-turbopanel.root'),
    true,
  )
})

test('collectServiceTurbopanelValidationIssues requires engine for traditional-web', () => {
  const issues = collectServiceTurbopanelValidationIssues({
    site: {
      'x-turbopanel': { serviceKind: 'traditional-web' },
    },
  })
  assertEquals(
    issues.some((issue) => issue.path === 'services.site.x-turbopanel.engine'),
    true,
  )
})

test('collectServiceTurbopanelValidationIssues rejects engine without traditional-web', () => {
  const issues = collectServiceTurbopanelValidationIssues({
    site: {
      'x-turbopanel': { engine: 'apache' },
    },
  })
  assertEquals(issues.length, 1)
  assertEquals(issues[0]?.message.includes('traditional-web'), true)
})

test('validateComposeDocument accepts traditional-web without image or build', () => {
  const result = validateComposeDocument({
    version: 1,
    data: {
      services: {
        site: {
          'x-turbopanel': {
            serviceKind: 'traditional-web',
            engine: 'openlitespeed',
          },
        },
      },
    },
    presentation: { keyOrder: ['services'], comments: {} },
  })
  assertEquals(result.ok, true)
  if (result.ok) {
    assertEquals(
      isTraditionalWebComposeService(
        (result.document.data.services as Record<string, Record<string, unknown>>).site,
      ),
      true,
    )
  }
})

test('lintComposeYaml allows traditional-web service without image', () => {
  const source = `services:
  site:
    x-turbopanel:
      serviceKind: traditional-web
      engine: nginx
`
  const issues = lintComposeYaml(source)
  assertEquals(
    issues.some((issue) => issue.message.includes('must define "image" or "build"')),
    false,
  )
})

test('parseServiceTurbopanelExtension rejects non-mapping values', () => {
  assertEquals(parseServiceTurbopanelExtension('bad'), null)
  assertEquals(parseServiceTurbopanelExtension(null), {})
})

test('readServiceTurbopanelExtension returns empty when extension absent', () => {
  assertEquals(readServiceTurbopanelExtension({ image: 'nginx' }), {})
})

test('collectServiceTurbopanelValidationIssues rejects invalid serviceKind and engine', () => {
  const issues = collectServiceTurbopanelValidationIssues({
    site: {
      'x-turbopanel': { serviceKind: 'vm', engine: 'caddy' },
    },
  })
  assertEquals(
    issues.some((issue) => issue.path === 'services.site.x-turbopanel.serviceKind'),
    true,
  )
  assertEquals(
    issues.some((issue) => issue.path === 'services.site.x-turbopanel.engine'),
    true,
  )
})

test('collectServiceTurbopanelValidationIssues rejects root without traditional-web', () => {
  const issues = collectServiceTurbopanelValidationIssues({
    api: {
      image: 'node:22',
      'x-turbopanel': { root: 'public' },
    },
  })
  assertEquals(
    issues.some((issue) => issue.path === 'services.api.x-turbopanel.root'),
    true,
  )
})

test('collectServiceTurbopanelValidationIssues rejects non-mapping x-turbopanel', () => {
  const issues = collectServiceTurbopanelValidationIssues({
    api: {
      image: 'node:22',
      'x-turbopanel': 'bad',
    },
  })
  assertEquals(issues[0]?.message.includes('must be a mapping'), true)
})

test('validateComposeDocument surfaces service extension validation issues', () => {
  const result = validateComposeDocument({
    version: 1,
    data: {
      services: {
        site: {
          'x-turbopanel': { serviceKind: 'traditional-web', engine: 'bad-engine' },
        },
      },
    },
    presentation: { keyOrder: ['services'], comments: {} },
  })
  assertEquals(result.ok, false)
})

test('isTraditionalWebComposeService is false for invalid extension mapping', () => {
  assertEquals(
    isTraditionalWebComposeService({ 'x-turbopanel': 'bad' }),
    false,
  )
})

test('collectServiceTurbopanelValidationIssues rejects invalid serviceKind types', () => {
  const issues = collectServiceTurbopanelValidationIssues({
    site: {
      'x-turbopanel': { serviceKind: 42, engine: 'nginx' },
    },
  })
  assertEquals(
    issues.some((issue) => issue.path === 'services.site.x-turbopanel.serviceKind'),
    true,
  )
})

test('collectServiceTurbopanelValidationIssues accepts safe traditional-web roots', () => {
  const issues = collectServiceTurbopanelValidationIssues({
    site: {
      'x-turbopanel': {
        serviceKind: 'traditional-web',
        engine: 'nginx',
        root: 'public/www',
      },
    },
  })
  assertEquals(issues.length, 0)
})

test('collectServiceTurbopanelValidationIssues rejects absolute and empty roots', () => {
  const absolute = collectServiceTurbopanelValidationIssues({
    site: {
      'x-turbopanel': {
        serviceKind: 'traditional-web',
        engine: 'nginx',
        root: '/etc',
      },
    },
  })
  assertEquals(
    absolute.some((issue) => issue.path === 'services.site.x-turbopanel.root'),
    true,
  )

  const empty = collectServiceTurbopanelValidationIssues({
    site: {
      'x-turbopanel': {
        serviceKind: 'traditional-web',
        engine: 'nginx',
        root: '   ',
      },
    },
  })
  assertEquals(
    empty.some((issue) => issue.path === 'services.site.x-turbopanel.engine'),
    false,
  )
})

test('collectServiceTurbopanelValidationIssues skips non-mapping services', () => {
  assertEquals(
    collectServiceTurbopanelValidationIssues({ bad: 'raw' }),
    [],
  )
})

test('parseServiceTurbopanelExtension accepts description', () => {
  assertEquals(
    parseServiceTurbopanelExtension({
      serviceKind: 'container',
      description: '  API gateway  ',
    }),
    { serviceKind: 'container', description: 'API gateway' },
  )
})

test('parseServiceTurbopanelExtension drops empty or overlong description', () => {
  assertEquals(
    parseServiceTurbopanelExtension({ description: '   ' }),
    {},
  )
  assertEquals(
    parseServiceTurbopanelExtension({ description: 'x'.repeat(501) }),
    {},
  )
})

test('collectServiceTurbopanelValidationIssues rejects non-string description', () => {
  const issues = collectServiceTurbopanelValidationIssues({
    api: {
      image: 'node:22',
      'x-turbopanel': { description: 42 },
    },
  })
  assertEquals(
    issues.some((issue) => issue.path === 'services.api.x-turbopanel.description'),
    true,
  )
})

test('collectServiceTurbopanelValidationIssues rejects overlong description', () => {
  const issues = collectServiceTurbopanelValidationIssues({
    api: {
      image: 'node:22',
      'x-turbopanel': { description: 'y'.repeat(501) },
    },
  })
  assertEquals(
    issues.some((issue) => issue.path === 'services.api.x-turbopanel.description'),
    true,
  )
})

const NODE_SOURCE_ID = '11111111-2222-3333-4444-555555555555'

test('serviceKind node parses with its framework and version hints', () => {
  const parsed = parseServiceTurbopanelExtension({
    serviceKind: 'node',
    framework: 'next',
    nodeVersion: '24.17.0',
    source: { sourceId: NODE_SOURCE_ID, startCommand: 'node server.js' },
  })
  assertEquals(parsed?.serviceKind, 'node')
  assertEquals(parsed?.framework, 'next')
  assertEquals(parsed?.nodeVersion, '24.17.0')
  assertEquals(parsed?.source?.startCommand, 'node server.js')
})

test('isNodeComposeService distinguishes node from the other kinds', () => {
  assertEquals(
    isNodeComposeService({ 'x-turbopanel': { serviceKind: 'node' } }),
    true,
  )
  assertEquals(
    isNodeComposeService({
      'x-turbopanel': { serviceKind: 'traditional-web' },
    }),
    false,
  )
  assertEquals(isNodeComposeService({ image: 'node:24' }), false)
})

test('a node service without a source is rejected', () => {
  const issues = collectServiceTurbopanelValidationIssues({
    web: { 'x-turbopanel': { serviceKind: 'node' } },
  })
  assertEquals(
    issues.some((issue) =>
      issue.path === 'services.web.x-turbopanel.source' &&
      issue.message === 'node services require source'
    ),
    true,
  )
})

test('image and build are rejected on a node service', () => {
  const issues = collectServiceTurbopanelValidationIssues({
    web: {
      image: 'node:24',
      build: '.',
      'x-turbopanel': {
        serviceKind: 'node',
        source: { sourceId: NODE_SOURCE_ID },
      },
    },
  })
  assertEquals(
    issues.some((issue) => issue.path === 'services.web.image'),
    true,
  )
  assertEquals(
    issues.some((issue) => issue.path === 'services.web.build'),
    true,
  )
})

test('framework and nodeVersion are rejected on non-node kinds', () => {
  const issues = collectServiceTurbopanelValidationIssues({
    api: {
      image: 'node:24',
      'x-turbopanel': { framework: 'next', nodeVersion: '24' },
    },
  })
  assertEquals(
    issues.some((issue) =>
      issue.path === 'services.api.x-turbopanel.framework'
    ),
    true,
  )
  assertEquals(
    issues.some((issue) =>
      issue.path === 'services.api.x-turbopanel.nodeVersion'
    ),
    true,
  )
})

test('an unknown framework or an unpinned nodeVersion is reported', () => {
  const issues = collectServiceTurbopanelValidationIssues({
    web: {
      'x-turbopanel': {
        serviceKind: 'node',
        framework: 'deno',
        nodeVersion: '^24',
        source: { sourceId: NODE_SOURCE_ID },
      },
    },
  })
  assertEquals(
    issues.some((issue) =>
      issue.path === 'services.web.x-turbopanel.framework'
    ),
    true,
  )
  assertEquals(
    issues.some((issue) =>
      issue.path === 'services.web.x-turbopanel.nodeVersion'
    ),
    true,
  )
})

test('the linter does not require image or build on a node service', () => {
  const issues = lintComposeYaml(
    [
      'services:',
      '  web:',
      '    x-turbopanel:',
      '      serviceKind: node',
      '      source:',
      `        sourceId: ${NODE_SOURCE_ID}`,
    ].join('\n'),
  )
  assertEquals(
    issues.some((issue) =>
      issue.message.includes('must define "image" or "build"')
    ),
    false,
  )
})

const RAILPACK_SOURCE_ID = "11111111-2222-3333-4444-555555555555"

test("parseServiceSourceExtension keeps a railpack buildKind", () => {
  const parsed = parseServiceTurbopanelExtension({
    serviceKind: "container",
    source: { sourceId: RAILPACK_SOURCE_ID, buildKind: "railpack" },
  })
  assertEquals(parsed?.source?.buildKind, "railpack")
})

test("an unknown buildKind is dropped and reported", () => {
  const parsed = parseServiceTurbopanelExtension({
    source: { sourceId: RAILPACK_SOURCE_ID, buildKind: "nixpacks" },
  })
  assertEquals(parsed?.source?.buildKind, undefined)

  const issues = collectServiceTurbopanelValidationIssues({
    api: {
      image: "nginx",
      "x-turbopanel": {
        source: { sourceId: RAILPACK_SOURCE_ID, buildKind: "nixpacks" },
      },
    },
  })
  assertEquals(
    issues.map((issue) => issue.path),
    ["services.api.x-turbopanel.source.buildKind"],
  )
})

test("railpack is rejected on a host-native service kind", () => {
  const issues = collectServiceTurbopanelValidationIssues({
    site: {
      "x-turbopanel": {
        serviceKind: "node",
        source: { sourceId: RAILPACK_SOURCE_ID, buildKind: "railpack" },
      },
    },
  })
  assertEquals(
    issues.map((issue) => issue.path),
    ["services.site.x-turbopanel.source.buildKind"],
  )
})

test("railpack is accepted on a container service with no image", () => {
  const issues = collectServiceTurbopanelValidationIssues({
    api: {
      "x-turbopanel": {
        serviceKind: "container",
        source: { sourceId: RAILPACK_SOURCE_ID, buildKind: "railpack" },
      },
    },
  })
  assertEquals(issues, [])
})

test("a railpack container service needs neither image nor build", () => {
  const source = `services:
  api:
    x-turbopanel:
      serviceKind: container
      source:
        sourceId: ${RAILPACK_SOURCE_ID}
        buildKind: railpack
`
  const issues = lintComposeYaml(source).filter((issue) =>
    issue.message.includes('must define "image"')
  )
  assertEquals(issues, [])
})
