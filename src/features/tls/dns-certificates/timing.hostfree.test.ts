/** The fallback renewal time and its spread. */
import { assertEquals } from '@std/assert'
import { fallbackRenewAt, jitteredFallbackRenewAt } from './timing.ts'

const test = Deno.test.bind(Deno)

const notBefore = new Date('2026-01-01T00:00:00Z')
const notAfter = new Date('2026-04-01T00:00:00Z')
const lifetime = notAfter.getTime() - notBefore.getTime()

test('the fallback is a third of the lifetime before the end, spread up to a tenth earlier', () => {
  const third = fallbackRenewAt(notBefore, notAfter).getTime()
  assertEquals(third, notAfter.getTime() - lifetime / 3)
  assertEquals(jitteredFallbackRenewAt(notBefore, notAfter, () => 0).getTime(), third)
  assertEquals(
    jitteredFallbackRenewAt(notBefore, notAfter, () => 1).getTime(),
    third - lifetime / 10
  )
  const middle = jitteredFallbackRenewAt(notBefore, notAfter, () => 0.5).getTime()
  assertEquals(middle, third - lifetime / 20)
})
