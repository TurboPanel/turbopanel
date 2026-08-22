import { assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import {
  CONTAINER_LOG_RETENTION_DAYS,
  DEFAULT_CONTAINER_LOG_QUERY_LIMIT,
  MAX_CONTAINER_LOG_INGEST_BATCH,
  MAX_CONTAINER_LOG_MESSAGE_BYTES,
  MAX_CONTAINER_LOG_QUERY_LIMIT,
  resolveContainerLogQueryLimit,
  truncateContainerLogMessage,
} from './types.ts'

describe('container log caps', () => {
  it('documents bounded defaults', () => {
    assertEquals(DEFAULT_CONTAINER_LOG_QUERY_LIMIT, 200)
    assertEquals(MAX_CONTAINER_LOG_QUERY_LIMIT, 1000)
    assertEquals(MAX_CONTAINER_LOG_MESSAGE_BYTES, 32 * 1024)
    assertEquals(MAX_CONTAINER_LOG_INGEST_BATCH, 5000)
    assertEquals(CONTAINER_LOG_RETENTION_DAYS, 30)
  })
})

describe('resolveContainerLogQueryLimit', () => {
  it('falls back to the default for missing or nonsense values', () => {
    assertEquals(resolveContainerLogQueryLimit(undefined), DEFAULT_CONTAINER_LOG_QUERY_LIMIT)
    assertEquals(resolveContainerLogQueryLimit(0), DEFAULT_CONTAINER_LOG_QUERY_LIMIT)
    assertEquals(resolveContainerLogQueryLimit(-10), DEFAULT_CONTAINER_LOG_QUERY_LIMIT)
    assertEquals(resolveContainerLogQueryLimit(Number.NaN), DEFAULT_CONTAINER_LOG_QUERY_LIMIT)
  })

  it('floors fractional limits and caps at the maximum', () => {
    assertEquals(resolveContainerLogQueryLimit(50.9), 50)
    assertEquals(resolveContainerLogQueryLimit(10_000), MAX_CONTAINER_LOG_QUERY_LIMIT)
  })
})

describe('truncateContainerLogMessage', () => {
  it('leaves short messages untouched', () => {
    assertEquals(truncateContainerLogMessage('hello'), 'hello')
  })

  it('truncates past the cap', () => {
    const long = 'x'.repeat(MAX_CONTAINER_LOG_MESSAGE_BYTES + 100)
    assertEquals(truncateContainerLogMessage(long).length, MAX_CONTAINER_LOG_MESSAGE_BYTES)
  })

  it('leaves a multibyte message under the byte cap untouched', () => {
    // 3 bytes per code point: stays well under the cap despite the length.
    const message = '\u65e5'.repeat(1000)
    assertEquals(byteLength(message) < MAX_CONTAINER_LOG_MESSAGE_BYTES, true)
    assertEquals(truncateContainerLogMessage(message), message)
  })

  it('caps multibyte messages by bytes, not by string length', () => {
    // 3 bytes each, so the cap lands long before MAX_… code units.
    const message = '\u65e5'.repeat(MAX_CONTAINER_LOG_MESSAGE_BYTES)
    const truncated = truncateContainerLogMessage(message)
    assertEquals(byteLength(truncated) <= MAX_CONTAINER_LOG_MESSAGE_BYTES, true)
    assertEquals(truncated.length < MAX_CONTAINER_LOG_MESSAGE_BYTES, true)
  })

  it('never splits a code point at the cut', () => {
    // A one-byte prefix pushes the 4-byte emoji out of alignment with the cap,
    // so a raw byte cut would land mid-sequence and decode to U+FFFD.
    const message = `-${'\u{1f600}'.repeat(MAX_CONTAINER_LOG_MESSAGE_BYTES)}`
    const truncated = truncateContainerLogMessage(message)
    assertEquals(byteLength(truncated) <= MAX_CONTAINER_LOG_MESSAGE_BYTES, true)
    assertEquals(byteLength(truncated) > MAX_CONTAINER_LOG_MESSAGE_BYTES - 4, true)
    assertEquals(truncated.includes('\ufffd'), false)
    // 1 prefix byte + whole 4-byte code points.
    assertEquals((byteLength(truncated) - 1) % 4, 0)
  })

  it('preserves as much of a mixed ASCII/multibyte line as fits', () => {
    const prefix = 'a'.repeat(MAX_CONTAINER_LOG_MESSAGE_BYTES - 2)
    // Only 2 bytes are left, so the trailing 3-byte code point cannot fit.
    const truncated = truncateContainerLogMessage(`${prefix}\u65e5\u65e5`)
    assertEquals(truncated, prefix)
  })
})

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}
