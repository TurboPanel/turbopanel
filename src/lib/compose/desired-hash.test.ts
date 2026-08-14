import { assertEquals } from '@std/assert'
import { SHA256_HEX_RE, sha256HexUtf8 } from './desired-hash.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('sha256HexUtf8 empty string is known digest', async () => {
  const digest = await sha256HexUtf8('')
  assertEquals(
    digest,
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  )
  assertEquals(SHA256_HEX_RE.test(digest), true)
})

test('sha256HexUtf8 hashes UTF-8 content', async () => {
  const digest = await sha256HexUtf8('hello')
  assertEquals(
    digest,
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  )
})

test('sha256HexUtf8 is stable for multiline compose bodies', async () => {
  const yaml = `services:
  web:
    image: nginx:alpine
`
  const first = await sha256HexUtf8(yaml)
  const second = await sha256HexUtf8(yaml)
  assertEquals(first, second)
  assertEquals(SHA256_HEX_RE.test(first), true)
})

test('SHA256_HEX_RE rejects uppercase and short digests', () => {
  assertEquals(
    SHA256_HEX_RE.test(
      'E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855',
    ),
    false,
  )
  assertEquals(SHA256_HEX_RE.test('abc123'), false)
})
