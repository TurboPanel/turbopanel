import { assertEquals } from '@std/assert'
import {
  blockingComposeLintIssues,
  lintComposeYaml,
} from './lint.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('lintComposeYaml returns no issues for empty input', () => {
  assertEquals(lintComposeYaml(''), [])
  assertEquals(lintComposeYaml('   \n'), [])
})

test('lintComposeYaml accepts a valid service', () => {
  const source = `services:
  nginx:
    image: nginx:alpine
    ports:
      - "8080:80"
`
  assertEquals(lintComposeYaml(source), [])
})

test('lintComposeYaml flags misspelled service key with suggestion and line', () => {
  const source = `services:
  # ok
  nginx:
    # comment
    imaage: nginx
`
  const issues = lintComposeYaml(source)
  const unknown = issues.find((issue) => issue.path === 'services.nginx.imaage')
  assertEquals(unknown?.level, 'warning')
  assertEquals(unknown?.message.includes('did you mean "image"'), true)
  assertEquals(unknown?.line, 5)
})

test('lintComposeYaml errors when service has neither image nor build', () => {
  const source = `services:
  nginx:
    imaage: nginx
`
  const issues = lintComposeYaml(source)
  const missing = issues.find(
    (issue) => issue.level === 'error' && issue.path === 'services.nginx',
  )
  assertEquals(missing !== undefined, true)
  assertEquals(missing?.message.includes('image'), true)
})

test('lintComposeYaml skips image requirement for traditional-web services', () => {
  const source = `services:
  site:
    x-turbopanel:
      serviceKind: traditional-web
      engine: apache
`
  assertEquals(lintComposeYaml(source), [])
})

test('lintComposeYaml orders issues by line number', () => {
  const source = `services:
  # ok
  nginx:
    # comment
    imaage: nginx
`
  const issues = lintComposeYaml(source)
  assertEquals(issues.map((issue) => issue.line), [3, 5])
  assertEquals(issues[0]?.level, 'error')
  assertEquals(issues[1]?.level, 'warning')
})

test('blockingComposeLintIssues allows empty-draft warnings', () => {
  const noServices = lintComposeYaml('networks:\n  default: {}\n')
  assertEquals(blockingComposeLintIssues(noServices), [])

  const emptyServices = lintComposeYaml('services: {}\n')
  assertEquals(blockingComposeLintIssues(emptyServices), [])

  const bad = lintComposeYaml(`services:
  nginx:
    imaage: nginx
`)
  assertEquals(blockingComposeLintIssues(bad).length > 0, true)
})

test('lintComposeYaml reports invalid YAML syntax', () => {
  const issues = lintComposeYaml('services: [\n  - broken')
  assertEquals(issues.length > 0, true)
  assertEquals(issues[0]?.level, 'error')
  assertEquals(issues[0]?.path, '$')
})

test('lintComposeYaml rejects non-mapping root', () => {
  const issues = lintComposeYaml('- not-a-map\n')
  assertEquals(issues[0]?.message.includes('root must be a mapping'), true)
})

test('lintComposeYaml warns on unknown top-level keys', () => {
  const issues = lintComposeYaml(`servicess:
  nginx:
    image: nginx
`)
  const unknown = issues.find((issue) => issue.path === 'servicess')
  assertEquals(unknown?.level, 'warning')
  assertEquals(unknown?.message.includes('did you mean "services"'), true)
})

test('lintComposeYaml errors when services is not a mapping', () => {
  const issues = lintComposeYaml('services: []\n')
  assertEquals(
    issues.some((issue) => issue.path === 'services' && issue.level === 'error'),
    true,
  )
})

test('lintComposeYaml errors when a service entry is not a mapping', () => {
  const issues = lintComposeYaml(`services:
  nginx: not-a-map
`)
  const serviceIssue = issues.find((issue) => issue.path === 'services.nginx')
  assertEquals(serviceIssue?.level, 'error')
  assertEquals(serviceIssue?.message.includes('must be a mapping'), true)
})

test('lintComposeYaml accepts build without image', () => {
  const source = `services:
  api:
    build: .
`
  assertEquals(lintComposeYaml(source), [])
})

