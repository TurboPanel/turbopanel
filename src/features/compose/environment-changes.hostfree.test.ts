/**
 * "Changes for {env}": an environment's compose may be a partial layer over the
 * project's Base. These cases pin what that allows (a field changed on a
 * service the Base defines) and, as importantly, what it never allows (a
 * service with nothing to run, and every host-reaching or banned setting).
 */

import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import {
  isComposeChainError,
  resolveComposeLayerChain,
  validateEnvironmentComposeAgainstBase,
} from './layer-chain.ts'
import { mergeComposeLayers } from './layers.ts'
import { makeComposeTag } from './tags.ts'
import { type ComposeDocument, emptyComposeDocument } from './types.ts'
import { validateComposeDocument } from './validate.ts'
import { validateComposeForDeploy } from './validate-for-deploy.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const doc = (data: Record<string, unknown>): ComposeDocument => ({
  ...emptyComposeDocument(),
  data,
})

const BASE = { compose: doc({ services: { web: { image: 'nginx:alpine' } } }) }

function changes(services: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { compose: doc({ services }), ...extra }
}

function mergedDeployVerdict(projectOptions: unknown, environmentOptions: unknown) {
  const chain = resolveComposeLayerChain({
    projectOptions,
    environmentOptions,
    environmentFilename: 'docker-compose.production.yml',
  })
  if (isComposeChainError(chain)) return 'chain_refused' as const
  return validateComposeForDeploy(mergeComposeLayers(chain))
}

function saveIssues(projectOptions: unknown, environmentOptions: unknown) {
  return validateEnvironmentComposeAgainstBase({
    projectOptions,
    environmentOptions,
  })
}

test('a change to a Base service needs no image of its own, on save or at deploy', () => {
  const env = changes({ web: { command: ['npm', 'start'] } })
  assertEquals(saveIssues(BASE, env), [])
  assertEquals(mergedDeployVerdict(BASE, env), null)
})

test('a service the Base does not define still needs its own image or build', () => {
  const env = changes({ worker: { command: ['node', 'worker.js'] } })

  const issues = saveIssues(BASE, env)
  assertEquals(issues.length, 1)
  assertStringIncludes(issues[0]!.message, 'Service "worker" must define "image" or "build"')
  assertStringIncludes(issues[0]!.message, "project's Base")
  assertEquals(issues[0]!.line, undefined)
  assert(!issues[0]!.message.startsWith('Line '))

  const verdict = mergedDeployVerdict(BASE, env)
  assert(verdict !== null && verdict !== 'chain_refused')
  assertEquals(verdict.kind, 'compose_merged_invalid')
  assertStringIncludes(verdict.issues[0]!.message, 'Service "worker"')
})

test('a new service that brings an image or a build is fine', () => {
  const withImage = changes({
    worker: { image: 'node:22', command: ['node', 'w.js'] },
  })
  assertEquals(saveIssues(BASE, withImage), [])
  assertEquals(mergedDeployVerdict(BASE, withImage), null)

  const withBuild = changes({ worker: { build: { context: '.' } } })
  assertEquals(saveIssues(BASE, withBuild), [])
  assertEquals(mergedDeployVerdict(BASE, withBuild), null)
})

test('an extra environment layer can supply the image the changes leave out', () => {
  const env = {
    ...changes({ worker: { command: ['node', 'w.js'] } }),
    composeOverlays: [
      {
        id: 'extra',
        name: 'extra',
        filename: 'docker-compose.extra.yml',
        document: doc({ services: { worker: { image: 'node:22' } } }),
      },
    ],
  }
  assertEquals(saveIssues(BASE, env), [])
  assertEquals(mergedDeployVerdict(BASE, env), null)
})

test('the Base layers count too, including an extra project layer', () => {
  const project = {
    ...BASE,
    composeOverlays: [
      {
        id: 'p1',
        name: 'p1',
        filename: 'docker-compose.p1.yml',
        document: doc({ services: { worker: { image: 'node:22' } } }),
      },
    ],
  }
  const env = changes({ worker: { command: ['node', 'w.js'] } })
  assertEquals(saveIssues(project, env), [])
  assertEquals(mergedDeployVerdict(project, env), null)
})

