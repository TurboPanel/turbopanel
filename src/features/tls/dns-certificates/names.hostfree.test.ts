import { assertEquals } from '@std/assert'
import { parseCertificateNames } from './names.ts'

/** Jest/Mocha-shaped alias so Sonar sees real tests (typescript:S2187). */
const test = Deno.test.bind(Deno)

test('names are lowercased, trimmed and not repeated; a wildcard keeps its star', () => {
  assertEquals(parseCertificateNames([' Example.COM ', 'example.com.', '*.Example.com']), {
    ok: true,
    names: ['example.com', '*.example.com'],
  })
})

test('a star anywhere but the front, an address, a private name and a single label are refused', () => {
  for (const bad of [
    'a.*.example.com',
    '*example.com',
    '**.example.com',
    '10.0.0.1',
    'localhost',
    'x.internal.',
    'onelabel',
    '',
    'a b.example.com',
    'bad_name.example.com',
  ]) {
    assertEquals(parseCertificateNames([bad]).ok, false, bad)
  }
})

test('the number of names is bounded and every entry must be text', () => {
  assertEquals(parseCertificateNames([]).ok, false)
  assertEquals(
    parseCertificateNames(Array.from({ length: 11 }, (_, i) => `n${i}.example.com`)).ok,
    false
  )
  assertEquals(parseCertificateNames(['a.example.com', 5]).ok, false)
  assertEquals(parseCertificateNames('example.com').ok, false)
})
