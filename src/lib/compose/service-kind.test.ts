import { assertEquals } from '@std/assert'
import {
  collectServiceTurbopanelValidationIssues,
  isNodeComposeService,
  isSiteComposeService,
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

test('parseServiceTurbopanelExtension accepts site with engine', () => {
  assertEquals(
    parseServiceTurbopanelExtension({
      serviceKind: 'site',
      engine: 'nginx',
    }),
    { serviceKind: 'site', engine: 'nginx' },
  )
})

test('parseServiceTurbopanelExtension accepts site root', () => {
  assertEquals(
    parseServiceTurbopanelExtension({
      serviceKind: 'site',
      engine: 'nginx',
      root: 'www',
    }),
    { serviceKind: 'site', engine: 'nginx', root: 'www' },
  )
})

test('collectServiceTurbopanelValidationIssues rejects unsafe root', () => {
  const issues = collectServiceTurbopanelValidationIssues({
    site: {
      'x-turbopanel': {
        serviceKind: 'site',
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

test('collectServiceTurbopanelValidationIssues allows a site with no engine', () => {
  // `engine` is optional and defaults to caddy, resolved at the control-plane
  // split. A minimum static site is therefore four lines of compose.
  const issues = collectServiceTurbopanelValidationIssues({
    site: {
      'x-turbopanel': { serviceKind: 'site' },
    },
  })
  assertEquals(issues, [])
})

test('collectServiceTurbopanelValidationIssues accepts caddy as an engine', () => {
  const issues = collectServiceTurbopanelValidationIssues({
    site: {
      'x-turbopanel': { serviceKind: 'site', engine: 'caddy' },
    },
  })
  assertEquals(issues, [])
})

test('collectServiceTurbopanelValidationIssues rejects engine without site', () => {
  const issues = collectServiceTurbopanelValidationIssues({
    site: {
      'x-turbopanel': { engine: 'apache' },
    },
  })
  assertEquals(issues.length, 1)
  assertEquals(issues[0]?.message.includes('site'), true)
})

test('validateComposeDocument accepts site without image or build', () => {
  const result = validateComposeDocument({
    version: 1,
    data: {
      services: {
        site: {
          'x-turbopanel': {
            serviceKind: 'site',
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
      isSiteComposeService(
        (result.document.data.services as Record<string, Record<string, unknown>>).site,
      ),
      true,
    )
  }
})

test('lintComposeYaml allows site service without image', () => {
  const source = `services:
  site:
    x-turbopanel:
      serviceKind: site
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

test('collectServiceTurbopanelValidationIssues rejects root without site', () => {
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
          'x-turbopanel': { serviceKind: 'site', engine: 'bad-engine' },
        },
      },
    },
    presentation: { keyOrder: ['services'], comments: {} },
  })
  assertEquals(result.ok, false)
})

test('isSiteComposeService is false for invalid extension mapping', () => {
  assertEquals(
    isSiteComposeService({ 'x-turbopanel': 'bad' }),
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

test('collectServiceTurbopanelValidationIssues accepts safe site roots', () => {
  const issues = collectServiceTurbopanelValidationIssues({
    site: {
      'x-turbopanel': {
        serviceKind: 'site',
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
        serviceKind: 'site',
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
        serviceKind: 'site',
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
      'x-turbopanel': { serviceKind: 'site' },
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

test('sourceKind is rejected on a service that is not a site', () => {
  const issues = collectServiceTurbopanelValidationIssues({
    api: {
      image: 'nginx',
      'x-turbopanel': { serviceKind: 'container', sourceKind: 'managed-directory' },
    },
  })
  assertEquals(
    issues.some((issue) =>
      issue.message.includes('sourceKind is only valid when serviceKind is site')
    ),
    true,
  )
})

test('a site cannot both track a repository and serve an uploaded directory', () => {
  // The daemon takes the release branch, so the flag would be a lie. Rejected
  // at save rather than ignored at deploy: an operator who sets both has a
  // belief about where their content comes from, and one of the two is wrong.
  const issues = collectServiceTurbopanelValidationIssues({
    blog: {
      'x-turbopanel': {
        serviceKind: 'site',
        root: 'public',
        sourceKind: 'managed-directory',
        source: { sourceId: '11111111-2222-4333-8444-555555555555' },
      },
    },
  })
  assertEquals(
    issues.some((issue) =>
      issue.message.includes('remove the source to serve an uploaded directory')
    ),
    true,
  )
})

test('an uploaded-directory site with no repository validates clean', () => {
  // The Hosting card seeds exactly this; a card that seeds a document the
  // validator rejects is a card that cannot be used.
  assertEquals(
    collectServiceTurbopanelValidationIssues({
      blog: {
        'x-turbopanel': {
          serviceKind: 'site',
          engine: 'caddy',
          root: 'public',
          sourceKind: 'managed-directory',
        },
      },
    }),
    [],
  )
})

test('cron is rejected on a container service', () => {
  // A container has no principal to run as and no tree to run in.
  const issues = collectServiceTurbopanelValidationIssues({
    api: {
      image: 'nginx',
      'x-turbopanel': {
        serviceKind: 'container',
        cron: [{ name: 'sweep', schedule: '@daily', command: '/bin/true' }],
      },
    },
  })
  assertEquals(
    issues.some((issue) =>
      issue.message.includes('cron is only valid when serviceKind is site or node')
    ),
    true,
  )
})

test('a cron job on a site validates clean', () => {
  assertEquals(
    collectServiceTurbopanelValidationIssues({
      blog: {
        'x-turbopanel': {
          serviceKind: 'site',
          root: 'public',
          cron: [
            { name: 'wp-cron', schedule: '*/5 * * * *', command: 'php wp-cron.php' },
          ],
        },
      },
    }),
    [],
  )
})

test('the day-of-week trap surfaces as a save-time issue', () => {
  // Not a deploy-time surprise: cron unions the two day fields and systemd
  // intersects them, so this expression means two different things.
  const issues = collectServiceTurbopanelValidationIssues({
    blog: {
      'x-turbopanel': {
        serviceKind: 'site',
        root: 'public',
        cron: [{ name: 'billing', schedule: '0 0 13 * 5', command: '/bin/true' }],
      },
    },
  })
  assertEquals(
    issues.some((issue) =>
      issue.path === 'services.blog.x-turbopanel.cron[0].schedule' &&
      issue.message.includes('both to match')
    ),
    true,
  )
})

test('shell syntax in a cron command is a save-time issue', () => {
  const issues = collectServiceTurbopanelValidationIssues({
    blog: {
      'x-turbopanel': {
        serviceKind: 'site',
        root: 'public',
        cron: [
          { name: 'sweep', schedule: '@daily', command: 'php x.php >> /tmp/l' },
        ],
      },
    },
  })
  assertEquals(
    issues.some((issue) =>
      issue.path === 'services.blog.x-turbopanel.cron[0].command' &&
      issue.message.includes('no shell')
    ),
    true,
  )
})

test('a cron job name must be usable as a unit filename, and unique', () => {
  const issues = collectServiceTurbopanelValidationIssues({
    blog: {
      'x-turbopanel': {
        serviceKind: 'site',
        root: 'public',
        cron: [
          { name: 'Sweep Me', schedule: '@daily', command: '/bin/true' },
          { name: 'ok', schedule: '@daily', command: '/bin/true' },
          { name: 'ok', schedule: '@hourly', command: '/bin/true' },
        ],
      },
    },
  })
  assertEquals(
    issues.some((issue) => issue.message.includes("becomes the timer's name")),
    true,
  )
  // Two jobs with one name would render one unit and silently lose a job.
  assertEquals(
    issues.some((issue) => issue.message.includes('duplicate job name "ok"')),
    true,
  )
})
