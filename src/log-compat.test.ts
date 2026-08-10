import { assertEquals } from 'jsr:@std/assert'
import { stub } from '@std/testing/mock'
import { compatLogError, compatLogInfo, compatLogWarn } from './log-compat.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('compatLogInfo writes structured lines to stdout in Deno', () => {
  const writes: string[] = []
  const writeStub = stub(Deno.stdout, 'writeSync', (data) => {
    writes.push(new TextDecoder().decode(data))
    return data.byteLength
  })

  try {
    compatLogInfo('test-component', 'hello\nworld\r\n')
    assertEquals(writes.length, 2)
    assertEquals(writes[0]?.includes(' INFO test-component  hello'), true)
    assertEquals(writes[1]?.includes(' INFO test-component  world'), true)
  } finally {
    writeStub.restore()
  }
})

test('compatLogWarn and compatLogError write to stderr', () => {
  const writes: string[] = []
  const writeStub = stub(Deno.stderr, 'writeSync', (data) => {
    writes.push(new TextDecoder().decode(data))
    return data.byteLength
  })

  try {
    compatLogWarn('warn-comp', 'careful')
    compatLogError('err-comp', 'boom')
    assertEquals(writes.length, 2)
    assertEquals(writes[0]?.includes(' WARN warn-comp  careful'), true)
    assertEquals(writes[1]?.includes(' ERROR err-comp  boom'), true)
  } finally {
    writeStub.restore()
  }
})

test('compatLogInfo splits CRLF and bare CR newlines', () => {
  const writes: string[] = []
  const writeStub = stub(Deno.stdout, 'writeSync', (data) => {
    writes.push(new TextDecoder().decode(data))
    return data.byteLength
  })

  try {
    compatLogInfo('nl', 'a\r\nb\rc')
    assertEquals(writes.length, 3)
    assertEquals(writes.map((line) => line.includes('nl')).every(Boolean), true)
  } finally {
    writeStub.restore()
  }
})
