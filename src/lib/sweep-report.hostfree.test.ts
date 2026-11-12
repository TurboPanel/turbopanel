/** The sweep summary line and its failure-rate alert. */
import { assertEquals } from '@std/assert'
import { reportSweep } from './sweep-report.ts'

const test = Deno.test.bind(Deno)

function capture(run: () => void): string[] {
  const lines: string[] = []
  const out = Deno.stdout.writeSync
  const err = Deno.stderr.writeSync
  const take = (bytes: Uint8Array) => {
    lines.push(new TextDecoder().decode(bytes))
    return bytes.length
  }
  Deno.stdout.writeSync = take
  Deno.stderr.writeSync = take
  try {
    run()
  } finally {
    Deno.stdout.writeSync = out
    Deno.stderr.writeSync = err
  }
  return lines
}

test('an idle tick logs nothing; a busy one logs a line; mostly failing raises the alert', () => {
  assertEquals(
    capture(() => reportSweep('tls', 'x sweep', { a: 0 }, { tried: 0, failed: 0 })),
    []
  )
  assertEquals(
    capture(() => reportSweep('tls', 'x sweep', { a: 5 }, { tried: 5, failed: 1 })).length,
    1
  )
  const alert = capture(() => reportSweep('tls', 'x sweep', { a: 5 }, { tried: 5, failed: 3 }))
  assertEquals(alert.length, 2)
  assertEquals(alert[1]!.includes('alert'), true)
})