test('lintComposeYaml treats empty-string image as missing', () => {
  const source = `services:
  app:
    image: ""
`
  const issues = lintComposeYaml(source)
  const missing = issues.find(
    (issue) => issue.level === 'error' && issue.path === 'services.app',
  )
  assertEquals(missing !== undefined, true)
  assertEquals(missing?.message.includes('image'), true)
  assertEquals(missing?.message.includes('build'), true)
})

test('lintComposeYaml accepts build when image is an empty string', () => {
  const source = `services:
  app:
    image: ""
    build:
      context: .
      dockerfile_inline: |
        FROM alpine
`
  assertEquals(lintComposeYaml(source), [])
})

test('lintComposeYaml allows x-turbopanel extension keys on services', () => {
  const source = `services:
  site:
    x-turbopanel:
      serviceKind: traditional-web
      engine: nginx
`
  assertEquals(
    lintComposeYaml(source).some((issue) => issue.path.includes('x-turbopanel')),
    false,
  )
})

test('lintComposeYaml warns when services section is missing', () => {
  const issues = lintComposeYaml('networks:\n  default: {}\n')
  assertEquals(
    issues.some((issue) => issue.message.includes('no "services" section')),
    true,
  )
})

test('lintComposeYaml warns on unknown top-level keys without a close suggestion', () => {
  const issues = lintComposeYaml(`totallyunknown: value
services:
  api:
    image: node:22
`)
  const unknown = issues.find((issue) => issue.path === 'totallyunknown')
  assertEquals(unknown?.level, 'warning')
  assertEquals(unknown?.message.includes('did you mean'), false)
})

test('lintComposeYaml allows top-level x-* extension keys', () => {
  const issues = lintComposeYaml(`x-custom-meta: true
services:
  api:
    image: node:22
`)
  assertEquals(issues.some((issue) => issue.path === 'x-custom-meta'), false)
})

test('lintComposeYaml warns when services mapping is empty', () => {
  const issues = lintComposeYaml(`services: {}
networks:
  default: {}
`)
  assertEquals(
    issues.some((issue) => issue.message === 'No services defined'),
    true,
  )
})

test('lintComposeYaml skips services with non-string keys', () => {
  const issues = lintComposeYaml(`services:
  8080:
    image: nginx
  [bad]: true
`)
  assertEquals(issues.some((issue) => issue.path === 'services.[bad]'), false)
})

test('lintComposeYaml does not report tagged nodes as unknown keys or invalid services', () => {
  const source = `services:
  web:
    image: nginx
    ports: !override
      - "9000:80"
    environment: !reset null
  gone: !reset null
`
  const issues = lintComposeYaml(source)
  assertEquals(
    issues.some((issue) => issue.message.includes('Unknown')),
    false,
  )
  assertEquals(
    issues.some((issue) => issue.message.includes('must be a mapping')),
    false,
  )
})

test('base-layer tag advisory is non-blocking; overlay suppresses it', () => {
  const source = `services:
  web:
    image: nginx
    ports: !override
      - "9000:80"
`
  const baseIssues = lintComposeYaml(source)
  const advisory = baseIssues.find((issue) =>
    issue.message.includes('only take effect in an overlay')
  )
  assertEquals(advisory?.level, 'warning')
  assertEquals(advisory?.blocking, false)
  assertEquals(blockingComposeLintIssues(baseIssues), [])

  const overlayIssues = lintComposeYaml(source, { layer: 'overlay' })
  assertEquals(
    overlayIssues.some((issue) =>
      issue.message.includes('only take effect in an overlay')
    ),
    false,
  )
})

test('lintComposeYaml errors on invalid TurboPanel variable refs', () => {
  const issues = lintComposeYaml(`services:
  web:
    image: nginx
    environment:
      BAD: prefix-{$PORT}
      SCOPE: "{$galaxy.KEY}"
`)
  assertEquals(
    issues.some((issue) => issue.path === 'services.web.environment.BAD'),
    true,
  )
  assertEquals(
    issues.some((issue) => issue.path === 'services.web.environment.SCOPE'),
    true,
  )
})
