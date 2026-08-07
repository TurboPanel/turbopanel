import { assertEquals } from '@std/assert'
import {
  collectServiceTurbopanelValidationIssues,
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
