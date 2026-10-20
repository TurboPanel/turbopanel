import { assertEquals } from '@std/assert'
import { isComposeChainError, resolveComposeLayerChain } from '../compose/layer-chain.ts'
import { mergeComposeLayers } from '../compose/layers.ts'
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
  const { options, notCopied } = copyOfPrimaryOptions({ compose: document({ web: WEB }) }, null)
  const web = servicesOf(options).web
  assertEquals(web.image, 'nginx:1')
  assertEquals(web.container_name, undefined)
  // Container-internal ports stay; published ones move to expose.
  assertEquals(web.ports, ['3000', { target: 22 }])
  assertEquals(web.expose, ['80', '90/tcp', '443'])
  assertEquals((web['x-turbopanel'] as Loose).hosting, undefined)
  assertEquals((web['x-turbopanel'] as Loose).source, { sourceId: SOURCE_ID, deployOnPush: false })
  assertEquals(notCopied.length, 7)
  assertEquals(
    notCopied.some((line) => line.startsWith('Domains')),
    true
  )
})

test('the source is kept but a push never deploys the copy', () => {
  const { options } = copyOfPrimaryOptions({ compose: document({ web: WEB }) }, null)
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
  const { options } = copyOfPrimaryOptions(primary, null)
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
  const none = copyOfPrimaryOptions(null, null)
  assertEquals(none.options, null)
  assertEquals(none.notCopied.length, 2)
  assertEquals(
    copyOfPrimaryOptions({ compose: document({ db: { image: 'pg' } }) }, null).notCopied.length,
    2
  )
})

test('what the Base still gives the copy is overridden in the copy, using the merge rules', () => {
  const base = {
    compose: document({
      web: {
        ...WEB,
        ports: ['8080:80', '53:53/udp', '3000'],
      },
    }),
  }
  const { options, notCopied } = copyOfPrimaryOptions(null, base)
  const layers = resolveComposeLayerChain({
    projectOptions: base,
    environmentOptions: options,
    environmentFilename: 'e.yml',
  })
  if (isComposeChainError(layers)) throw new TypeError('chain')
  const web = (mergeComposeLayers(layers).data.services as Record<string, Loose>).web!
  assertEquals(web.container_name, undefined)
  assertEquals(web.ports, ['3000'])
  // The container ports stay declared once nothing is published.
  assertEquals(web.expose, ['80', '53/udp'])
  const extension = web['x-turbopanel'] as Loose
  assertEquals(extension.hosting, undefined)
  assertEquals(extension.source, { sourceId: SOURCE_ID, branch: 'main', deployOnPush: false })
  assertEquals(
    ['Domains', 'Published', 'Fixed', 'Push deploys'].every((start) =>
      notCopied.some((line) => line.startsWith(start))
    ),
    true
  )
  // A push to the Base's own branch does not deploy the copy.
  const bindings = environmentBranchBindings({
    projectOptions: base,
    environmentOptions: options,
    sourceId: SOURCE_ID,
    repositoryDefaultBranch: 'main',
  })
  assertEquals(decideEnvironmentPush(bindings, 'main'), 'push_deploys_off')
})

test('a Base with nothing unique adds no overrides, and a udp port keeps its protocol', () => {
  assertEquals(
    copyOfPrimaryOptions(null, { compose: document({ db: { image: 'pg' } }) }).options,
    null
  )
  const { options } = copyOfPrimaryOptions(
    {
      compose: document({
        dns: { image: 'd', ports: ['53:53/udp', { target: 67, published: 67, protocol: 'udp' }] },
      }),
    },
    null
  )
  assertEquals(servicesOf(options).dns!.expose, ['53/udp', '67/udp'])
})

test('an expose list that is tagged keeps the dropped container ports', () => {
  const { options } = copyOfPrimaryOptions(
    {
      compose: document({
        web: { image: 'n', ports: ['8080:80'], expose: makeComposeTag('override', ['1']) },
      }),
    },
    null
  )
  assertEquals(servicesOf(options).web!.expose, makeComposeTag('override', ['1', '80']))
})
