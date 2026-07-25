import { assertEquals } from '@std/assert'
import {
  collectServiceTurbopanelValidationIssues,
  isTraditionalWebComposeService,
  parseServiceTurbopanelExtension,
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
