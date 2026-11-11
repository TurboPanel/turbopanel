import { assertEquals } from '@std/assert'
import {
  isValidReachValue,
  MAX_REACH_FROM,
  parseServiceTurbopanelExtension,
  SERVICE_KIND_FIELD_TABLE,
} from './service-kind.ts'

const test = Deno.test.bind(Deno)

test('reach is a container field and no other kind may carry it', () => {
  assertEquals(SERVICE_KIND_FIELD_TABLE.container.allowedFields.has('reach'), true)
  assertEquals(SERVICE_KIND_FIELD_TABLE.site.allowedFields.has('reach'), false)
  assertEquals(SERVICE_KIND_FIELD_TABLE.node.allowedFields.has('reach'), false)
})

test('a well-formed reach is read; a malformed one is dropped', () => {
  assertEquals(parseServiceTurbopanelExtension({ reach: { port: 7700, from: ['web'] } }), {
    reach: { port: 7700, from: ['web'] },
  })
  assertEquals(parseServiceTurbopanelExtension({ reach: { port: 0, from: ['web'] } }), {})
})

test('reach needs a port, one to eight distinct names and nothing odd', () => {
  assertEquals(isValidReachValue({ port: 1, from: ['a'] }), true)
  assertEquals(
    isValidReachValue({
      port: 65535,
      from: Array.from({ length: MAX_REACH_FROM }, (_, i) => `s${i}`),
    }),
    true
  )
  assertEquals(isValidReachValue({ port: 65536, from: ['a'] }), false)
  assertEquals(isValidReachValue({ port: 1.5, from: ['a'] }), false)
  assertEquals(isValidReachValue({ port: 1, from: [] }), false)
  assertEquals(isValidReachValue({ port: 1, from: ['a', 'a'] }), false)
  assertEquals(isValidReachValue({ port: 1, from: ['a b'] }), false)
  assertEquals(
    isValidReachValue({
      port: 1,
      from: Array.from({ length: MAX_REACH_FROM + 1 }, (_, i) => `s${i}`),
    }),
    false
  )
  assertEquals(isValidReachValue({ port: 1 }), false)
  assertEquals(isValidReachValue('x'), false)
})
