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
