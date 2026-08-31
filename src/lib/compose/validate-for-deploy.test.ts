import { assertEquals } from '@std/assert'
import { mergeComposeLayers, type ComposeLayer } from './layers.ts'
import { makeComposeTag } from './tags.ts'
import type { ComposeDocument } from './types.ts'
import { validateComposeForDeploy } from './validate-for-deploy.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function doc(data: Record<string, unknown>): ComposeDocument {
  return {
    version: 1,
    data,
    presentation: { keyOrder: Object.keys(data), comments: {} },
  }
}

/**
 * A project base and an environment overlay, merged the way a deploy merges
 * them.
 *
 * Every case below is two documents that would each save cleanly; the point is
 * what their *sum* is, which is the thing no save boundary ever sees.
 */
function merge(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): ComposeDocument {
  const layers: ComposeLayer[] = [
    { role: 'project', filename: 'docker-compose.yml', document: doc(base) },
    {
      role: 'environment',
      filename: 'docker-compose.env.yml',
      document: doc(overlay),
    },
  ]
  return mergeComposeLayers(layers)
}

test('a clean merge is not refused', () => {
  const merged = merge(
    { services: { web: { image: 'nginx:alpine' } } },
    { services: { web: { environment: { LOG_LEVEL: 'debug' } } } },
  )
  assertEquals(validateComposeForDeploy(merged), null)
})

test('an overlay !reset that removes the base image is refused as a merged failure', () => {
  // Each layer is fine alone: the base declares an image, the overlay only says
  // "not this one". Their sum is a service with nothing to run, which no save
  // boundary was ever in a position to notice.
  const merged = merge(
    { services: { web: { image: 'nginx:alpine' } } },
    { services: { web: { image: makeComposeTag('reset', null) } } },
  )
  const error = validateComposeForDeploy(merged)
  assertEquals(error?.kind, 'compose_merged_invalid')
  assertEquals(
    error?.issues.some((issue) => issue.path === 'services.web'),
    true,
  )
})

test('an overlay !reset on the root principals map orphans the base alias', () => {
  const base = {
    'x-turbopanel': { principals: { app: { access: 'none' } } },
    services: {
      web: { 'x-turbopanel': { serviceKind: 'site', principal: 'app' } },
    },
  }
  // The base on its own is a document that saves and deploys.
  assertEquals(validateComposeForDeploy(doc(base)), null)

  const merged = merge(base, {
    'x-turbopanel': { principals: makeComposeTag('reset', null) },
  })
  const error = validateComposeForDeploy(merged)
  assertEquals(error?.kind, 'compose_merged_invalid')
  // The site would otherwise have been deployed as nobody.
  assertEquals(
    error?.issues.some((issue) =>
      issue.path === 'services.web.x-turbopanel.principal'
    ),
    true,
  )
})

test('a merge that drops a schema-required key is refused by the upstream schema stage', () => {
  const base = {
    services: {
      web: { image: 'nginx:alpine', extends: { service: 'other', file: 'o.yml' } },
    },
  }
  assertEquals(validateComposeForDeploy(doc(base)), null)

  // `extends` is a `oneOf` union whose object branch requires `service`. Resetting
  // that one key leaves a shape the Compose Specification does not allow — and
  // the only document that ever holds it is the merge.
  const merged = merge(base, {
    services: { web: { extends: { service: makeComposeTag('reset', null) } } },
  })
  const error = validateComposeForDeploy(merged)
  assertEquals(error?.kind, 'compose_merged_invalid')
  assertEquals(
    error?.issues.some((issue) =>
      issue.path === 'services.web.extends' &&
      issue.message.includes('required key "service"')
    ),
    true,
  )
})

test('a merged document naming an unsupported field is refused as policy, not as invalid', () => {
  const merged = merge(
    { services: { web: { image: 'nginx:alpine' } } },
    { services: { web: { deploy: { endpoint_mode: 'dnsrr' } } } },
  )
  const error = validateComposeForDeploy(merged)
  assertEquals(error?.kind, 'compose_field_unsupported')
  assertEquals(
    error?.issues.map((issue) => issue.path),
    ['services.web.deploy.endpoint_mode'],
  )
})

test('structure is answered before policy', () => {
  // Both faults are present. The one that says "this is not a document we can
  // run" has to win, because the policy verdict on a document that is not a
  // valid Compose file answers the wrong question.
  const merged = merge(
    { services: { web: { image: 'nginx:alpine' } } },
    {
      services: {
        web: {
          image: makeComposeTag('reset', null),
          deploy: { endpoint_mode: 'dnsrr' },
        },
      },
    },
  )
  assertEquals(validateComposeForDeploy(merged)?.kind, 'compose_merged_invalid')
})

test('a merged deploy.mode job value is refused as an unsupported field', () => {
  // Each layer saves: the base is an ordinary service, the overlay only sets a
  // mode. Their sum asks for finite work from a scheduler that only runs
  // long-lived replicas, and the deploy is where that stops being advice.
  const merged = merge(
    { services: { worker: { image: 'nginx:alpine' } } },
    { services: { worker: { deploy: { mode: 'replicated-job' } } } },
  )
  const error = validateComposeForDeploy(merged)
  assertEquals(error?.kind, 'compose_field_unsupported')
  assertEquals(
    error?.issues.map((issue) => issue.path),
    ['services.worker.deploy.mode'],
  )
})

test('deploy.mode: global still deploys', () => {
  const merged = merge(
    { services: { worker: { image: 'nginx:alpine' } } },
    { services: { worker: { deploy: { mode: 'global' } } } },
  )
  assertEquals(validateComposeForDeploy(merged), null)
})
