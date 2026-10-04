import { assertEquals, assertStringIncludes } from '@std/assert'
import { redactUrlSecrets } from './redact-url-secrets.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SIGNED =
  'https://release-assets.githubusercontent.com/github-production-release-asset/1/abc?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeef0123&token=s3cr3t'

test('redactUrlSecrets keeps host and path and drops the signed query', () => {
  const out = redactUrlSecrets(
    `curl: (6) Could not resolve host while fetching ${SIGNED} (retrying)`
  )
  assertEquals(
    out,
    'curl: (6) Could not resolve host while fetching https://release-assets.githubusercontent.com/github-production-release-asset/1/abc?[redacted] (retrying)'
  )
  for (const secret of ['X-Amz-Signature', 'deadbeef0123', 'token=', 's3cr3t']) {
    assertEquals(out.includes(secret), false)
  }
})

test('redactUrlSecrets handles fragments, userinfo, several URLs and plain text', () => {
  assertEquals(redactUrlSecrets('disk full'), 'disk full')
  assertEquals(
    redactUrlSecrets('https://u:p@example.com/a#frag and "http://x.test/b?k=v"'),
    'https://example.com/a?[redacted] and "http://x.test/b?[redacted]"'
  )
  assertStringIncludes(
    redactUrlSecrets('see https://example.com/plain.'),
    'https://example.com/plain.'
  )
})