test('resetting the Base image leaves nothing to run and is refused', () => {
  const env = changes({ web: { image: makeComposeTag('reset', null) } })
  const issues = saveIssues(BASE, env)
  assertEquals(issues.length, 1)
  assertStringIncludes(issues[0]!.message, 'Service "web"')
  assertEquals(mergedDeployVerdict(BASE, env) === null, false)
})

test('the project Base itself must still stand on its own', () => {
  const brokenBase = {
    compose: doc({ services: { web: { command: ['x'] } } }),
  }
  const chain = resolveComposeLayerChain({
    projectOptions: brokenBase,
    environmentOptions: changes({ web: { image: 'nginx' } }),
    environmentFilename: 'docker-compose.production.yml',
  })
  assertEquals(isComposeChainError(chain), true)
  // On save, the environment is told the Base cannot be read, not silently accepted.
  const issues = saveIssues(brokenBase, changes({ web: { image: 'nginx' } }))
  assertEquals(issues.length, 1)
  assertStringIncludes(issues[0]!.message, "project's Base")
})

test('a privileged flag added through the changes is still refused at deploy', () => {
  const env = changes({ web: { privileged: true } })
  const verdict = mergedDeployVerdict(BASE, env)
  assert(verdict !== null && verdict !== 'chain_refused')
  assertEquals(verdict.kind, 'compose_field_requires_org_opt_in')
  assertEquals(
    verdict.issues.some((issue) => issue.path === 'services.web.privileged'),
    true
  )
})

test('a host path added through the changes is still refused at deploy', () => {
  for (const volumes of [['/etc:/host-etc'], ['/var/run/docker.sock:/var/run/docker.sock']]) {
    const verdict = mergedDeployVerdict(BASE, changes({ web: { volumes } }))
    assert(verdict !== null && verdict !== 'chain_refused', volumes[0])
    assertEquals(verdict.kind, 'compose_field_requires_org_opt_in', volumes[0])
  }
})

test('a host-reaching setting added through the changes passes only with the org opt-in', () => {
  const chain = resolveComposeLayerChain({
    projectOptions: BASE,
    environmentOptions: changes({ web: { privileged: true } }),
    environmentFilename: 'docker-compose.production.yml',
  })
  if (isComposeChainError(chain)) throw new Error('chain should read')
  const merged = mergeComposeLayers(chain)
  assertEquals(validateComposeForDeploy(merged, { composeGatedFieldsEnabled: true }), null)
  assertEquals(validateComposeForDeploy(merged)?.kind, 'compose_field_requires_org_opt_in')
})

test('a build option no deploy may carry is refused in the changes', () => {
  const env = changes({ web: { build: { context: '.', network: 'host' } } })
  // Build refusals are deploy-time (strict) rules: the layer reads fine ...
  const chain = resolveComposeLayerChain({
    projectOptions: BASE,
    environmentOptions: env,
    environmentFilename: 'docker-compose.production.yml',
  })
  assertEquals(isComposeChainError(chain), false)
  // ... and the merge is refused outright at deploy, with no org opt-in.
  const verdict = mergedDeployVerdict(BASE, env)
  assert(verdict !== null && verdict !== 'chain_refused')
  assertEquals(verdict.kind, 'compose_build_refused')
})

test('a banned key in the changes is refused as before', () => {
  const placement = {
    compose: doc({
      services: { web: { command: ['x'] } },
      'x-turbopanel': { placement: { serverId: 'abc' } },
    }),
  }
  assertEquals(
    isComposeChainError(
      resolveComposeLayerChain({
        projectOptions: BASE,
        environmentOptions: placement,
        environmentFilename: 'docker-compose.production.yml',
      })
    ),
    true
  )
  assertEquals(saveIssues(BASE, placement).length > 0, true)

  const unknownKey = changes({ web: { not_a_compose_key: true } })
  assertEquals(
    isComposeChainError(
      resolveComposeLayerChain({
        projectOptions: BASE,
        environmentOptions: unknownKey,
        environmentFilename: 'docker-compose.production.yml',
      })
    ),
    true
  )
})

test('a secret file outside the service directory is refused at deploy', () => {
  const env = {
    compose: doc({
      services: { web: { secrets: ['shadow'] } },
      secrets: { shadow: { file: '/etc/shadow' } },
    }),
  }
  const verdict = mergedDeployVerdict(BASE, env)
  assert(verdict !== null && verdict !== 'chain_refused')
  assertEquals(verdict.kind, 'compose_field_requires_org_opt_in')
})

