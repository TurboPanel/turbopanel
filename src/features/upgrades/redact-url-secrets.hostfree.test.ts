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

test('redactUrlSecrets drops a password that holds ?, # or @', () => {
  assertEquals(
    redactUrlSecrets('fetch https://user:pa?ss@host.example/repo.git failed'),
    'fetch https://host.example/repo.git failed'
  )
  assertEquals(
    redactUrlSecrets('fetch https://user:pa#ss@host.example/x?y=1 failed'),
    'fetch https://host.example/x?[redacted] failed'
  )
  assertEquals(
    redactUrlSecrets('fetch https://user:p@ss:w?rd@host.example failed'),
    'fetch https://host.example failed'
  )
  assertEquals(redactUrlSecrets('https://user:pa?ss@host.example'), 'https://host.example')
  for (const leak of ['pa', 'ss', 'user:']) {
    assertEquals(redactUrlSecrets('https://user:pa?ss@host.example/a').includes(leak), false, leak)
  }
})

test('redactUrlSecrets keeps an @ that belongs to the path or the query', () => {
  assertEquals(
    redactUrlSecrets('GET https://registry.example/@scope/pkg ok'),
    'GET https://registry.example/@scope/pkg ok'
  )
  assertEquals(
    redactUrlSecrets('GET https://host.example?mail=a@b.test ok'),
    'GET https://host.example?[redacted] ok'
  )
})

// Fixtures are assembled from parts so no scanner mistakes this file for a leak.
const fake = (...parts: string[]) => parts.join('')
const TOKENS = [
  fake('gh', 'p_', 'a1B2'.repeat(9)),
  fake('github', '_pat_', 'A1b2'.repeat(8)),
  fake('xo', 'xb-', '1234567890-'.repeat(2), 'abcdef'),
  fake('sk', '_live_', 'Ab12'.repeat(6)),
  fake('AK', 'IA', 'ABCDEFGHIJKLMNOP'),
  fake('sk', '-ant-', 'abcd1234'.repeat(4)),
  fake(
    'ey',
    'JhbGciOiJIUzI1NiJ9',
    '.',
    'ey',
    'JzdWIiOiIxMjM0NTY3ODkwIn0',
    '.',
    'dBjftJeZ4CVPmB92K27uhbUJU1p1r'
  ),
]

test('redactUrlSecrets drops well-known token shapes outside any URL', () => {
  for (const token of TOKENS) {
    const out = redactUrlSecrets(`git push rejected: ${token} was refused`)
    assertEquals(out, 'git push rejected: [redacted] was refused', token)
  }
})

test('redactUrlSecrets drops a bearer credential and secret-named assignments', () => {
  assertEquals(
    redactUrlSecrets('401 for Authorization: Bearer abcdEFGH1234567890xyz.-_'),
    '401 for Authorization: Bearer [redacted]'
  )
  assertEquals(
    redactUrlSecrets('env GITHUB_TOKEN=abc123xyz DB_PASSWORD="hun ter2" api_key=k1'),
    'env GITHUB_TOKEN=[redacted] DB_PASSWORD="[redacted]" api_key=k1'
  )
  assertEquals(
    redactUrlSecrets('{"password": "hunter2", "client_secret":"s3cr3t-value"}'),
    '{"password": "[redacted]", "client_secret":"[redacted]"}'
  )
  assertEquals(
    redactUrlSecrets("x-api-key: 'abc'; token: abcdefghijklmnop1234"),
    "x-api-key: '[redacted]'; token: [redacted]"
  )
})

test('redactUrlSecrets keeps ordinary error prose and is idempotent', () => {
  for (const text of [
    'invalid token: expired',
    'password authentication failed for user "app"',
    'Basic authentication is required',
    'Bearer authentication is required here',
    'the tokenizer=fast mode is off',
    'secrets/decrypt returned unexpected length',
    'task-force-alpha-with-a-very-long-dashed-name',
    'sha256:0123456789abcdef0123456789abcdef',
  ]) {
    assertEquals(redactUrlSecrets(text), text)
  }
  const once = redactUrlSecrets(`${TOKENS[0]} password=hunter2 https://u:p?w@h.test/a?b=c`)
  assertEquals(redactUrlSecrets(once), once)
})

test('redactUrlSecrets stays fast on hostile input', () => {
  const started = performance.now()
  redactUrlSecrets(`${'token'.repeat(20_000)}=`)
  redactUrlSecrets(`${'a.'.repeat(30_000)}`)
  redactUrlSecrets(`https://${'u:'.repeat(30_000)}?`)
  redactUrlSecrets(`Bearer ${'a'.repeat(100_000)}`)
  redactUrlSecrets(`eyJ${'a'.repeat(50_000)}.${'b'.repeat(50_000)}`)
  assertEquals(performance.now() - started < 2000, true)
})
