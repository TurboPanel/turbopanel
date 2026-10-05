/**
 * The compose an environment is saved with ("Changes for {env}"): checked as a
 * partial layer, then as the merge with the project's Base.
 */

import { assertEquals, assertStringIncludes } from '@std/assert'
import { emptyComposeDocument } from '../../features/compose/index.ts'
import { mergeProjectEnvironmentCompose } from './deploy-prepare.ts'
import { parseCreateEnvironmentJsonb, parseEnvironmentPatchOptions } from './routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function compose(services: Record<string, unknown>) {
  const doc = emptyComposeDocument()
  doc.data.services = services
  return doc
}

const PROJECT = { compose: compose({ web: { image: 'nginx:alpine' } }) }
const OVERLAY = { layer: 'overlay' } as const

type Failure = { ok: false; error: string; issues: Array<{ message: string }> }

function refusal(result: { ok: boolean }): Failure {
  if (result.ok) throw new TypeError('expected compose_invalid')
  return result as unknown as Failure
}

test('a PATCH that only changes a Base service is accepted when the Base is known', () => {
  const body = { options: { compose: compose({ web: { command: ['npm', 'start'] } }) } }
  const parsed = parseEnvironmentPatchOptions(body, OVERLAY, PROJECT)
  if (!parsed.ok) throw new TypeError('expected the change to be accepted')
  assertEquals(parsed.options === 'absent', false)
})

test('the same PATCH is held to the stand-alone rule when the Base is not supplied', () => {
  const body = { options: { compose: compose({ web: { command: ['npm', 'start'] } }) } }
  const refused = refusal(parseEnvironmentPatchOptions(body, OVERLAY))
  assertEquals(refused.error, 'compose_invalid')
  assertStringIncludes(refused.issues[0]!.message, 'must define "image" or "build"')
})

test('a PATCH that adds a service with no image is refused and names the service', () => {
  const body = { options: { compose: compose({ worker: { command: ['node', 'w.js'] } }) } }
  const refused = refusal(parseEnvironmentPatchOptions(body, OVERLAY, PROJECT))
  assertEquals(refused.error, 'compose_invalid')
  assertEquals(refused.issues.length, 1)
  assertStringIncludes(
    refused.issues[0]!.message,
    'Service "worker" must define "image" or "build"'
  )
})

test('a PATCH is checked against a Base that has no compose at all', () => {
  const body = { options: { compose: compose({ web: { command: ['x'] } }) } }
  assertEquals(parseEnvironmentPatchOptions(body, OVERLAY, null).ok, false)
  const full = { options: { compose: compose({ web: { image: 'nginx' } }) } }
  assertEquals(parseEnvironmentPatchOptions(full, OVERLAY, null).ok, true)
})

test('a PATCH that does not touch compose is not re-checked against the Base', () => {
  const brokenBase = { compose: compose({ web: { command: ['x'] } }) }
  assertEquals(parseEnvironmentPatchOptions({ options: {} }, OVERLAY, brokenBase).ok, true)
})

test('a create with only changes to a Base service is accepted, one with a new bare service is not', () => {
  const ok = parseCreateEnvironmentJsonb(
    { options: { compose: compose({ web: { command: ['npm', 'start'] } }) } },
    OVERLAY,
    PROJECT
  )
  assertEquals(ok.ok, true)

  const refused = refusal(
    parseCreateEnvironmentJsonb(
      { options: { compose: compose({ worker: { command: ['x'] } }) } },
      OVERLAY,
      PROJECT
    )
  )
  assertEquals(refused.error, 'compose_invalid')
  assertStringIncludes(refused.issues[0]!.message, 'Service "worker"')
})

test('banned keys and unknown fields in the changes are still refused with the Base known', () => {
  const unknown = { options: { compose: compose({ web: { imaage: 'nginx' } }) } }
  assertEquals(parseEnvironmentPatchOptions(unknown, OVERLAY, PROJECT).ok, false)

  const placement = emptyComposeDocument()
  placement.data = {
    services: { web: { command: ['x'] } },
    'x-turbopanel': { placement: { serverId: 'abc' } },
  }
  assertEquals(
    parseEnvironmentPatchOptions({ options: { compose: placement } }, OVERLAY, PROJECT).ok,
    false
  )
})

test('the deploy prepare merge reads changes that only set a field on a Base service', () => {
  const changes = { compose: compose({ web: { command: ['npm', 'start'] } }) }
  const merged = mergeProjectEnvironmentCompose(PROJECT, changes)
  if (merged instanceof Response) throw new TypeError('expected the layers to merge')
  assertEquals(merged.data.services, {
    web: { image: 'nginx:alpine', command: ['npm', 'start'] },
  })
})
