import { assertEquals } from '@std/assert'
import { makeComposeTag } from '../compose/tags.ts'
import {
  decideEnvironmentPush,
  environmentBranchBindings,
} from '../git/environment-branch-tracking.ts'
import { copyOfPrimaryOptions } from './primary-environment-copy.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SOURCE_ID = '11111111-1111-4111-8111-111111111111'

function document(services: Record<string, unknown>) {
  return { version: 1, data: { services }, presentation: { keyOrder: ['services'], comments: {} } }
}

type Loose = Record<string, unknown>

function servicesOf(options: Loose | null): Record<string, Loose> {
  return (options as { compose: { data: { services: Record<string, Loose> } } }).compose.data
    .services
}

const WEB = {
  image: 'nginx:1',
  container_name: 'prod-web',
  ports: [
    '8080:80',
    '127.0.0.1:9090:90/tcp',
    '3000',
    { target: 443, published: 8443 },
    { target: 22 },
  ],
  expose: ['80'],
  'x-turbopanel': {
    hosting: [{ hostname: 'app.example.com' }],
    source: { sourceId: SOURCE_ID, branch: 'main', deployOnPush: true },
  },
}

test('a copy drops domains, published ports, container names and the branch, and keeps the rest', () => {
  const { options, notCopied } = copyOfPrimaryOptions({ compose: document({ web: WEB }) })
  const web = servicesOf(options).web
  assertEquals(web.image, 'nginx:1')
  assertEquals(web.container_name, undefined)
  // Container-internal ports stay; published ones move to expose.
  assertEquals(web.ports, ['3000', { target: 22 }])
  assertEquals(web.expose, ['80', '90', '443'])
  assertEquals((web['x-turbopanel'] as Loose).hosting, undefined)
  assertEquals((web['x-turbopanel'] as Loose).source, { sourceId: SOURCE_ID, deployOnPush: false })
  assertEquals(notCopied.length, 6)
  assertEquals(
    notCopied.some((line) => line.startsWith('Domains')),
    true
  )
})

test('the source is kept but a push never deploys the copy', () => {
  const { options } = copyOfPrimaryOptions({ compose: document({ web: WEB }) })
  const bindings = environmentBranchBindings({
    projectOptions: { compose: document({}) },
    environmentOptions: options,
    sourceId: SOURCE_ID,
    repositoryDefaultBranch: 'main',
  })
  assertEquals(bindings.length, 1)
  assertEquals(decideEnvironmentPush(bindings, 'main'), 'push_deploys_off')
})

test('tags and extra layers are copied and cleaned too, and the original is untouched', () => {
  const primary = {
    compose: document({
      web: makeComposeTag('override', { image: 'a', ports: makeComposeTag('override', ['80:80']) }),
    }),
    composeOverlays: [
      {
        id: 'o1',
        name: 'o1',
        filename: 'o1.yml',
        document: document({ web: { container_name: 'x' } }),
      },
    ],
  }
  const before = structuredClone(primary)
  const { options } = copyOfPrimaryOptions(primary)
  assertEquals(primary, before)
  assertEquals(
    servicesOf(options).web,
    makeComposeTag('override', {
      image: 'a',
      ports: makeComposeTag('override', []),
      expose: ['80'],
    })
  )
  const overlay = (
    options as {
      composeOverlays: { id: string; document: { data: { services: Record<string, unknown> } } }[]
    }
  ).composeOverlays[0]!
  assertEquals(overlay.id, 'o1')
  assertEquals(overlay.document.data.services.web, {})
})

test('a primary with no changes of its own copies to nothing, and only the fixed notes remain', () => {
  const none = copyOfPrimaryOptions(null)
  assertEquals(none.options, null)
  assertEquals(none.notCopied.length, 2)
  assertEquals(
    copyOfPrimaryOptions({ compose: document({ db: { image: 'pg' } }) }).notCopied.length,
    2
  )
})
