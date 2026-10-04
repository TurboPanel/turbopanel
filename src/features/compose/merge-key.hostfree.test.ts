import { assertEquals } from '@std/assert'
import { yamlToComposeDocument, composeDocumentToYaml } from './convert.ts'
import { blockingComposeLintIssues, lintComposeYaml } from './lint.ts'
import { validateComposeForDeploy } from './validate-for-deploy.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const MERGE_KEY = `x-b: &b
  privileged: true
  pid: host
services:
  web:
    image: alpine
    <<: *b
`

test('a merge key cannot hide a gated field from the deploy gate', () => {
  const doc = yamlToComposeDocument(MERGE_KEY)
  const service = (doc.data.services as Record<string, Record<string, unknown>>).web
  assertEquals(service.privileged, true)
  assertEquals('<<' in service, false)
  const refused = validateComposeForDeploy(doc, { composeGatedFieldsEnabled: false })
  assertEquals(refused?.kind, 'compose_field_requires_org_opt_in')
  assertEquals(validateComposeForDeploy(doc, { composeGatedFieldsEnabled: true }), null)
})

test('the runtime document written back carries no merge key', () => {
  const yaml = composeDocumentToYaml(yamlToComposeDocument(MERGE_KEY))
  assertEquals(yaml.includes('<<'), false)
  assertEquals(yaml.includes('privileged: true'), true)
})

test('lint reads a gated field that arrives through an inline merge', () => {
  const issues = lintComposeYaml(
    'services:\n  web:\n    image: alpine\n    <<: {cap_add: [SYS_ADMIN]}\n'
  )
  assertEquals(
    issues.some((i) => i.code === 'field_requires_org_opt_in' && i.path === 'services.web.cap_add'),
    true
  )
})

test('legitimate anchors and merge keys keep working', () => {
  const source = `x-common: &common
  restart: unless-stopped
  environment:
    A: "1"
services:
  a:
    image: nginx
    <<: *common
  b:
    image: nginx
    <<: *common
`
  const doc = yamlToComposeDocument(source)
  const services = doc.data.services as Record<string, Record<string, unknown>>
  assertEquals(services.a.restart, 'unless-stopped')
  assertEquals(services.b.environment, { A: '1' })
  assertEquals(validateComposeForDeploy(doc, { composeGatedFieldsEnabled: false }), null)
})

test('authored traefik labels are a blocking error, in map, list and merged form', () => {
  for (const labels of [
    '    labels:\n      traefik.http.routers.x.rule: Host(`a.example.com`)\n',
    '    labels:\n      - "Traefik.enable=true"\n',
    '    <<: {labels: {traefik.http.routers.x.priority: "9"}}\n',
  ]) {
    const issues = blockingComposeLintIssues(
      lintComposeYaml(`services:\n  web:\n    image: alpine\n${labels}`)
    )
    assertEquals(
      issues.some((i) => i.path === 'services.web.labels'),
      true,
      labels
    )
  }
  assertEquals(
    blockingComposeLintIssues(
      lintComposeYaml(
        'services:\n  web:\n    image: alpine\n    labels:\n      com.example.team: web\n'
      )
    ),
    []
  )
})

test('an alias bomb is refused instead of expanded', () => {
  let yaml = 'a0: &a0 ["x","x","x","x","x","x","x","x","x"]\n'
  for (let i = 1; i < 12; i++) {
    yaml += `a${i}: &a${i} [${Array(9)
      .fill(`*a${i - 1}`)
      .join(',')}]\n`
  }
  yaml += 'services:\n  web:\n    image: alpine\n'
  let threw = false
  try {
    yamlToComposeDocument(yaml)
  } catch {
    threw = true
  }
  assertEquals(threw, true)
})