const REPO_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

const NODE_BASE = {
  compose: doc({
    services: {
      app: {
        'x-turbopanel': {
          serviceKind: 'node',
          source: { sourceId: REPO_ID, branch: 'main' },
        },
      },
    },
  }),
}

const SITE_BASE = {
  compose: doc({
    services: {
      www: {
        'x-turbopanel': { serviceKind: 'site', source: { sourceId: REPO_ID } },
      },
    },
  }),
}

const ext = (extension: Record<string, unknown>) => changes({ app: { 'x-turbopanel': extension } })

test('a node app setting changes without restating its kind or repository', () => {
  for (const extension of [
    { nodeVersion: '24' },
    { framework: 'next' },
    { source: { branch: 'staging' } },
    { serviceKind: 'node', nodeVersion: '22' },
  ]) {
    const env = ext(extension)
    assertEquals(saveIssues(NODE_BASE, env), [], JSON.stringify(extension))
    assertEquals(mergedDeployVerdict(NODE_BASE, env), null, JSON.stringify(extension))
  }
})

test('a site setting changes without restating its kind', () => {
  const env = changes({
    www: { 'x-turbopanel': { root: 'dist', engine: 'nginx' } },
  })
  assertEquals(saveIssues(SITE_BASE, env), [])
  assertEquals(mergedDeployVerdict(SITE_BASE, env), null)
})

test('the kind rules still apply to the merge: a Base that is not a node app', () => {
  const containerBase = {
    compose: doc({ services: { app: { image: 'nginx:alpine' } } }),
  }
  const env = ext({ framework: 'next' })
  const issues = saveIssues(containerBase, env)
  assertEquals(issues.length, 1)
  assertEquals(issues[0]!.message, 'framework is only valid when serviceKind is node')

  const restated = saveIssues(containerBase, ext({ serviceKind: 'node' }))
  assert(restated.some((i) => i.message === 'node services require source'))
})

test('an app new to the environment must still name its own kind fields and repository', () => {
  const env = changes({
    worker: { 'x-turbopanel': { serviceKind: 'node', nodeVersion: '24' } },
  })
  const issues = saveIssues(BASE, env)
  assert(issues.some((i) => i.message === 'node services require source'))

  const noRepo = changes({
    worker: {
      'x-turbopanel': { serviceKind: 'node', source: { branch: 'main' } },
    },
  })
  assert(
    saveIssues(BASE, noRepo).some((i) =>
      i.message.startsWith('source.sourceId must be the UUID of a source')
    )
  )
})

/** The layer on its own, the way a save validates it before the merge is built. */
function layerIssues(extension: Record<string, unknown>, rest: Record<string, unknown> = {}) {
  const result = validateComposeDocument(ext2({ ...rest, 'x-turbopanel': extension }), {
    layer: 'overlay',
    requireImageOrBuild: false,
  })
  return result.ok ? [] : result.issues
}

const ext2 = (service: Record<string, unknown>) => doc({ services: { app: service } })

test('what a partial layer does state is still checked as given', () => {
  assertEquals(layerIssues({ nodeVersion: '24' }), [])
  assertEquals(layerIssues({ source: { branch: 'staging' } }), [])

  const badId = layerIssues({ source: { sourceId: 'not-a-uuid' } })
  assertEquals(badId.length, 1)
  assertStringIncludes(badId[0]!.message, 'source.sourceId must be the UUID of a source')

  const image = layerIssues({ serviceKind: 'node' }, { image: 'nginx' })
  assertEquals(image.length, 1)
  assertStringIncludes(image[0]!.message, 'image is not valid on a node service')

  const wrongKind = layerIssues({
    serviceKind: 'container',
    framework: 'next',
  })
  assertEquals(wrongKind.length, 1)
  assertStringIncludes(wrongKind[0]!.message, 'framework is only valid when serviceKind is node')
})

test('a document that is not a partial layer is held to the full rules', () => {
  const strict = validateComposeDocument(ext2({ 'x-turbopanel': { nodeVersion: '24' } }), {
    requireImageOrBuild: true,
  })
  assert(!strict.ok)
  assertStringIncludes(strict.issues[0]!.message, 'nodeVersion is only valid')
})
