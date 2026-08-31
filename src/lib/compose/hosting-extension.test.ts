import { assertEquals } from '@std/assert'
import {
  collectHostingExtensionValidationIssues,
  DEFAULT_HOSTING_TLS_MODE,
  HOSTING_TARGET_PORT_NOT_FOR_NODE_MESSAGE,
  HOSTING_TARGET_PORT_NOT_FOR_SITE_MESSAGE,
  HOSTING_TLS_MODE_AUTOMATIC_UNSUPPORTED_MESSAGE,
  hostingTargetPortAuthorable,
  hostingTlsModeOf,
  parseHostingExtensionEntries,
} from './hosting-extension.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const BASE = 'services.web.x-turbopanel'

function issuesFor(
  entry: Record<string, unknown>,
  serviceKind?: 'container' | 'site' | 'node',
): { path: string; message: string }[] {
  return collectHostingExtensionValidationIssues(BASE, [entry], serviceKind)
}

test('an omitted tls block means internal, the mode the deploy can perform', () => {
  assertEquals(DEFAULT_HOSTING_TLS_MODE, 'internal')
  assertEquals(hostingTlsModeOf({ hostname: 'app.example.com' }), 'internal')
})

test('tls.mode automatic is refused rather than deployed as internal', () => {
  assertEquals(
    issuesFor({
      hostname: 'app.example.com',
      tls: { mode: 'automatic' },
    }),
    [{
      path: `${BASE}.hosting[0].tls.mode`,
      message: HOSTING_TLS_MODE_AUTOMATIC_UNSUPPORTED_MESSAGE,
    }],
  )
})

test('tls.mode automatic still parses, so deploy-prepare can refuse it too', () => {
  const entries = parseHostingExtensionEntries([
    { hostname: 'app.example.com', tls: { mode: 'automatic' } },
  ])
  assertEquals(entries?.[0].tls?.mode, 'automatic')
  assertEquals(hostingTlsModeOf(entries![0]), 'automatic')
})

test('internal and certificate are accepted', () => {
  assertEquals(issuesFor({ hostname: 'a.example.com', tls: { mode: 'internal' } }), [])
  assertEquals(
    issuesFor({
      hostname: 'a.example.com',
      tls: { mode: 'certificate', certificateRef: 'wildcard' },
    }),
    [],
  )
})

test('targetPort is authorable on a container and nowhere else', () => {
  assertEquals(hostingTargetPortAuthorable('container'), true)
  assertEquals(hostingTargetPortAuthorable(undefined), true)
  assertEquals(hostingTargetPortAuthorable('site'), false)
  assertEquals(hostingTargetPortAuthorable('node'), false)
})

test('targetPort on a node service is refused, not ignored', () => {
  assertEquals(
    issuesFor({ hostname: 'app.example.com', targetPort: 3000 }, 'node'),
    [{
      path: `${BASE}.hosting[0].targetPort`,
      message: HOSTING_TARGET_PORT_NOT_FOR_NODE_MESSAGE,
    }],
  )
})

test('targetPort on a site service keeps its own message', () => {
  assertEquals(
    issuesFor({ hostname: 'app.example.com', targetPort: 8080 }, 'site'),
    [{
      path: `${BASE}.hosting[0].targetPort`,
      message: HOSTING_TARGET_PORT_NOT_FOR_SITE_MESSAGE,
    }],
  )
})

test('targetPort on a container is accepted when it is a real port', () => {
  assertEquals(
    issuesFor({ hostname: 'app.example.com', targetPort: 8080 }, 'container'),
    [],
  )
})
