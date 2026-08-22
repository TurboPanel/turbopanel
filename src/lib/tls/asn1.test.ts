import { assertEquals, assertThrows } from '@std/assert'
import {
  Asn1Error,
  children,
  content,
  expectTag,
  readInteger,
  readNode,
  readOid,
  readTime,
  readUtf8OrPrintable,
} from './asn1.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('readNode parses a short-form INTEGER', () => {
  // INTEGER 42 → 02 01 2a
  const bytes = Uint8Array.of(0x02, 0x01, 0x2a)
  const node = readNode(bytes)
  assertEquals(node.tag, 0x02)
  assertEquals(node.headerLength, 2)
  assertEquals(node.contentOffset, 2)
  assertEquals(node.contentLength, 1)
  assertEquals(node.end, 3)
  assertEquals([...content(node)], [0x2a])
})

test('readNode parses a long-form length', () => {
  // OCTET STRING of 256 zero bytes: 04 82 01 00 <256 bytes>
  const contentBytes = new Uint8Array(256)
  const bytes = new Uint8Array(4 + contentBytes.length)
  bytes[0] = 0x04
  bytes[1] = 0x82
  bytes[2] = 0x01
  bytes[3] = 0x00
  bytes.set(contentBytes, 4)

  const node = readNode(bytes)
  assertEquals(node.tag, 0x04)
  assertEquals(node.headerLength, 4)
  assertEquals(node.contentLength, 256)
  assertEquals(node.end, bytes.length)
  assertEquals(content(node).length, 256)
})

test('readNode rejects truncated and unsupported lengths', () => {
  assertThrows(() => readNode(Uint8Array.of()), Asn1Error, 'unexpected end')
  assertThrows(() => readNode(Uint8Array.of(0x02)), Asn1Error, 'missing length')
  assertThrows(
    () => readNode(Uint8Array.of(0x02, 0x80)),
    Asn1Error,
    'unsupported DER length',
  )
  assertThrows(
    () => readNode(Uint8Array.of(0x02, 0x85, 0x01, 0x02, 0x03, 0x04, 0x05)),
    Asn1Error,
    'unsupported DER length',
  )
  assertThrows(
    () => readNode(Uint8Array.of(0x02, 0x82, 0x01)),
    Asn1Error,
    'truncated length',
  )
  assertThrows(
    () => readNode(Uint8Array.of(0x02, 0x02, 0x01)),
    Asn1Error,
    'truncated content',
  )
})

test('children returns nested nodes for constructed SEQUENCE', () => {
  // SEQUENCE { INTEGER 1, INTEGER 2 } → 30 06 02 01 01 02 01 02
  const bytes = Uint8Array.of(
    0x30,
    0x06,
    0x02,
    0x01,
    0x01,
    0x02,
    0x01,
    0x02,
  )
  const seq = readNode(bytes)
  const kids = children(seq)
  assertEquals(kids.length, 2)
  assertEquals([...content(kids[0]!)], [0x01])
  assertEquals([...content(kids[1]!)], [0x02])
})

test('children returns empty for primitive tags', () => {
  const node = readNode(Uint8Array.of(0x02, 0x01, 0x01))
  assertEquals(children(node), [])
})

test('expectTag throws when the tag does not match', () => {
  const node = readNode(Uint8Array.of(0x02, 0x01, 0x01))
  assertThrows(
    () => expectTag(node, 0x06, 'OBJECT IDENTIFIER'),
    Asn1Error,
    'expected OBJECT IDENTIFIER',
  )
})

test('readInteger strips a leading zero byte', () => {
  // INTEGER with leading 0x00 (positive encoding) → 02 02 00 ff
  const node = readNode(Uint8Array.of(0x02, 0x02, 0x00, 0xff))
  assertEquals([...readInteger(node)], [0xff])
})

test('readInteger keeps a single zero byte', () => {
  const node = readNode(Uint8Array.of(0x02, 0x01, 0x00))
  assertEquals([...readInteger(node)], [0x00])
})

test('readOid decodes short and multi-byte OID arcs', () => {
  // 1.2.840 → 06 03 2a 86 48
  const oid = readOid(readNode(Uint8Array.of(0x06, 0x03, 0x2a, 0x86, 0x48)))
  assertEquals(oid, '1.2.840')

  // 2.5.4.3 (commonName) → 06 03 55 04 03
  assertEquals(
    readOid(readNode(Uint8Array.of(0x06, 0x03, 0x55, 0x04, 0x03))),
    '2.5.4.3',
  )
})

test('readOid rejects an empty OID body', () => {
  assertThrows(
    () => readOid(readNode(Uint8Array.of(0x06, 0x00))),
    Asn1Error,
    'empty OID',
  )
})

test('readUtf8OrPrintable decodes content bytes as UTF-8', () => {
  const text = 'CN'
  const encoded = new TextEncoder().encode(text)
  const bytes = new Uint8Array(2 + encoded.length)
  bytes[0] = 0x0c // UTF8String
  bytes[1] = encoded.length
  bytes.set(encoded, 2)
  assertEquals(readUtf8OrPrintable(readNode(bytes)), text)
})

test('readTime parses UTCTime with century windowing', () => {
  // UTCTime 500101000000Z → 1950-01-01
  const utc1950 = new TextEncoder().encode('500101000000Z')
  const bytes1950 = new Uint8Array(2 + utc1950.length)
  bytes1950[0] = 0x17
  bytes1950[1] = utc1950.length
  bytes1950.set(utc1950, 2)
  assertEquals(
    readTime(readNode(bytes1950)).toISOString(),
    '1950-01-01T00:00:00.000Z',
  )

  // UTCTime 250101120000Z → 2025-01-01
  const utc2025 = new TextEncoder().encode('250101120000Z')
  const bytes2025 = new Uint8Array(2 + utc2025.length)
  bytes2025[0] = 0x17
  bytes2025[1] = utc2025.length
  bytes2025.set(utc2025, 2)
  assertEquals(
    readTime(readNode(bytes2025)).toISOString(),
    '2025-01-01T12:00:00.000Z',
  )
})

test('readTime parses GeneralizedTime and rejects bad tags', () => {
  const raw = new TextEncoder().encode('20260115123045Z')
  const bytes = new Uint8Array(2 + raw.length)
  bytes[0] = 0x18
  bytes[1] = raw.length
  bytes.set(raw, 2)
  assertEquals(
    readTime(readNode(bytes)).toISOString(),
    '2026-01-15T12:30:45.000Z',
  )

  assertThrows(
    () => readTime(readNode(Uint8Array.of(0x02, 0x01, 0x01))),
    Asn1Error,
    'expected time tag',
  )
  assertThrows(
    () => {
      const bad = new TextEncoder().encode('not-a-timeZ')
      const buf = new Uint8Array(2 + bad.length)
      buf[0] = 0x17
      buf[1] = bad.length
      buf.set(bad, 2)
      readTime(readNode(buf))
    },
    Asn1Error,
    'invalid UTCTime',
  )
})
