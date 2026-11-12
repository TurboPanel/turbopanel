import { assertEquals } from '@std/assert'
import { DEFAULT_PUBLIC_PORT, INGRESS_MODES, isIngressMode, isPublicPort } from './ingress-modes.ts'

const test = Deno.test.bind(Deno)

test('every listed mode is recognised and unknown values are not', () => {
  for (const mode of INGRESS_MODES) assertEquals(isIngressMode(mode), true)
  assertEquals(isIngressMode('tunnel'), false)
  assertEquals(isIngressMode(undefined), false)
  assertEquals(isIngressMode(8443), false)
})

test('a public port is an integer from 1 to 65535', () => {
  assertEquals(isPublicPort(DEFAULT_PUBLIC_PORT), true)
  assertEquals(isPublicPort(1), true)
  assertEquals(isPublicPort(65535), true)
  assertEquals(isPublicPort(0), false)
  assertEquals(isPublicPort(65536), false)
  assertEquals(isPublicPort(443.5), false)
  assertEquals(isPublicPort('443'), false)
})
