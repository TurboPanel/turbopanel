import { assertEquals, assertStringIncludes } from '@std/assert'

import {
  buildAdminScalarHtml,
  buildClientScalarHtml,
  buildDaemonScalarHtml,
} from './scalar-html.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('buildClientScalarHtml embeds cookie auth and the OpenAPI URL', () => {
  const html = buildClientScalarHtml(
    'https://panel.example.com/api/client/v1/openapi.json',
    'https://panel.example.com',
  )
  assertStringIncludes(html, 'data-url="https://panel.example.com/api/client/v1/openapi.json"')
  assertStringIncludes(html, 'cookieAuth')
  assertStringIncludes(html, 'TurboPanel API Reference')
  assertStringIncludes(html, '@scalar/api-reference')
  assertEquals(html.includes('bearerAuth'), false)
})

test('buildDaemonScalarHtml embeds bearer auth only', () => {
  const html = buildDaemonScalarHtml(
    'https://panel.example.com/api/daemon/v1/openapi.json',
  )
  assertStringIncludes(html, 'data-url="https://panel.example.com/api/daemon/v1/openapi.json"')
  assertStringIncludes(html, 'bearerAuth')
  assertStringIncludes(html, 'TurboPanel Daemon API Reference')
  assertEquals(html.includes('cookieAuth'), false)
})

test('buildAdminScalarHtml embeds cookie auth for admin reference', () => {
  const html = buildAdminScalarHtml(
    'https://panel.example.com/api/admin/v1/openapi.json',
    'https://panel.example.com',
  )
  assertStringIncludes(html, 'data-url="https://panel.example.com/api/admin/v1/openapi.json"')
  assertStringIncludes(html, 'cookieAuth')
  assertStringIncludes(html, 'TurboPanel Admin API Reference')
})

test('HTTPS origins resolve the __Host- session cookie name', () => {
  const html = buildClientScalarHtml(
    'https://panel.example.com/api/client/v1/openapi.json',
    'https://panel.example.com',
  )
  assertStringIncludes(html, '__Host-turbopanel.session_token')
})
